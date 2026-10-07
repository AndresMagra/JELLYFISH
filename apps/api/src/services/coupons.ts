import {
  type CouponDTO,
  type CouponRedemptionDTO,
  type CouponStatus,
  type OrderStatus,
  formatDOP,
} from '@jellyfish/shared';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type CouponKind, couponRedemptions, coupons, orders, users } from '../db/schema';
import { DomainError, conflict, invalid, notFound } from '../errors';
import { formatOrderNumber } from '../text';

export type CouponRow = typeof coupons.$inferSelect;

// ───────────────────────── código ─────────────────────────

export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

/**
 * Lo que el cliente teclea en el celular casi nunca viene limpio: espacios (incluso invisibles),
 * minúsculas, guiones largos del teclado. El código guardado siempre está en mayúsculas y sin espacios.
 */
export function normalizeCouponCode(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      // espacios normales, no separables y de ancho cero (U+200B a U+200D, U+2060, U+FEFF)
      .replace(/[\s\u200B-\u200D\u2060\uFEFF]+/gu, '')
      // guiones largos y signo menos (U+2010 a U+2015, U+2212) que el teclado mete por un guion
      .replace(/[\u2010-\u2015\u2212]/gu, '-')
      .toUpperCase()
  );
}

// ───────────────────────── cálculo (puro) ─────────────────────────

/**
 * Descuento sobre los PRODUCTOS (centavos, ITBIS incluido). Los porcentajes redondean hacia abajo:
 * el redondeo nunca favorece al cliente. Nunca supera el subtotal ni el tope del cupón.
 * El envío gratis no descuenta productos: se resuelve aparte (ver `assessCoupon`).
 */
export function couponDiscount(
  coupon: Pick<CouponRow, 'kind' | 'value' | 'maxDiscount'>,
  subtotal: number,
): number {
  if (coupon.kind === 'free_delivery' || subtotal <= 0) return 0;
  let discount =
    coupon.kind === 'percent' ? Math.floor((subtotal * coupon.value) / 10_000) : coupon.value;
  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  return Math.max(0, Math.min(discount, subtotal));
}

/** Texto que ve el cliente cuando el administrador no escribió una descripción propia. */
export function describeCoupon(
  coupon: Pick<CouponRow, 'kind' | 'value' | 'description' | 'maxDiscount'>,
): string {
  if (coupon.description.trim()) return coupon.description.trim();
  if (coupon.kind === 'free_delivery') return 'Envío gratis';
  if (coupon.kind === 'fixed') return `${formatDOP(coupon.value)} de descuento`;
  const base = `${coupon.value / 100} % de descuento`;
  return coupon.maxDiscount !== null ? `${base} (hasta ${formatDOP(coupon.maxDiscount)})` : base;
}

export type CouponRejection =
  | 'login_required'
  | 'blocked'
  | 'not_found'
  | 'not_started'
  | 'expired'
  | 'exhausted'
  | 'user_limit'
  | 'below_minimum'
  | 'no_benefit'
  | 'covers_all';

export type CouponRejected = {
  ok: false;
  reason: CouponRejection;
  message: string;
  /** Solo con `blocked`: cuánto falta para que se libere el límite. */
  retryAfterMs?: number;
};

export type CouponAssessment =
  | {
      ok: true;
      coupon: CouponRow;
      /** Descuento sobre los productos (centavos). */
      discount: number;
      /** Envío que el cupón perdona (centavos); 0 si aún no se conoce la zona. */
      deliveryWaived: number;
    }
  | CouponRejected;

export interface CouponUsage {
  /** Redenciones vigentes del cupón (las de pedidos cancelados ya no existen). */
  total: number;
  /** Las de esta persona. */
  byUser: number;
}

const rejected = (
  reason: CouponRejection,
  message: string,
  extra: { retryAfterMs?: number } = {},
): CouponRejected => ({ ok: false, reason, message, ...extra });

const longDate = (d: Date) =>
  d.toLocaleDateString('es-DO', {
    day: 'numeric',
    month: 'long',
    timeZone: 'America/Santo_Domingo',
  });

/**
 * Decide si el cupón sirve para este carrito. Sin acceso a la base: recibe los conteos de uso.
 * El orden de las reglas va de lo que NO se puede arreglar a lo que sí (agregar productos), para
 * no pedirle al cliente que compre más por un cupón que igual no podría usar.
 */
export function assessCoupon(
  coupon: CouponRow,
  cart: { subtotal: number; deliveryFee: number | null },
  usage: CouponUsage,
  now: Date,
): CouponAssessment {
  if (!coupon.active) return rejected('not_found', NOT_FOUND_MESSAGE);
  if (coupon.startsAt && coupon.startsAt > now) {
    return rejected(
      'not_started',
      `Este cupón estará disponible desde el ${longDate(coupon.startsAt)}`,
    );
  }
  // `endsAt` es exclusivo: en ese instante el cupón ya venció.
  if (coupon.endsAt && coupon.endsAt <= now) return rejected('expired', 'Este cupón venció');
  if (coupon.maxRedemptions !== null && usage.total >= coupon.maxRedemptions) {
    return rejected('exhausted', 'Este cupón ya se agotó');
  }
  if (usage.byUser >= coupon.perUserLimit) {
    return rejected(
      'user_limit',
      coupon.perUserLimit === 1
        ? 'Ya usaste este cupón'
        : `Ya usaste este cupón el máximo de veces (${coupon.perUserLimit})`,
    );
  }
  if (cart.subtotal < coupon.minSubtotal) {
    return rejected(
      'below_minimum',
      `Necesitas ${formatDOP(coupon.minSubtotal - cart.subtotal)} más para usarlo`,
    );
  }

  if (coupon.kind === 'free_delivery') {
    // Zona desconocida (aún no hay dirección): se acepta y se aplica cuando se conozca.
    if (cart.deliveryFee === 0) {
      return rejected('no_benefit', 'Tu envío ya es gratis, no necesitas este cupón');
    }
    return { ok: true, coupon, discount: 0, deliveryWaived: cart.deliveryFee ?? 0 };
  }

  const discount = couponDiscount(coupon, cart.subtotal);
  if (discount <= 0) return rejected('no_benefit', 'Este cupón no aplica a este pedido');
  return { ok: true, coupon, discount, deliveryWaived: 0 };
}

const NOT_FOUND_MESSAGE = 'No encontramos ese cupón. Revisa que esté bien escrito';

// ───────────────────────── anti-abuso ─────────────────────────

/**
 * Frena a quien prueba códigos al azar: máximo `max` cupones DISTINTOS que no existen por persona
 * y por ventana (10 por hora). Solo cuentan los códigos inexistentes (o desactivados, que para la
 * persona son lo mismo): un cupón vencido o que pide más compra no es un intento de adivinar, y
 * cotizar de nuevo el mismo código inválido no gasta intentos.
 *
 * Vive en la memoria del proceso: se reinicia con el API y, con varias instancias, el límite real
 * es por instancia. Es suficiente para frenar el abuso casual; no es un control de seguridad duro.
 */
export class CouponAttemptLimiter {
  readonly max: number;
  readonly windowMs: number;
  private readonly misses = new Map<string, Map<string, number>>();

  constructor(options: { max?: number; windowMs?: number } = {}) {
    this.max = options.max ?? 10;
    this.windowMs = options.windowMs ?? 60 * 60_000;
  }

  /** `retryAfterMs` > 0 significa bloqueado. */
  check(userId: string, now: Date): { blocked: boolean; retryAfterMs: number } {
    const live = this.prune(userId, now.getTime());
    if (!live || live.size < this.max) return { blocked: false, retryAfterMs: 0 };
    const oldest = Math.min(...live.values());
    return { blocked: true, retryAfterMs: Math.max(1, oldest + this.windowMs - now.getTime()) };
  }

  recordMiss(userId: string, code: string, now: Date): void {
    const live = this.prune(userId, now.getTime()) ?? new Map<string, number>();
    // Repetir el mismo código no acerca al bloqueo, pero sí renueva su vigencia.
    live.set(code, now.getTime());
    this.misses.set(userId, live);
    if (this.misses.size > 5_000) this.sweep(now.getTime());
  }

  private prune(userId: string, nowMs: number): Map<string, number> | undefined {
    const live = this.misses.get(userId);
    if (!live) return undefined;
    for (const [code, at] of live) if (at + this.windowMs <= nowMs) live.delete(code);
    if (live.size === 0) {
      this.misses.delete(userId);
      return undefined;
    }
    return live;
  }

  private sweep(nowMs: number): void {
    for (const userId of [...this.misses.keys()]) this.prune(userId, nowMs);
  }
}

// ───────────────────────── evaluación con base de datos ─────────────────────────

export async function findCouponByCode(
  db: Db,
  code: string,
  options: { lock?: boolean } = {},
): Promise<CouponRow | null> {
  const query = db.select().from(coupons).where(eq(coupons.code, code));
  const [row] = await (options.lock ? query.for('update') : query);
  return row ?? null;
}

async function usageOf(db: Db, couponId: string, userId: string): Promise<CouponUsage> {
  const [row] = await db
    .select({
      total: count(),
      byUser: sql<number>`count(*) filter (where ${couponRedemptions.userId} = ${userId})`.mapWith(
        Number,
      ),
    })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponId, couponId));
  return { total: row?.total ?? 0, byUser: row?.byUser ?? 0 };
}

export interface EvaluateCouponInput {
  /** Tal como lo escribió la persona (se normaliza aquí). */
  rawCode: string;
  userId: string | null;
  /** Subtotal de productos ANTES del descuento (centavos). */
  subtotal: number;
  /** Envío que cobraría la zona; null si todavía no hay dirección. */
  deliveryFee: number | null;
  now: Date;
  /**
   * `true` al crear el pedido: bloquea la fila del cupón (FOR UPDATE) hasta que termine la
   * transacción. Así dos pedidos simultáneos hacen cola y el segundo ve el uso del primero:
   * no se pueden pasar de `maxRedemptions` ni de `perUserLimit`.
   */
  lock?: boolean;
  limiter?: CouponAttemptLimiter;
}

export async function evaluateCoupon(
  db: Db,
  input: EvaluateCouponInput,
): Promise<CouponAssessment> {
  const { userId, now, limiter } = input;
  if (!userId) return rejected('login_required', 'Inicia sesión para usar un cupón');

  const gate = limiter?.check(userId, now);
  if (gate?.blocked) {
    const minutes = Math.ceil(gate.retryAfterMs / 60_000);
    return rejected(
      'blocked',
      `Probaste demasiados cupones que no existen. Intenta de nuevo en ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`,
      { retryAfterMs: gate.retryAfterMs },
    );
  }

  const code = normalizeCouponCode(input.rawCode);
  const coupon = COUPON_CODE_PATTERN.test(code)
    ? await findCouponByCode(db, code, { lock: input.lock })
    : null;
  if (!coupon) {
    limiter?.recordMiss(userId, code, now);
    return rejected('not_found', NOT_FOUND_MESSAGE);
  }

  const usage = await usageOf(db, coupon.id, userId);
  const result = assessCoupon(
    coupon,
    { subtotal: input.subtotal, deliveryFee: input.deliveryFee },
    usage,
    now,
  );
  // Para la persona un cupón desactivado es un cupón que no existe: también cuenta como intento.
  if (!result.ok && result.reason === 'not_found') limiter?.recordMiss(userId, code, now);
  return result;
}

/** Error que ve la app al CREAR un pedido con un cupón que no sirve (la cotización solo avisa). */
export function couponRejectionError(r: CouponRejected): DomainError {
  if (r.reason === 'blocked') {
    return new DomainError('rate_limited', r.message, 429, {
      reason: r.reason,
      retryAfterMs: r.retryAfterMs,
    });
  }
  return new DomainError('coupon_invalid', r.message, 409, { reason: r.reason });
}

// ───────────────────────── ciclo de vida de la redención ─────────────────────────

/**
 * Registra el uso dentro de la transacción del pedido. Debe llamarse con el cupón ya bloqueado
 * por `evaluateCoupon({ lock: true })`. `amount` es lo que el cupón le cuesta al negocio: el
 * descuento en productos o, en envío gratis, el envío que se perdonó.
 */
export async function recordRedemption(
  tx: Db,
  input: { code: string; userId: string; orderId: string; amount: number },
): Promise<void> {
  const coupon = await findCouponByCode(tx, input.code);
  if (!coupon) throw notFound('Cupón');
  await tx.insert(couponRedemptions).values({
    couponId: coupon.id,
    userId: input.userId,
    orderId: input.orderId,
    amount: input.amount,
  });
}

/**
 * Pedido cancelado o vencido sin pagar: el uso se libera y vuelve a contar para los límites
 * (global y por persona). El pedido conserva `coupon_code` y `discount` como historia.
 */
export async function releaseRedemption(tx: Db, orderId: string): Promise<void> {
  await tx.delete(couponRedemptions).where(eq(couponRedemptions.orderId, orderId));
}

/**
 * Descuento definitivo al empacar, con el peso real. Regla:
 *  - porcentaje: se recalcula sobre el monto real (respetando el tope del cupón);
 *  - monto fijo: se mantiene el descuento pactado (nunca más que el monto real);
 *  - envío gratis: no hay descuento en productos.
 */
export async function finalDiscountForOrder(
  tx: Db,
  order: { couponCode: string | null; discount: number },
  grossFinal: number,
): Promise<number> {
  if (!order.couponCode || order.discount <= 0) return order.discount;
  const coupon = await findCouponByCode(tx, order.couponCode);
  if (coupon?.kind === 'percent') return couponDiscount(coupon, grossFinal);
  return Math.min(order.discount, grossFinal);
}

/** Deja en la redención lo que de verdad se descontó tras pesar (no aplica a envío gratis). */
export async function recordFinalDiscount(
  tx: Db,
  order: { id: string; couponCode: string | null; discount: number },
  finalDiscount: number,
): Promise<void> {
  if (!order.couponCode || order.discount <= 0) return;
  await tx
    .update(couponRedemptions)
    .set({ amount: finalDiscount })
    .where(eq(couponRedemptions.orderId, order.id));
}

// ───────────────────────── administración ─────────────────────────

export interface CouponTerms {
  code: string;
  description: string;
  kind: CouponKind;
  value: number;
  minSubtotal: number;
  maxDiscount: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  perUserLimit: number;
  active: boolean;
}

const INT4_MAX = 2_147_483_647;
const MAX_PER_USER = 1000;

const isInt = (n: unknown, min: number): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= INT4_MAX;

/** Reglas de negocio de un cupón; las usan la validación de la ruta y la edición. */
export function couponTermIssues(t: CouponTerms): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (!COUPON_CODE_PATTERN.test(t.code)) {
    add('code', 'El código debe tener de 3 a 20 caracteres: letras A-Z, números o guion');
  }
  if (t.kind === 'percent') {
    if (!isInt(t.value, 1) || t.value > 10_000) {
      add('value', 'El porcentaje va de 1 a 10000 puntos básicos (100 = 1 %, 10000 = 100 %)');
    }
  } else if (t.kind === 'fixed') {
    if (!isInt(t.value, 1)) add('value', 'El descuento fijo debe ser mayor que cero (en centavos)');
  } else {
    if (t.value !== 0) add('value', 'El envío gratis no lleva valor');
    if (t.maxDiscount !== null) add('maxDiscount', 'El envío gratis no lleva tope de descuento');
  }
  if (!isInt(t.minSubtotal, 0))
    add('minSubtotal', 'El subtotal mínimo debe ser un entero en centavos (0 o más)');
  if (t.maxDiscount !== null && !isInt(t.maxDiscount, 1)) {
    add('maxDiscount', 'El tope de descuento debe ser mayor que cero (en centavos)');
  }
  if (t.maxRedemptions !== null && !isInt(t.maxRedemptions, 1)) {
    add('maxRedemptions', 'El máximo de usos debe ser 1 o más');
  }
  if (!isInt(t.perUserLimit, 1) || t.perUserLimit > MAX_PER_USER) {
    add('perUserLimit', `El límite por persona va de 1 a ${MAX_PER_USER}`);
  }
  if (t.startsAt && t.endsAt && t.endsAt <= t.startsAt) {
    add('endsAt', 'La fecha de fin debe ser posterior a la de inicio');
  }
  if (t.description.length > 140) add('description', 'La descripción admite hasta 140 caracteres');
  return issues;
}

function assertTerms(t: CouponTerms): void {
  const [first] = couponTermIssues(t);
  if (first) throw invalid(`${first.path}: ${first.message}`, couponTermIssues(t));
}

/**
 * ¿Es una violación de índice único (SQLSTATE 23505)? El driver envuelve el error de Postgres en
 * otro cuyo mensaje es el SQL, así que el código hay que buscarlo en la cadena de `cause`.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current = error as { code?: string; message?: string; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.code === '23505' || /duplicate key/i.test(String(current.message))) return true;
    current = current.cause as typeof current;
  }
  return false;
}

export async function createCoupon(db: Db, terms: CouponTerms): Promise<CouponRow> {
  assertTerms(terms);
  const exists = await findCouponByCode(db, terms.code);
  const dup = () => conflict('coupon_exists', `Ya existe un cupón con el código ${terms.code}`);
  if (exists) throw dup();
  try {
    const [row] = await db.insert(coupons).values(terms).returning();
    return row!;
  } catch (e) {
    // Dos administradores creando el mismo código a la vez: gana uno.
    if (isUniqueViolation(e)) throw dup();
    throw e;
  }
}

export type CouponTermsPatch = Partial<Omit<CouponTerms, 'code'>>;

/** Lo que cambia el dinero de pedidos ya hechos: queda congelado cuando el cupón tiene usos. */
const FROZEN_WHEN_USED = ['kind', 'value', 'maxDiscount'] as const;

export async function updateCoupon(
  db: Db,
  id: string,
  patch: CouponTermsPatch,
): Promise<CouponRow> {
  return db.transaction(async (tx) => {
    // Misma fila que bloquea un pedido en curso: la edición espera a que termine y lo cuenta.
    const [current] = await tx.select().from(coupons).where(eq(coupons.id, id)).for('update');
    if (!current) throw notFound('Cupón');

    const changed = Object.entries(patch).filter(
      ([k, v]) => v !== undefined && !sameValue(current[k as keyof CouponRow], v),
    );
    if (changed.length === 0) return current;

    const touchesMoney = changed.some(([k]) => (FROZEN_WHEN_USED as readonly string[]).includes(k));
    if (touchesMoney) {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(couponRedemptions)
        .where(eq(couponRedemptions.couponId, id));
      if (n > 0) {
        throw conflict(
          'coupon_locked',
          'Este cupón ya tiene usos: no se puede cambiar su tipo, valor ni tope. Crea otro cupón.',
          { redemptions: n },
        );
      }
    }

    const merged: CouponTerms = { ...current, ...definedOnly(patch) };
    assertTerms(merged);
    const [row] = await tx
      .update(coupons)
      .set(Object.fromEntries(changed))
      .where(eq(coupons.id, id))
      .returning();
    return row!;
  });
}

const definedOnly = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export function couponStatus(
  row: Pick<CouponRow, 'active' | 'startsAt' | 'endsAt' | 'maxRedemptions'>,
  redemptions: number,
  now: Date,
): CouponStatus {
  if (!row.active) return 'paused';
  if (row.endsAt && row.endsAt <= now) return 'expired';
  if (row.startsAt && row.startsAt > now) return 'scheduled';
  if (row.maxRedemptions !== null && redemptions >= row.maxRedemptions) return 'exhausted';
  return 'active';
}

export function toCouponDTO(
  row: CouponRow,
  stats: { redemptions: number; discountTotal: number },
  now: Date,
): CouponDTO {
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    kind: row.kind,
    value: row.value,
    minSubtotal: row.minSubtotal,
    maxDiscount: row.maxDiscount,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    maxRedemptions: row.maxRedemptions,
    perUserLimit: row.perUserLimit,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    redemptions: stats.redemptions,
    discountTotal: stats.discountTotal,
    status: couponStatus(row, stats.redemptions, now),
    termsLocked: stats.redemptions > 0,
  };
}

async function statsByCoupon(db: Db) {
  const rows = await db
    .select({
      couponId: couponRedemptions.couponId,
      n: count(),
      amount: sql<number>`coalesce(sum(${couponRedemptions.amount}), 0)`.mapWith(Number),
    })
    .from(couponRedemptions)
    .groupBy(couponRedemptions.couponId);
  return new Map(rows.map((r) => [r.couponId, { redemptions: r.n, discountTotal: r.amount }]));
}

const NO_STATS = { redemptions: 0, discountTotal: 0 };

export async function listCoupons(db: Db, now: Date): Promise<CouponDTO[]> {
  const [rows, stats] = await Promise.all([
    db.select().from(coupons).orderBy(desc(coupons.createdAt), desc(coupons.code)),
    statsByCoupon(db),
  ]);
  return rows.map((r) => toCouponDTO(r, stats.get(r.id) ?? NO_STATS, now));
}

export async function getCouponDTO(db: Db, id: string, now: Date): Promise<CouponDTO> {
  const [row] = await db.select().from(coupons).where(eq(coupons.id, id));
  if (!row) throw notFound('Cupón');
  const stats = (await statsByCoupon(db)).get(id) ?? NO_STATS;
  return toCouponDTO(row, stats, now);
}

export async function listRedemptions(
  db: Db,
  couponId: string,
  limit = 500,
): Promise<CouponRedemptionDTO[]> {
  const [coupon] = await db
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.id, couponId));
  if (!coupon) throw notFound('Cupón');
  const rows = await db
    .select({
      id: couponRedemptions.id,
      orderId: couponRedemptions.orderId,
      orderNumber: orders.number,
      orderStatus: orders.status,
      userId: couponRedemptions.userId,
      customerName: users.name,
      amount: couponRedemptions.amount,
      createdAt: couponRedemptions.createdAt,
    })
    .from(couponRedemptions)
    .innerJoin(orders, eq(orders.id, couponRedemptions.orderId))
    .innerJoin(users, eq(users.id, couponRedemptions.userId))
    .where(and(eq(couponRedemptions.couponId, couponId)))
    .orderBy(desc(couponRedemptions.createdAt))
    .limit(Math.min(limit, 500));
  return rows.map((r) => ({
    id: r.id,
    orderId: r.orderId,
    orderCode: formatOrderNumber(r.orderNumber),
    orderStatus: r.orderStatus as OrderStatus,
    userId: r.userId,
    customerName: r.customerName,
    amount: r.amount,
    createdAt: r.createdAt.toISOString(),
  }));
}
