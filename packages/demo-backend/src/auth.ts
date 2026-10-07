import { normalizeDominicanPhone } from '@jellyfish/shared';
import type { Ctx } from './context';
import { invalid, notFound, tooMany, unauthorized } from './errors';
import type { AddressRec, DeviceRec, UserRec } from './types';
import { iso, randomToken, randomUuid } from './util';

const OTP_WINDOW_MS = 10 * 60_000;
const MAX_CODES_PER_WINDOW = 3;
const MAX_DEVICES_PER_USER = 10;

export function requirePhone(raw: string): string {
  const phone = normalizeDominicanPhone(raw);
  if (!phone) throw invalid('Ingresa un número dominicano válido (809, 829 o 849)');
  return phone;
}

/**
 * Pedir el código. En la demostración no se envía nada: la vista previa le muestra a la persona
 * que el código es 123456 (y cualquier código de 6 dígitos sirve). Con `strictOtp` se aplica el
 * mismo límite de 3 códigos cada 10 minutos que el API real.
 */
export function requestOtp(ctx: Ctx, rawPhone: string): { phone: string; expiresInSeconds: number } {
  const phone = requirePhone(rawPhone);
  const now = ctx.now();
  const recent = (ctx.state.otpRequests[phone] ?? []).filter((t) => t > now - OTP_WINDOW_MS);
  if (ctx.cfg.strictOtp && recent.length >= MAX_CODES_PER_WINDOW) {
    throw tooMany('Pediste demasiados códigos. Intenta de nuevo en unos minutos.');
  }
  ctx.state.otpRequests[phone] = [...recent, now];
  return { phone, expiresInSeconds: ctx.cfg.otpTtlMinutes * 60 };
}

export function verifyOtp(ctx: Ctx, rawPhone: string, code: string): UserRec {
  const phone = requirePhone(rawPhone);
  const now = ctx.now();
  if (ctx.cfg.strictOtp) {
    const requested = (ctx.state.otpRequests[phone] ?? []).some(
      (t) => t > now - ctx.cfg.otpTtlMinutes * 60_000,
    );
    if (!requested || code.trim() !== ctx.cfg.otpCode) throw invalid('Código incorrecto o vencido');
  }
  const existing = ctx.state.users.find((u) => u.phone === phone && !u.deletedAt);
  if (existing) return existing;
  const user: UserRec = {
    id: randomUuid(ctx.rng),
    phone,
    name: '',
    email: null,
    role: 'customer',
    createdAt: iso(now),
    deletedAt: null,
  };
  ctx.state.users.push(user);
  return user;
}

export function openSession(ctx: Ctx, user: UserRec): string {
  const token = randomToken(ctx.rng);
  ctx.state.sessions[token] = user.id;
  return token;
}

export function publicUser(u: UserRec) {
  return { id: u.id, phone: u.phone, name: u.name, email: u.email, role: u.role };
}

/** Quién hace la petición: el token de `Authorization: Bearer …` debe ser de una sesión abierta. */
export function authenticate(ctx: Ctx, headers: Record<string, string>): UserRec {
  const header = headers['authorization'] ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  const userId = token ? ctx.state.sessions[token] : undefined;
  if (!userId) throw unauthorized();
  const user = ctx.state.users.find((u) => u.id === userId);
  if (!user || user.deletedAt) throw unauthorized('Tu sesión ya no es válida');
  return user;
}

/** Eliminación de cuenta: se anonimiza el perfil y se borran direcciones y dispositivos. */
export function deleteAccount(ctx: Ctx, user: UserRec): void {
  const { state } = ctx;
  state.addresses = state.addresses.filter((a) => a.userId !== user.id);
  state.devices = state.devices.filter((d) => d.userId !== user.id);
  user.phone = `deleted:${user.id}`;
  user.name = '';
  user.email = null;
  user.deletedAt = iso(ctx.now());
}

// ───────────────────────── direcciones ─────────────────────────

export function listAddresses(ctx: Ctx, userId: string): AddressRec[] {
  return ctx.state.addresses
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => a.userId === userId)
    .sort((x, y) => {
      if (x.a.isDefault !== y.a.isDefault) return x.a.isDefault ? -1 : 1;
      if (x.a.createdAt !== y.a.createdAt) return x.a.createdAt < y.a.createdAt ? 1 : -1;
      return y.index - x.index; // mismo instante: la más reciente primero
    })
    .map(({ a }) => a);
}

type AddressFields = Omit<AddressRec, 'id' | 'userId' | 'createdAt'>;

export function createAddress(ctx: Ctx, userId: string, body: AddressFields): AddressRec {
  const existing = ctx.state.addresses.filter((a) => a.userId === userId);
  const makeDefault = body.isDefault || existing.length === 0;
  if (makeDefault) for (const a of existing) a.isDefault = false;
  const row: AddressRec = {
    ...body,
    id: randomUuid(ctx.rng),
    userId,
    isDefault: makeDefault,
    createdAt: iso(ctx.now()),
  };
  ctx.state.addresses.push(row);
  return row;
}

export function updateAddress(ctx: Ctx, userId: string, id: string, body: AddressFields): AddressRec {
  if (body.isDefault) {
    for (const a of ctx.state.addresses) if (a.userId === userId) a.isDefault = false;
  }
  const row = ctx.state.addresses.find((a) => a.id === id && a.userId === userId);
  if (!row) throw notFound('Dirección');
  Object.assign(row, body);
  return row;
}

export function deleteAddress(ctx: Ctx, userId: string, id: string): void {
  const idx = ctx.state.addresses.findIndex((a) => a.id === id && a.userId === userId);
  if (idx < 0) throw notFound('Dirección');
  ctx.state.addresses.splice(idx, 1);
}

// ───────────────────────── dispositivos (push: no hace nada) ─────────────────────────

export function registerDevice(
  ctx: Ctx,
  userId: string,
  input: { token: string; platform: 'ios' | 'android' | 'web' },
): { token: string; platform: 'ios' | 'android' | 'web'; lastSeenAt: string } {
  const now = iso(ctx.now());
  const devices = ctx.state.devices;
  const existing = devices.find((d) => d.token === input.token);
  if (existing) {
    existing.userId = userId;
    existing.platform = input.platform;
    existing.lastSeenAt = now;
  } else {
    devices.push({ userId, token: input.token, platform: input.platform, lastSeenAt: now });
  }
  // Se conservan los 10 más recientes por persona.
  const mine = devices
    .filter((d) => d.userId === userId)
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));
  const evict = new Set(mine.slice(MAX_DEVICES_PER_USER).map((d) => d.token));
  if (evict.size > 0) ctx.state.devices = devices.filter((d) => !evict.has(d.token));
  return { token: input.token, platform: input.platform, lastSeenAt: now };
}

export function unregisterDevice(ctx: Ctx, userId: string, token: string): void {
  ctx.state.devices = ctx.state.devices.filter(
    (d: DeviceRec) => !(d.token === token && d.userId === userId),
  );
}
