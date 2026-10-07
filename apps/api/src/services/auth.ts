import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { normalizeDominicanPhone } from '@jellyfish/shared';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { addresses, otpCodes, users, type UserRole } from '../db/schema';
import { invalid, tooMany } from '../errors';

/** Canal de envío del código (SMS o WhatsApp). La implementación real se conecta en despliegue. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

/** Solo desarrollo: imprime el código en consola. Nunca usar en producción. */
export class ConsoleOtpSender implements OtpSender {
  async send(phone: string, code: string): Promise<void> {
    console.log(`[JELLYFISH · SOLO DESARROLLO] Código para ${phone}: ${code}`);
  }
}

/** Pruebas: guarda los códigos enviados. */
export class MemoryOtpSender implements OtpSender {
  readonly sent: { phone: string; code: string }[] = [];
  async send(phone: string, code: string): Promise<void> {
    this.sent.push({ phone, code });
  }
  last(phone: string): string | undefined {
    return [...this.sent].reverse().find((s) => s.phone === phone)?.code;
  }
}

export interface AuthContext {
  db: Db;
  config: Config;
  sender: OtpSender;
  now?: () => Date;
}

const OTP_TTL_MS = 10 * 60_000;
const MAX_CODES_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;

const nowOf = (ctx: AuthContext) => (ctx.now ?? (() => new Date()))();

function hashCode(ctx: AuthContext, phone: string, code: string): string {
  return createHash('sha256').update(`${ctx.config.otpPepper}:${phone}:${code}`).digest('hex');
}

export function requirePhone(raw: string): string {
  const phone = normalizeDominicanPhone(raw);
  if (!phone) throw invalid('Ingresa un número dominicano válido (809, 829 o 849)');
  return phone;
}

export async function requestOtp(ctx: AuthContext, rawPhone: string) {
  const phone = requirePhone(rawPhone);
  const now = nowOf(ctx);

  const [{ n } = { n: 0 }] = await ctx.db
    .select({ n: count() })
    .from(otpCodes)
    .where(
      and(eq(otpCodes.phone, phone), gt(otpCodes.createdAt, new Date(now.getTime() - OTP_TTL_MS))),
    );
  if (n >= MAX_CODES_PER_WINDOW) {
    throw tooMany('Pediste demasiados códigos. Intenta de nuevo en unos minutos.');
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await ctx.db.insert(otpCodes).values({
    phone,
    codeHash: hashCode(ctx, phone, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    createdAt: now,
  });
  await ctx.sender.send(phone, code);
  return { phone, expiresInSeconds: OTP_TTL_MS / 1000 };
}

export async function verifyOtp(ctx: AuthContext, rawPhone: string, code: string) {
  const phone = requirePhone(rawPhone);
  const now = nowOf(ctx);
  const generic = () => invalid('Código incorrecto o vencido');

  const [otp] = await ctx.db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, now)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!otp) throw generic();
  if (otp.attempts >= MAX_ATTEMPTS) throw tooMany('Demasiados intentos. Pide un código nuevo.');

  // Cuenta el intento antes de comparar: un fallo no se puede "reintentar gratis".
  await ctx.db
    .update(otpCodes)
    .set({ attempts: sql`${otpCodes.attempts} + 1` })
    .where(eq(otpCodes.id, otp.id));

  const expected = Buffer.from(otp.codeHash, 'hex');
  const actual = Buffer.from(hashCode(ctx, phone, code.trim()), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw generic();

  // Consumir de forma atómica: un código solo sirve una vez aunque lleguen dos solicitudes.
  const consumed = await ctx.db
    .update(otpCodes)
    .set({ consumedAt: now })
    .where(and(eq(otpCodes.id, otp.id), isNull(otpCodes.consumedAt)))
    .returning({ id: otpCodes.id });
  if (consumed.length === 0) throw generic();

  const user = await upsertUser(ctx, phone);
  return user;
}

async function upsertUser(ctx: AuthContext, phone: string) {
  const [existing] = await ctx.db.select().from(users).where(eq(users.phone, phone));
  if (existing) return existing;

  let role: UserRole = 'customer';
  if (
    ctx.config.bootstrapAdminPhone &&
    normalizeDominicanPhone(ctx.config.bootstrapAdminPhone) === phone
  ) {
    const [{ n } = { n: 0 }] = await ctx.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.role, 'admin'));
    if (n === 0) role = 'admin';
  }
  const [created] = await ctx.db
    .insert(users)
    .values({ phone, role })
    .onConflictDoNothing({ target: users.phone })
    .returning();
  if (created) return created;
  const [again] = await ctx.db.select().from(users).where(eq(users.phone, phone));
  return again!;
}

/**
 * Eliminación de cuenta (requisito de Apple y de la Ley 172-13 sobre datos personales).
 * Se anonimiza el perfil y se borran direcciones y token de notificaciones. Los pedidos se
 * conservan por obligación fiscal/contable, sin vínculo con datos de contacto del perfil.
 */
export async function deleteAccount(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(addresses).where(eq(addresses.userId, userId));
    await tx
      .update(users)
      .set({
        phone: `deleted:${userId}`,
        name: '',
        email: null,
        pushToken: null,
        deletedAt: new Date(),
      })
      .where(eq(users.id, userId));
  });
}

/**
 * El administrador da de alta a una persona del equipo (repartidor, personal, otro admin) por su
 * celular. Si ya tenía cuenta, solo cambia su rol. Entra después con su código OTP de siempre.
 */
export async function inviteUser(db: Db, input: { phone: string; name?: string; role: UserRole }) {
  const phone = requirePhone(input.phone);
  const [existing] = await db.select().from(users).where(eq(users.phone, phone));
  if (existing) {
    const [row] = await db
      .update(users)
      .set({ role: input.role, ...(input.name ? { name: input.name } : {}) })
      .where(eq(users.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await db
    .insert(users)
    .values({ phone, name: input.name ?? '', role: input.role })
    .returning();
  return row!;
}
