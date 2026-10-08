import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { type Config, loadConfig } from '../src/config';
import { deviceTokens, orderEvents, orders, users, variants } from '../src/db/schema';
import { runMaintenanceTick } from '../src/maintenance';
import { MemoryOtpSender } from '../src/services/auth';
import { createOrder, expireStaleOrders, transitionOrder } from '../src/services/orders';
import {
  EXPO_BATCH_SIZE,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_URL,
  ExpoPushSender,
  MAX_DEVICES_PER_USER,
  type PushMessage,
  type PushReceipt,
  PushService,
  type PushSender,
  type PushTicket,
  customerNotification,
  driverAssignedNotification,
  isExpoPushToken,
  newOrderNotification,
  notifyUsers,
} from '../src/services/push';
import { redactUrl } from '../src/services/http-util';
import { fakeFetch, hang, json, recordingLogger } from './fake-fetch';
import { ADDRESS, NOW, type World, makeWorld } from './helpers';

// ───────────────────────── dobles y utilidades ─────────────────────────

const ROOMY = {
  startHour: 10,
  endHour: 20,
  windowHours: 2,
  capacityPerWindow: 500,
  leadMinutes: 90,
  daysAhead: 3,
};

const tok = (name: string) => `ExponentPushToken[${name.padEnd(12, '0')}]`;
const parse = (res: { body: string }) => JSON.parse(res.body);

/** Transporte falso: recuerda lo enviado y permite forzar tickets, fallas y esperas. */
class FakePushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  readonly receiptCalls: string[][] = [];
  tickets = new Map<string, PushTicket>();
  receipts: Record<string, PushReceipt> = {};
  failure: Error | null = null;
  gate: Promise<void> | null = null;
  private n = 0;

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    this.sent.push(...messages);
    return messages.map((m) => this.tickets.get(m.to) ?? { status: 'ok', id: `T${++this.n}` });
  }

  async getReceipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    this.receiptCalls.push(ids);
    return Object.fromEntries(
      ids.filter((id) => id in this.receipts).map((id) => [id, this.receipts[id]!]),
    );
  }

  reset() {
    this.sent.length = 0;
    this.receiptCalls.length = 0;
    this.tickets.clear();
    this.receipts = {};
    this.failure = null;
    this.gate = null;
  }

  to(token: string) {
    return this.sent.filter((m) => m.to === token);
  }
  titles(token: string) {
    return this.to(token).map((m) => m.title);
  }
}

interface Env {
  w: World;
  app: FastifyInstance;
  sender: FakePushSender;
  clock: { value: Date };
  headers: Record<
    'customer' | 'other' | 'admin' | 'staff' | 'driver' | 'driver2',
    { authorization: string }
  >;
  ids: Record<'customer' | 'other' | 'admin' | 'staff' | 'driver' | 'driver2', string>;
}

async function setup(overrides: Partial<Config> = {}): Promise<Env> {
  const w = await makeWorld({ windows: ROOMY, pushEnabled: true, ...overrides });
  const { db } = w.handle;
  // Existencias de sobra: cada prueba hace sus propios pedidos.
  await db.update(variants).set({ onHand: 10_000 });
  const extra = await db
    .insert(users)
    .values([
      { phone: '+18095550004', name: 'Personal', role: 'staff' },
      { phone: '+18095550005', name: 'Otra clienta', role: 'customer' },
      { phone: '+18095550006', name: 'Otro motorista', role: 'driver' },
    ])
    .returning({ id: users.id });
  const sender = new FakePushSender();
  const clock = { value: NOW };
  const app = await buildApp({
    db,
    config: w.config,
    otpSender: new MemoryOtpSender(),
    pushSender: sender,
    now: () => clock.value,
  });
  const ids = {
    customer: w.customerId,
    other: extra[1]!.id,
    admin: w.adminId,
    staff: extra[0]!.id,
    driver: w.driverId,
    driver2: extra[2]!.id,
  };
  const role = {
    customer: 'customer',
    other: 'customer',
    admin: 'admin',
    staff: 'staff',
    driver: 'driver',
    driver2: 'driver',
  } as const;
  const headers = Object.fromEntries(
    (Object.keys(ids) as (keyof typeof ids)[]).map((k) => [
      k,
      { authorization: `Bearer ${app.jwt.sign({ sub: ids[k], role: role[k] })}` },
    ]),
  ) as Env['headers'];
  return { w, app, sender, clock, headers, ids };
}

async function teardown(e: Env) {
  await e.app.close();
  await e.w.close();
}

/** Cada persona con su teléfono: customer, other, admin, staff, driver, driver2. */
async function registerAll(e: Env) {
  const { db } = e.w.handle;
  await db.delete(deviceTokens);
  await db.insert(deviceTokens).values(
    (Object.keys(e.ids) as (keyof Env['ids'])[]).map((k) => ({
      userId: e.ids[k],
      token: tok(k),
      platform: 'android' as const,
    })),
  );
}

async function devicesOf(e: Env, userId: string) {
  const rows = await e.w.handle.db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId));
  return rows.map((r) => r.token).sort();
}

async function placeOrder(
  e: Env,
  method: 'card' | 'cash' | 'transfer',
  items: { sku: string; quantity: number }[] = [{ sku: 'CMB-1', quantity: 1 }],
) {
  const resolved = await Promise.all(
    items.map(async (i) => ({ variantId: (await e.w.variant(i.sku)).id, quantity: i.quantity })),
  );
  const res = await e.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: e.headers.customer,
    payload: {
      items: resolved,
      address: ADDRESS,
      slotStart: (await e.w.firstSlot()).toISOString(),
      paymentMethod: method,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return parse(res);
}

const adminTransition = (e: Env, orderId: string, to: string, note = '') =>
  e.app.inject({
    method: 'POST',
    url: `/v1/admin/orders/${orderId}/transition`,
    headers: e.headers.admin,
    payload: { to, note },
  });

const driverTransition = (e: Env, orderId: string, to: string) =>
  e.app.inject({
    method: 'POST',
    url: `/v1/driver/orders/${orderId}/transition`,
    headers: e.headers.driver,
    payload: { to },
  });

const assignDriver = (e: Env, orderId: string, driverId: string) =>
  e.app.inject({
    method: 'POST',
    url: `/v1/admin/orders/${orderId}/assign-driver`,
    headers: e.headers.admin,
    payload: { driverId },
  });

/** Espera a que terminen los envíos que dejó la petición anterior. */
const settle = (e: Env) => e.app.push.drain();

async function setPin(e: Env, orderId: string, pin: string | null) {
  await e.w.handle.db.update(orders).set({ deliveryPin: pin }).where(eq(orders.id, orderId));
}

// ───────────────────────── registro de dispositivos ─────────────────────────

describe('dispositivos: POST/DELETE /v1/me/devices', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(() => teardown(e));
  beforeEach(async () => {
    e.clock.value = NOW;
    await e.w.handle.db.delete(deviceTokens);
  });

  const register = (who: keyof Env['headers'], payload: object) =>
    e.app.inject({ method: 'POST', url: '/v1/me/devices', headers: e.headers[who], payload });

  it('registra el dispositivo de quien tiene sesión', async () => {
    const res = await register('customer', { token: tok('abc'), platform: 'ios' });
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({
      token: tok('abc'),
      platform: 'ios',
      lastSeenAt: NOW.toISOString(),
    });
    const rows = await e.w.handle.db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: e.ids.customer, token: tok('abc'), platform: 'ios' });
  });

  it('registrar el mismo token otra vez no duplica: actualiza plataforma y lastSeenAt', async () => {
    await register('customer', { token: tok('abc'), platform: 'ios' });
    const [first] = await e.w.handle.db.select().from(deviceTokens);

    e.clock.value = new Date(NOW.getTime() + 3_600_000);
    const again = await register('customer', { token: tok('abc'), platform: 'android' });
    expect(again.statusCode).toBe(200);

    const rows = await e.w.handle.db.select().from(deviceTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, platform: 'android', userId: e.ids.customer });
    expect(rows[0]!.lastSeenAt.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    expect(rows[0]!.createdAt).toEqual(first!.createdAt);
  });

  it('si el token cambia de dueño pasa a la persona actual y deja de ser de la anterior', async () => {
    await register('customer', { token: tok('compartido'), platform: 'android' });
    await register('customer', { token: tok('solo-mio'), platform: 'android' });
    expect(await devicesOf(e, e.ids.customer)).toHaveLength(2);

    const res = await register('other', { token: tok('compartido'), platform: 'ios' });
    expect(res.statusCode).toBe(200);

    expect(await devicesOf(e, e.ids.other)).toEqual([tok('compartido')]);
    expect(await devicesOf(e, e.ids.customer)).toEqual([tok('solo-mio')]);
    expect(await e.w.handle.db.select().from(deviceTokens)).toHaveLength(2);
  });

  it('guarda el token sin espacios sobrantes', async () => {
    const res = await register('customer', { token: `  ${tok('abc')}\n`, platform: 'web' });
    expect(res.statusCode).toBe(200);
    expect(await devicesOf(e, e.ids.customer)).toEqual([tok('abc')]);
  });

  it('acepta los dos prefijos de Expo y rechaza todo lo demás con 400', async () => {
    for (const token of [
      'ExponentPushToken[abcdefgh12345678]',
      'ExpoPushToken[abcdefgh12345678]',
      'ExponentPushToken[abc_DEF-1234567]',
    ]) {
      expect(isExpoPushToken(token), token).toBe(true);
      expect((await register('customer', { token, platform: 'ios' })).statusCode, token).toBe(200);
    }
    await e.w.handle.db.delete(deviceTokens);

    const bad = [
      '',
      'abc',
      'ExponentPushToken[]',
      'ExponentPushToken[corto]',
      'ExponentPushToken[sin-cerrar-12345',
      'FooPushToken[abcdefgh12345678]',
      'exponentpushtoken[abcdefgh12345678]',
      'ExponentPushToken[con espacio adentro]',
      'ExponentPushToken[abcdefgh12345678] extra',
      `ExponentPushToken[${'x'.repeat(300)}]`,
      '<script>alert(1)</script>',
    ];
    for (const token of bad) {
      expect(isExpoPushToken(token), token).toBe(false);
      const res = await register('customer', { token, platform: 'ios' });
      expect(res.statusCode, token).toBe(400);
      expect(parse(res).error).toMatchObject({ code: 'validation' });
      expect(parse(res).error.message).toMatch(/Token de notificaciones inválido/);
    }
    expect(await e.w.handle.db.select().from(deviceTokens)).toHaveLength(0);
  });

  it('exige token y una plataforma válida', async () => {
    const noToken = await register('customer', { platform: 'ios' });
    expect(noToken.statusCode).toBe(400);
    expect(parse(noToken).error.message).toMatch(/token/i);

    const numeric = await register('customer', { token: 12345, platform: 'ios' });
    expect(numeric.statusCode).toBe(400);

    for (const platform of ['windows', 'IOS', '', undefined, 7]) {
      const res = await register('customer', { token: tok('abc'), platform });
      expect(res.statusCode, String(platform)).toBe(400);
      expect(parse(res).error.message).toMatch(/Plataforma inválida/);
    }
    expect(await e.w.handle.db.select().from(deviceTokens)).toHaveLength(0);
  });

  it('exige sesión', async () => {
    const res = await e.app.inject({
      method: 'POST',
      url: '/v1/me/devices',
      payload: { token: tok('abc'), platform: 'ios' },
    });
    expect(res.statusCode).toBe(401);
    const del = await e.app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${encodeURIComponent(tok('abc'))}`,
    });
    expect(del.statusCode).toBe(401);
  });

  it('DELETE quita el dispositivo, y repetirlo también responde 204', async () => {
    await register('customer', { token: tok('abc'), platform: 'ios' });
    const url = `/v1/me/devices/${encodeURIComponent(tok('abc'))}`;
    const del = await e.app.inject({ method: 'DELETE', url, headers: e.headers.customer });
    expect(del.statusCode).toBe(204);
    expect(await devicesOf(e, e.ids.customer)).toEqual([]);
    const again = await e.app.inject({ method: 'DELETE', url, headers: e.headers.customer });
    expect(again.statusCode).toBe(204);
  });

  it('nadie puede quitar el dispositivo de otra persona', async () => {
    await register('customer', { token: tok('abc'), platform: 'ios' });
    const del = await e.app.inject({
      method: 'DELETE',
      url: `/v1/me/devices/${encodeURIComponent(tok('abc'))}`,
      headers: e.headers.other,
    });
    expect(del.statusCode).toBe(204);
    expect(await devicesOf(e, e.ids.customer)).toEqual([tok('abc')]);
  });

  it(`conserva solo los ${MAX_DEVICES_PER_USER} dispositivos más recientes por persona`, async () => {
    await register('other', { token: tok('de-otra'), platform: 'ios' });
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
    for (let i = 0; i < MAX_DEVICES_PER_USER; i++) {
      e.clock.value = at(i);
      await register('customer', { token: tok(`tel${i}`), platform: 'android' });
    }
    // El teléfono más viejo vuelve a abrir la app: ya no es el candidato a salir.
    e.clock.value = at(20);
    await register('customer', { token: tok('tel0'), platform: 'android' });
    e.clock.value = at(21);
    const res = await register('customer', { token: tok('tel-nuevo'), platform: 'android' });
    expect(res.statusCode).toBe(200);

    const mine = await devicesOf(e, e.ids.customer);
    expect(mine).toHaveLength(MAX_DEVICES_PER_USER);
    expect(mine).toContain(tok('tel-nuevo'));
    expect(mine).toContain(tok('tel0'));
    expect(mine).not.toContain(tok('tel1')); // el que más tiempo llevaba sin abrir la app
    // Otra persona no se ve afectada.
    expect(await devicesOf(e, e.ids.other)).toEqual([tok('de-otra')]);
  });
});

describe('cuenta y perfil', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(() => teardown(e));

  it('eliminar la cuenta borra sus dispositivos y no los de los demás', async () => {
    await registerAll(e);
    await e.app.inject({
      method: 'POST',
      url: '/v1/me/devices',
      headers: e.headers.customer,
      payload: { token: tok('segundo-tel'), platform: 'ios' },
    });
    expect(await devicesOf(e, e.ids.customer)).toHaveLength(2);

    const del = await e.app.inject({
      method: 'DELETE',
      url: '/v1/me',
      headers: e.headers.customer,
    });
    expect(del.statusCode).toBe(204);

    expect(await devicesOf(e, e.ids.customer)).toEqual([]);
    expect(await devicesOf(e, e.ids.admin)).toEqual([tok('admin')]);
    expect(await devicesOf(e, e.ids.driver)).toEqual([tok('driver')]);
  });

  it('PATCH /v1/me ya no guarda pushToken (campo heredado) y una app vieja no se rompe', async () => {
    const legacy = await e.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: e.headers.admin,
      payload: { pushToken: tok('legado') },
    });
    expect(legacy.statusCode).toBe(200);
    expect(parse(legacy)).toMatchObject({ id: e.ids.admin, role: 'admin' });
    expect(parse(legacy)).not.toHaveProperty('pushToken');
    const [row] = await e.w.handle.db.select().from(users).where(eq(users.id, e.ids.admin));
    expect(row!.pushToken).toBeNull();

    // Y el perfil sigue editándose con normalidad.
    const named = await e.app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: e.headers.admin,
      payload: { name: 'Admin Nuevo', pushToken: tok('legado') },
    });
    expect(parse(named).name).toBe('Admin Nuevo');
  });
});

// ───────────────────────── notifyUsers ─────────────────────────

describe('notifyUsers', () => {
  let e: Env;
  const sender = new FakePushSender();
  beforeAll(async () => (e = await setup()));
  afterAll(() => teardown(e));
  beforeEach(async () => {
    sender.reset();
    await registerAll(e);
  });

  const ctx = (extra: { enabled?: boolean; sender?: PushSender } = {}) => {
    const log = recordingLogger();
    return {
      log,
      ctx: {
        db: e.w.handle.db,
        sender: extra.sender ?? sender,
        logger: log.logger,
        enabled: extra.enabled ?? true,
      },
    };
  };
  const note = { title: 'Hola', body: 'Cuerpo', data: { type: 'order', orderId: 'o-1' } };

  it('manda un mensaje por dispositivo de las personas indicadas, y a nadie más', async () => {
    await e.w.handle.db.insert(deviceTokens).values({
      userId: e.ids.customer,
      token: tok('segundo-tel'),
      platform: 'ios',
    });
    const { ctx: c } = ctx();
    const r = await notifyUsers(c, [e.ids.customer, e.ids.admin, e.ids.customer], note);

    expect(r).toEqual({ devices: 3, sent: 3, failed: 0, removed: 0 });
    expect(sender.sent.map((m) => m.to).sort()).toEqual(
      [tok('admin'), tok('customer'), tok('segundo-tel')].sort(),
    );
    expect(sender.sent[0]).toMatchObject({
      title: 'Hola',
      body: 'Cuerpo',
      data: { type: 'order', orderId: 'o-1' },
      sound: 'default',
      priority: 'high',
    });
    expect(sender.sent[0]!.ttl).toBeGreaterThan(0);
  });

  it('borra los tokens con DeviceNotRegistered y conserva el resto', async () => {
    sender.tickets.set(tok('admin'), {
      status: 'error',
      error: 'DeviceNotRegistered',
      message: 'gone',
    });
    const { ctx: c, log } = ctx();
    const r = await notifyUsers(c, [e.ids.customer, e.ids.admin, e.ids.staff], note);

    expect(r).toEqual({ devices: 3, sent: 2, failed: 1, removed: 1 });
    expect(await devicesOf(e, e.ids.admin)).toEqual([]);
    expect(await devicesOf(e, e.ids.customer)).toEqual([tok('customer')]);
    expect(await devicesOf(e, e.ids.staff)).toEqual([tok('staff')]);
    // El log cuenta errores, pero nunca imprime tokens.
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.obj).toMatchObject({
      event: 'push_partial_failure',
      errors: { DeviceNotRegistered: 1 },
    });
    expect(log.dump()).not.toContain('ExponentPushToken');
  });

  it('los demás errores de Expo NO borran el token (puede ser pasajero)', async () => {
    sender.tickets.set(tok('admin'), { status: 'error', error: 'MessageRateExceeded' });
    const { ctx: c } = ctx();
    const r = await notifyUsers(c, [e.ids.admin], note);
    expect(r).toMatchObject({ sent: 0, failed: 1, removed: 0 });
    expect(await devicesOf(e, e.ids.admin)).toEqual([tok('admin')]);
  });

  it('si Expo devuelve menos tickets que mensajes, los que faltan cuentan como fallidos sin borrarse', async () => {
    const short: PushSender = { send: async () => [{ status: 'ok', id: 'T1' }] };
    const { ctx: c } = ctx({ sender: short });
    const r = await notifyUsers(c, [e.ids.admin, e.ids.staff], note);
    expect(r).toMatchObject({ devices: 2, sent: 1, failed: 1, removed: 0 });
    expect(await devicesOf(e, e.ids.admin)).toHaveLength(1);
    expect(await devicesOf(e, e.ids.staff)).toHaveLength(1);
  });

  it('ignora a quien ya eliminó su cuenta', async () => {
    await e.w.handle.db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, e.ids.other));
    const { ctx: c } = ctx();
    const r = await notifyUsers(c, [e.ids.other, e.ids.admin], note);
    expect(r.devices).toBe(1);
    expect(sender.sent.map((m) => m.to)).toEqual([tok('admin')]);
    await e.w.handle.db.update(users).set({ deletedAt: null }).where(eq(users.id, e.ids.other));
  });

  it('un transporte que lanza no propaga el error: devuelve ceros y registra', async () => {
    sender.failure = new Error('Expo caído: ExponentPushToken[secreto]');
    const { ctx: c, log } = ctx();
    const r = await notifyUsers(c, [e.ids.admin], note);
    expect(r).toEqual({ devices: 1, sent: 0, failed: 0, removed: 0 });
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ level: 'error', obj: { event: 'push_failed' } });
    expect(log.dump()).not.toContain('secreto');
    expect(await devicesOf(e, e.ids.admin)).toHaveLength(1);
  });

  it('apagado o sin destinatarios no llama al transporte', async () => {
    const off = ctx({ enabled: false });
    expect(await notifyUsers(off.ctx, [e.ids.admin], note)).toMatchObject({ devices: 0 });
    const on = ctx();
    expect(await notifyUsers(on.ctx, [], note)).toMatchObject({ devices: 0 });
    expect(sender.sent).toHaveLength(0);
  });

  it('descarta filas con un token que no tiene formato de Expo', async () => {
    await e.w.handle.db.insert(deviceTokens).values({
      userId: e.ids.admin,
      token: 'no-es-de-expo',
      platform: 'web',
    });
    const { ctx: c } = ctx();
    const r = await notifyUsers(c, [e.ids.admin], note);
    expect(r.devices).toBe(1);
    expect(sender.sent.map((m) => m.to)).toEqual([tok('admin')]);
  });
});

// ───────────────────────── transporte Expo ─────────────────────────

describe('ExpoPushSender', () => {
  const msg = (i: number): PushMessage => ({ to: tok(`dev${i}`), title: `t${i}`, body: `b${i}` });
  const okReply = (call: { init: RequestInit }) => {
    const batch = JSON.parse(call.init.body as string) as PushMessage[];
    return json({ data: batch.map((_, i) => ({ status: 'ok', id: `id-${batch[i]!.title}` })) });
  };
  const noSleep = async () => {};
  const make = (f: ReturnType<typeof fakeFetch>, extra = {}) => {
    const log = recordingLogger();
    return {
      log,
      sender: new ExpoPushSender({ fetch: f.fetch, sleep: noSleep, logger: log.logger, ...extra }),
    };
  };

  it('parte en lotes de 100, respeta el orden y arma la petición exacta', async () => {
    expect(EXPO_BATCH_SIZE).toBe(100);
    const f = fakeFetch(okReply);
    const { sender } = make(f);
    const messages = Array.from({ length: 250 }, (_, i) => msg(i));
    const tickets = await sender.send(messages);

    expect(f.calls).toHaveLength(3);
    expect(f.calls.map((c) => (JSON.parse(c.init.body as string) as unknown[]).length)).toEqual([
      100, 100, 50,
    ]);
    for (const c of f.calls) {
      expect(c.url).toBe('https://exp.host/--/api/v2/push/send');
      expect(c.url).toBe(EXPO_PUSH_URL);
      expect(c.init.method).toBe('POST');
      expect(c.init.headers).toEqual({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(f.calls[2]!.init.body as string)[0]).toEqual(messages[200]);
    expect(tickets).toHaveLength(250);
    expect(tickets[0]).toEqual({ status: 'ok', id: 'id-t0' });
    expect(tickets[249]).toEqual({ status: 'ok', id: 'id-t249' });
  });

  it('con EXPO_ACCESS_TOKEN manda Authorization: Bearer', async () => {
    const f = fakeFetch(okReply);
    await make(f, { accessToken: 'expo-secret-123' }).sender.send([msg(1)]);
    expect(f.calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer expo-secret-123' });
  });

  it('traduce los tickets de error, con el código dentro de details', async () => {
    const f = fakeFetch(
      json({
        data: [
          { status: 'ok', id: 'a' },
          {
            status: 'error',
            message: 'not a registered push notification recipient',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', message: 'raro' },
        ],
      }),
    );
    const tickets = await make(f).sender.send([msg(1), msg(2), msg(3)]);
    expect(tickets).toEqual([
      { status: 'ok', id: 'a' },
      {
        status: 'error',
        error: 'DeviceNotRegistered',
        message: 'not a registered push notification recipient',
      },
      { status: 'error', error: 'Unknown', message: 'raro' },
    ]);
  });

  it('un lote que falla no pierde a los demás: sus tickets son TransportError', async () => {
    let n = 0;
    const f = fakeFetch((call) => (++n === 2 || n === 3 ? json({}, 500) : okReply(call)));
    const { sender, log } = make(f);
    const tickets = await sender.send(Array.from({ length: 250 }, (_, i) => msg(i)));

    expect(f.calls).toHaveLength(4); // lote 1, lote 2 (+ su reintento), lote 3
    expect(tickets.slice(0, 100).every((t) => t.status === 'ok')).toBe(true);
    expect(tickets.slice(100, 200).every((t) => t.error === 'TransportError')).toBe(true);
    expect(tickets.slice(200).every((t) => t.status === 'ok')).toBe(true);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.obj).toMatchObject({ event: 'push_request_failed', reason: 'http_500' });
  });

  it('reintenta una vez ante 429, 5xx o red caída; no ante otros 4xx', async () => {
    for (const first of [json({}, 429), json({}, 503), new TypeError('fetch failed')]) {
      const f = fakeFetch(first, okReply);
      const [t] = await make(f).sender.send([msg(1)]);
      expect(f.calls).toHaveLength(2);
      expect(t!.status).toBe('ok');
    }
    const denied = fakeFetch(json({ errors: [{ code: 'UNAUTHORIZED' }] }, 401));
    const [t] = await make(denied).sender.send([msg(1)]);
    expect(denied.calls).toHaveLength(1);
    expect(t).toMatchObject({ status: 'error', error: 'TransportError' });
  });

  it('corta una petición que no contesta', async () => {
    const f = fakeFetch(hang);
    const { sender } = make(f, { timeoutMs: 15 });
    const [t] = await sender.send([msg(1)]);
    expect(f.calls).toHaveLength(2);
    expect(t).toMatchObject({ status: 'error', error: 'TransportError' });
  });

  it('una respuesta que no cuadra con el lote se trata como fallo, no como éxito', async () => {
    const f = fakeFetch(json({ data: [{ status: 'ok', id: 'solo-uno' }] }));
    const tickets = await make(f).sender.send([msg(1), msg(2)]);
    expect(tickets.map((t) => t.error)).toEqual(['BadResponse', 'BadResponse']);
  });

  it('consulta recibos con la URL de getReceipts', async () => {
    const f = fakeFetch(
      json({
        data: {
          a: { status: 'ok' },
          b: { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
        },
      }),
    );
    const receipts = await make(f).sender.getReceipts(['a', 'b', 'c']);
    expect(f.calls[0]!.url).toBe(EXPO_RECEIPTS_URL);
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ ids: ['a', 'b', 'c'] });
    expect(receipts).toEqual({
      a: { status: 'ok' },
      b: { status: 'error', error: 'DeviceNotRegistered', message: 'x' },
    });
  });
});

// ───────────────────────── plantillas ─────────────────────────

describe('plantillas en español', () => {
  const order = {
    id: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
    number: 123,
    total: 245_000,
    paymentMethod: 'cash' as const,
    address: { sector: 'Naco' },
    deliveryPin: null as string | null,
  };

  it('cada estado del ciclo tiene su aviso y todos abren el pedido correcto', () => {
    const expected = {
      confirmed: '¡Pedido confirmado!',
      picking: 'Estamos preparando tu pedido',
      packed: 'Tu pedido está listo',
      out_for_delivery: 'Tu pedido va en camino',
      delivered: '¡Pedido entregado!',
      delivery_failed: 'No pudimos entregar tu pedido',
      cancelled: 'Pedido cancelado',
      refunded: 'Reembolso registrado',
    } as const;
    for (const [status, title] of Object.entries(expected)) {
      const n = customerNotification(status as keyof typeof expected, order);
      expect(n, status).not.toBeNull();
      expect(n!.title).toBe(title);
      expect(n!.body, status).toContain('JF-000123');
      expect(n!.data).toEqual({ type: 'order', orderId: order.id });
    }
    // Cada aviso es distinto: no hay textos repetidos entre estados.
    const bodies = Object.keys(expected).map(
      (s) => customerNotification(s as keyof typeof expected, order)!.body,
    );
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  it('un pedido que aún espera el pago no avisa', () => {
    expect(customerNotification('pending_payment', order)).toBeNull();
  });

  it('en camino con PIN lo recuerda, pero NUNCA incluye el PIN', () => {
    const withPin = customerNotification('out_for_delivery', { ...order, deliveryPin: '4821' })!;
    expect(withPin.body).toContain('PIN de entrega');
    const without = customerNotification('out_for_delivery', order)!;
    expect(without.body).not.toMatch(/PIN/);

    for (const status of [
      'confirmed',
      'picking',
      'packed',
      'out_for_delivery',
      'delivered',
    ] as const) {
      const n = customerNotification(status, { ...order, number: 7, deliveryPin: '4821' })!;
      expect(JSON.stringify(n), status).not.toContain('4821');
    }
    // El aviso al equipo y al repartidor tampoco lo llevan.
    const pinned = { ...order, deliveryPin: '4821' };
    expect(JSON.stringify(newOrderNotification(pinned))).not.toContain('4821');
    expect(JSON.stringify(driverAssignedNotification(pinned))).not.toContain('4821');
  });

  it('el aviso al equipo trae código, total y método; el del repartidor, sector y sin calle', () => {
    const team = newOrderNotification(order);
    expect(team).toEqual({
      title: 'Nuevo pedido',
      body: 'JF-000123 · RD$ 2,450.00 · Efectivo',
      data: { type: 'order', orderId: order.id },
    });
    const drv = driverAssignedNotification(order);
    expect(drv.title).toBe('Nuevo pedido asignado');
    expect(drv.body).toContain('JF-000123');
    expect(drv.body).toContain('Naco');
    expect(drv.data).toEqual({ type: 'order', orderId: order.id });
  });
});

// ───────────────────────── ciclo del pedido por la API ─────────────────────────

describe('avisos del ciclo del pedido (API)', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(() => teardown(e));
  beforeEach(async () => {
    e.sender.reset();
    e.clock.value = NOW;
    await registerAll(e);
  });

  it('un pedido en efectivo nace confirmado: avisa al cliente y al equipo, no al resto', async () => {
    const order = await placeOrder(e, 'cash');
    await settle(e);

    expect(e.sender.titles(tok('customer'))).toEqual(['¡Pedido confirmado!']);
    expect(e.sender.titles(tok('admin'))).toEqual(['Nuevo pedido']);
    expect(e.sender.titles(tok('staff'))).toEqual(['Nuevo pedido']);
    expect(e.sender.sent).toHaveLength(3);
    const toTeam = e.sender.to(tok('admin'))[0]!;
    // Combo de RD$ 2,450.00 + RD$ 150.00 de envío.
    expect(order.total).toBe(260_000);
    expect(toTeam.body).toBe(`${order.code} · RD$ 2,600.00 · Efectivo`);
    for (const m of e.sender.sent) expect(m.data).toEqual({ type: 'order', orderId: order.id });
  });

  it('si quien pide es del equipo, recibe el aviso de su pedido y no el de "nuevo pedido"', async () => {
    const cmb = await e.w.variant('CMB-1');
    const res = await e.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: e.headers.admin,
      payload: {
        items: [{ variantId: cmb.id, quantity: 1 }],
        address: ADDRESS,
        slotStart: (await e.w.firstSlot()).toISOString(),
        paymentMethod: 'cash',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    await settle(e);

    expect(e.sender.titles(tok('admin'))).toEqual(['¡Pedido confirmado!']);
    expect(e.sender.titles(tok('staff'))).toEqual(['Nuevo pedido']);
  });

  it('un pedido con tarjeta o transferencia sin pagar no avisa a nadie', async () => {
    await placeOrder(e, 'card');
    await placeOrder(e, 'transfer');
    await settle(e);
    expect(e.sender.sent).toHaveLength(0);
  });

  it('al confirmarse el pago de una transferencia avisa al cliente y al equipo', async () => {
    const order = await placeOrder(e, 'transfer');
    const paid = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${order.payments[0].id}/mark-paid`,
      headers: e.headers.admin,
      payload: { reference: 'BPD-889900' },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    await settle(e);

    expect(e.sender.titles(tok('customer'))).toEqual(['¡Pedido confirmado!']);
    expect(e.sender.titles(tok('admin'))).toEqual(['Nuevo pedido']);
    expect(e.sender.titles(tok('staff'))).toEqual(['Nuevo pedido']);
    expect(e.sender.to(tok('admin'))[0]!.body).toContain('Transferencia');
    expect(e.sender.to(tok('driver'))).toHaveLength(0);
  });

  it('recorre el ciclo completo y el cliente recibe el aviso de cada estado, en orden', async () => {
    const order = await placeOrder(e, 'cash');
    await settle(e);
    const forCustomer = () => e.sender.titles(tok('customer'));

    expect((await adminTransition(e, order.id, 'picking')).statusCode).toBe(200);
    await settle(e);
    expect((await adminTransition(e, order.id, 'packed')).statusCode).toBe(200);
    await settle(e);
    expect((await assignDriver(e, order.id, e.ids.driver)).statusCode).toBe(200);
    await settle(e);
    expect((await driverTransition(e, order.id, 'out_for_delivery')).statusCode).toBe(200);
    await settle(e);
    expect((await driverTransition(e, order.id, 'delivery_failed')).statusCode).toBe(200);
    await settle(e);
    expect((await adminTransition(e, order.id, 'cancelled', 'Sin respuesta')).statusCode).toBe(200);
    await settle(e);

    expect(forCustomer()).toEqual([
      '¡Pedido confirmado!',
      'Estamos preparando tu pedido',
      'Tu pedido está listo',
      'Tu pedido va en camino',
      'No pudimos entregar tu pedido',
      'Pedido cancelado',
    ]);
    // El equipo solo se entera de que entró el pedido; el repartidor, de la asignación.
    expect(e.sender.titles(tok('admin'))).toEqual(['Nuevo pedido']);
    expect(e.sender.titles(tok('driver'))).toEqual(['Nuevo pedido asignado']);
    // Nada de esto llegó a otra clienta.
    expect(e.sender.to(tok('other'))).toHaveLength(0);
    for (const m of e.sender.to(tok('customer'))) {
      expect(m.data).toEqual({ type: 'order', orderId: order.id });
    }
  });

  it('en camino con PIN recuerda el PIN sin revelarlo; sin PIN no lo menciona', async () => {
    const withPin = await placeOrder(e, 'cash');
    const withoutPin = await placeOrder(e, 'cash');
    await setPin(e, withPin.id, '4821');
    await setPin(e, withoutPin.id, null);

    for (const order of [withPin, withoutPin]) {
      await adminTransition(e, order.id, 'picking');
      await adminTransition(e, order.id, 'packed');
      await assignDriver(e, order.id, e.ids.driver);
      expect((await driverTransition(e, order.id, 'out_for_delivery')).statusCode).toBe(200);
    }
    await settle(e);

    const onTheWay = e.sender
      .to(tok('customer'))
      .filter((m) => m.title === 'Tu pedido va en camino');
    expect(onTheWay).toHaveLength(2);
    const pinned = onTheWay.find((m) => (m.data as { orderId: string }).orderId === withPin.id)!;
    const plain = onTheWay.find((m) => (m.data as { orderId: string }).orderId === withoutPin.id)!;
    expect(pinned.body).toContain('PIN de entrega');
    expect(plain.body).not.toMatch(/PIN/);
    // Ninguna notificación de ninguna persona lleva el PIN.
    expect(JSON.stringify(e.sender.sent)).not.toContain('4821');
  });

  it('entregar sin PIN avisa de la entrega y ningún aviso lleva el motivo interno', async () => {
    const order = await placeOrder(e, 'cash');
    await adminTransition(e, order.id, 'picking');
    await adminTransition(e, order.id, 'packed');
    await assignDriver(e, order.id, e.ids.driver);
    expect((await driverTransition(e, order.id, 'out_for_delivery')).statusCode).toBe(200);
    const collect = await e.app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${order.id}/collect`,
      headers: e.headers.driver,
      payload: { amount: order.total },
    });
    expect(collect.statusCode, collect.body).toBe(200);
    await settle(e);
    e.sender.reset();

    const reason = 'Cliente sin celular, recibió el vecino del 4B';
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${order.id}/transition`,
      headers: e.headers.admin,
      payload: { to: 'delivered', pinOverrideReason: reason, note: 'Firmó doña Carmen' },
    });
    expect(res.statusCode, res.body).toBe(200);
    await settle(e);

    expect(e.sender.titles(tok('customer'))).toEqual(['¡Pedido entregado!']);
    const wire = JSON.stringify(e.sender.sent);
    expect(wire).not.toContain('vecino');
    expect(wire).not.toContain('doña Carmen');
    expect(wire).not.toContain('sin PIN');
  });

  it('asignar repartidor lo avisa a él; reasignar al mismo no repite; cambiar avisa al nuevo', async () => {
    const order = await placeOrder(e, 'cash');
    await settle(e);
    e.sender.reset();

    expect((await assignDriver(e, order.id, e.ids.driver)).statusCode).toBe(200);
    await settle(e);
    expect(e.sender.titles(tok('driver'))).toEqual(['Nuevo pedido asignado']);
    expect(e.sender.to(tok('driver'))[0]!.data).toEqual({ type: 'order', orderId: order.id });

    await assignDriver(e, order.id, e.ids.driver);
    await settle(e);
    expect(e.sender.to(tok('driver'))).toHaveLength(1);

    await assignDriver(e, order.id, e.ids.driver2);
    await settle(e);
    expect(e.sender.titles(tok('driver2'))).toEqual(['Nuevo pedido asignado']);
    expect(e.sender.to(tok('driver'))).toHaveLength(1);
  });

  it('una asignación inválida no avisa a nadie', async () => {
    const order = await placeOrder(e, 'cash');
    await settle(e);
    e.sender.reset();
    const notDriver = await assignDriver(e, order.id, e.ids.staff);
    expect(notDriver.statusCode).toBe(400);
    await settle(e);
    expect(e.sender.sent).toHaveLength(0);
  });

  it('los tokens que Expo declara muertos se limpian al enviar', async () => {
    e.sender.tickets.set(tok('admin'), { status: 'error', error: 'DeviceNotRegistered' });
    await placeOrder(e, 'cash');
    await settle(e);

    expect(await devicesOf(e, e.ids.admin)).toEqual([]);
    expect(await devicesOf(e, e.ids.staff)).toEqual([tok('staff')]);
    expect(await devicesOf(e, e.ids.customer)).toEqual([tok('customer')]);
  });

  describe('solo después de confirmarse la transacción', () => {
    /** Hace que, DESPUÉS de correr todos los hooks (incluido el de push), la transacción falle. */
    function failAfterHooks(e: Env) {
      const hooks = e.app.orderCtx.hooks!;
      const { afterCreate, afterTransition } = hooks;
      hooks.afterCreate = async (...args) => {
        await afterCreate!(...args);
        throw new Error('rollback simulado');
      };
      hooks.afterTransition = async (...args) => {
        await afterTransition!(...args);
        throw new Error('rollback simulado');
      };
      return () => Object.assign(hooks, { afterCreate, afterTransition });
    }

    it('si el pedido se crea y luego la transacción hace rollback, nadie recibe nada', async () => {
      const restore = failAfterHooks(e);
      try {
        const [cmb, before] = [
          await e.w.variant('CMB-1'),
          await e.w.handle.db.select().from(orders),
        ];
        const res = await e.app.inject({
          method: 'POST',
          url: '/v1/orders',
          headers: e.headers.customer,
          payload: {
            items: [{ variantId: cmb.id, quantity: 1 }],
            address: ADDRESS,
            slotStart: (await e.w.firstSlot()).toISOString(),
            paymentMethod: 'cash',
          },
        });
        expect(res.statusCode).toBe(500);
        await settle(e);
        expect(e.sender.sent).toHaveLength(0);
        expect(await e.w.handle.db.select().from(orders)).toHaveLength(before.length);
      } finally {
        restore();
      }
    });

    it('si el cambio de estado hace rollback, el pedido no cambia y no se avisa', async () => {
      const order = await placeOrder(e, 'cash');
      await settle(e);
      e.sender.reset();

      const restore = failAfterHooks(e);
      try {
        const res = await adminTransition(e, order.id, 'picking');
        expect(res.statusCode).toBe(500);
      } finally {
        restore();
      }
      await settle(e);

      expect(e.sender.sent).toHaveLength(0);
      const [row] = await e.w.handle.db.select().from(orders).where(eq(orders.id, order.id));
      expect(row!.status).toBe('confirmed');

      // Control: sin la falla simulada, la misma operación sí avisa.
      expect((await adminTransition(e, order.id, 'picking')).statusCode).toBe(200);
      await settle(e);
      expect(e.sender.titles(tok('customer'))).toEqual(['Estamos preparando tu pedido']);
    });

    it('un cambio rechazado por las reglas del pedido (409) tampoco avisa', async () => {
      const order = await placeOrder(e, 'cash');
      await settle(e);
      e.sender.reset();
      const res = await adminTransition(e, order.id, 'delivered');
      expect(res.statusCode).toBe(409);
      await settle(e);
      expect(e.sender.sent).toHaveLength(0);
    });
  });

  describe('un push que falla no afecta a la operación', () => {
    it('si el transporte lanza un error, el cambio de estado igual se aplica y responde 200', async () => {
      const order = await placeOrder(e, 'cash');
      await settle(e);
      e.sender.reset();
      e.sender.failure = new Error('Expo caído');

      const res = await adminTransition(e, order.id, 'picking');
      expect(res.statusCode).toBe(200);
      expect(parse(res).status).toBe('picking');
      await expect(settle(e)).resolves.toBeUndefined();

      const [row] = await e.w.handle.db.select().from(orders).where(eq(orders.id, order.id));
      expect(row!.status).toBe('picking');
      const events = await e.w.handle.db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, order.id));
      expect(events.map((x) => x.toStatus)).toEqual(
        expect.arrayContaining(['confirmed', 'picking']),
      );
    });

    it('un push lentísimo no retrasa la respuesta: sale antes de que Expo conteste', async () => {
      const order = await placeOrder(e, 'cash');
      await settle(e);
      e.sender.reset();
      let open!: () => void;
      e.sender.gate = new Promise<void>((resolve) => (open = resolve));

      const res = await adminTransition(e, order.id, 'picking');
      expect(res.statusCode).toBe(200);
      // La respuesta ya llegó y Expo todavía no ha contestado.
      expect(e.sender.sent).toHaveLength(0);

      open();
      await settle(e);
      expect(e.sender.titles(tok('customer'))).toEqual(['Estamos preparando tu pedido']);
    });
  });

  it('avisa cuando vence la reserva de un pedido sin pagar (temporizador, fuera de una petición)', async () => {
    const order = await placeOrder(e, 'card');
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const ctx = { ...e.app.orderCtx, now: () => later };

    const cancelled = await e.app.push.scope(() => expireStaleOrders(ctx));
    expect(cancelled).toBeGreaterThanOrEqual(1);
    await settle(e);

    // Cancela también los pedidos sin pagar de pruebas anteriores: se mira solo el de esta.
    const mine = e.sender
      .to(tok('customer'))
      .filter((m) => (m.data as { orderId: string }).orderId === order.id);
    expect(mine.map((m) => m.title)).toEqual(['Pedido cancelado']);
    expect(mine[0]!.data).toEqual({ type: 'order', orderId: order.id });
    // El equipo no se entera de pedidos que nunca se pagaron.
    expect(e.sender.to(tok('admin'))).toHaveLength(0);
  });

  it('la tarea periódica del servidor cancela la reserva vencida y avisa; un push caído no la rompe', async () => {
    const order = await placeOrder(e, 'card');
    e.clock.value = new Date(NOW.getTime() + 60 * 60_000); // pasó la reserva de 15 min

    const tick = await runMaintenanceTick(e.app);
    await settle(e);
    expect(tick.cancelled).toBeGreaterThanOrEqual(1);

    const [row] = await e.w.handle.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row!.status).toBe('cancelled');
    const mine = e.sender
      .to(tok('customer'))
      .filter((m) => (m.data as { orderId: string }).orderId === order.id);
    expect(mine.map((m) => m.title)).toEqual(['Pedido cancelado']);

    // Con el transporte caído la tarea termina igual y la cancelación se aplica.
    e.clock.value = NOW;
    const second = await placeOrder(e, 'transfer');
    e.clock.value = new Date(NOW.getTime() + 3 * 60 * 60_000);
    e.sender.failure = new Error('Expo caído');
    const failing = await runMaintenanceTick(e.app);
    expect(failing.cancelled).toBeGreaterThanOrEqual(1);
    await settle(e);
    const [after] = await e.w.handle.db.select().from(orders).where(eq(orders.id, second.id));
    expect(after!.status).toBe('cancelled');
  });

  it('con PUSH_ENABLED apagado no se envía nada, pero los dispositivos se siguen registrando', async () => {
    const quiet = new FakePushSender();
    const off = await buildApp({
      db: e.w.handle.db,
      config: { ...e.w.config, pushEnabled: false },
      otpSender: new MemoryOtpSender(),
      pushSender: quiet,
      now: () => NOW,
    });
    try {
      const cmb = await e.w.variant('CMB-1');
      const res = await off.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: e.headers.customer,
        payload: {
          items: [{ variantId: cmb.id, quantity: 1 }],
          address: ADDRESS,
          slotStart: (await e.w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      await off.push.drain();
      expect(quiet.sent).toHaveLength(0);
      expect(await off.push.notify([e.ids.admin], { title: 'x', body: 'y' })).toMatchObject({
        devices: 0,
      });

      const reg = await off.inject({
        method: 'POST',
        url: '/v1/me/devices',
        headers: e.headers.customer,
        payload: { token: tok('apagado'), platform: 'ios' },
      });
      expect(reg.statusCode).toBe(200);
    } finally {
      await off.close();
    }
  });
});

// ───────────────────────── el "después del commit" en sí ─────────────────────────

describe('PushService: solo se avisa de lo confirmado', () => {
  let e: Env;
  let sender: FakePushSender;
  let svc: PushService;

  beforeAll(async () => (e = await setup()));
  afterAll(() => teardown(e));
  beforeEach(async () => {
    await registerAll(e);
    sender = new FakePushSender();
    svc = new PushService({
      db: e.w.handle.db,
      config: { pushEnabled: true },
      sender,
      logger: recordingLogger().logger,
      detachedRetryDelaysMs: [1, 2, 3],
    });
  });

  /** Contexto de pedidos con los hooks de push de ESTA instancia. */
  const ctxWith = (hooks = svc.hooks) => ({ ...e.w.ctx, db: e.w.handle.db, hooks });

  async function cashOrder(ctx = e.w.ctx) {
    const cmb = await e.w.variant('CMB-1');
    return createOrder(ctx, {
      userId: e.ids.customer,
      items: [{ variantId: cmb.id, quantity: 1 }],
      address: ADDRESS,
      slotStart: await e.w.firstSlot(),
      paymentMethod: 'cash',
    });
  }

  it('con rollback tras anotar el aviso, aunque quien llama atrape el error y siga con normalidad', async () => {
    const order = await cashOrder();
    const { db } = e.w.handle;

    await svc.scope(async () => {
      try {
        await db.transaction(async (tx) => {
          await tx.update(orders).set({ status: 'picking' }).where(eq(orders.id, order.id));
          await tx.insert(orderEvents).values({
            orderId: order.id,
            fromStatus: 'confirmed',
            toStatus: 'picking',
            actorId: e.ids.admin,
            note: '',
          });
          const [row] = await tx.select().from(orders).where(eq(orders.id, order.id));
          await svc.hooks.afterTransition!(tx, row!, 'confirmed', 'picking');
          throw new Error('algo falló después del hook');
        });
      } catch {
        // El llamador lo atrapa y sigue: el aviso anotado NO debe salir.
      }
    });
    await svc.drain();

    expect(sender.sent).toHaveLength(0);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row!.status).toBe('confirmed');
  });

  it('el mismo flujo SIN rollback sí avisa (control)', async () => {
    const order = await cashOrder();
    await svc.scope(async () => {
      await e.w.handle.db.transaction(async (tx) => {
        await tx.update(orders).set({ status: 'picking' }).where(eq(orders.id, order.id));
        await tx.insert(orderEvents).values({
          orderId: order.id,
          fromStatus: 'confirmed',
          toStatus: 'picking',
          actorId: e.ids.admin,
          note: '',
        });
        const [row] = await tx.select().from(orders).where(eq(orders.id, order.id));
        await svc.hooks.afterTransition!(tx, row!, 'confirmed', 'picking');
      });
    });
    await svc.drain();
    expect(sender.titles(tok('customer'))).toEqual(['Estamos preparando tu pedido']);
  });

  it('un aviso anotado nunca sale antes de terminar la tarea: el envío ocurre después', async () => {
    const order = await cashOrder();
    let sentWhileRunning = -1;
    await svc.scope(async () => {
      await e.w.handle.db.transaction(async (tx) => {
        await tx.update(orders).set({ status: 'picking' }).where(eq(orders.id, order.id));
        await tx.insert(orderEvents).values({
          orderId: order.id,
          fromStatus: 'confirmed',
          toStatus: 'picking',
          actorId: e.ids.admin,
          note: '',
        });
        const [row] = await tx.select().from(orders).where(eq(orders.id, order.id));
        await svc.hooks.afterTransition!(tx, row!, 'confirmed', 'picking');
      });
      await new Promise((r) => setTimeout(r, 20));
      sentWhileRunning = sender.sent.length;
    });
    await svc.drain();
    expect(sentWhileRunning).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it('fuera de una petición y sin cola: avisa cuando ve el pedido confirmado', async () => {
    const order = await cashOrder(ctxWith());
    await svc.drain();
    expect(sender.titles(tok('customer'))).toEqual(['¡Pedido confirmado!']);
    expect(sender.titles(tok('admin'))).toEqual(['Nuevo pedido']);

    sender.sent.length = 0;
    await transitionOrder(ctxWith(), order.id, 'picking', { id: e.ids.admin, role: 'admin' });
    await svc.drain();
    expect(sender.titles(tok('customer'))).toEqual(['Estamos preparando tu pedido']);
  });

  it('fuera de una petición y sin cola: si hace rollback, nunca avisa', async () => {
    const order = await cashOrder();
    sender.sent.length = 0;
    const failing = {
      ...svc.hooks,
      afterTransition: async (
        ...args: Parameters<NonNullable<typeof svc.hooks.afterTransition>>
      ) => {
        await svc.hooks.afterTransition!(...args);
        throw new Error('rollback simulado');
      },
    };
    await expect(
      transitionOrder(ctxWith(failing), order.id, 'picking', { id: e.ids.admin, role: 'admin' }),
    ).rejects.toThrow('rollback simulado');
    await svc.drain();

    expect(sender.sent).toHaveLength(0);
    const [row] = await e.w.handle.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row!.status).toBe('confirmed');
  });

  it('el PIN se lee ya confirmado, aunque otro hook lo escriba después del de push', async () => {
    const order = await cashOrder();
    sender.sent.length = 0;
    const lateHook = {
      ...svc.hooks,
      afterTransition: async (
        ...args: Parameters<NonNullable<typeof svc.hooks.afterTransition>>
      ) => {
        await svc.hooks.afterTransition!(...args);
        await args[0].update(orders).set({ deliveryPin: '7392' }).where(eq(orders.id, order.id));
      },
    };
    const ctx = ctxWith(lateHook);
    await transitionOrder(ctx, order.id, 'picking', { id: e.ids.admin, role: 'admin' });
    await transitionOrder(ctx, order.id, 'packed', { id: e.ids.admin, role: 'admin' });
    await e.w.handle.db
      .update(orders)
      .set({ driverId: e.ids.driver })
      .where(eq(orders.id, order.id));
    await transitionOrder(ctx, order.id, 'out_for_delivery', { id: e.ids.driver, role: 'driver' });
    await svc.drain();

    const onTheWay = sender.to(tok('customer')).find((m) => m.title === 'Tu pedido va en camino')!;
    expect(onTheWay.body).toContain('PIN de entrega');
    expect(JSON.stringify(sender.sent)).not.toContain('7392');
  });

  it('con el transporte caído, los cambios de estado del pedido siguen funcionando', async () => {
    sender.failure = new Error('caído');
    const ctx = ctxWith();
    const order = await cashOrder(ctx);
    await svc.drain();
    const done = await transitionOrder(ctx, order.id, 'picking', {
      id: e.ids.admin,
      role: 'admin',
    });
    await svc.drain();
    expect(done.status).toBe('picking');
  });

  describe('recibos de Expo', () => {
    it('consulta recibos pasados 15 min y borra los tokens muertos', async () => {
      await svc.notify([e.ids.admin, e.ids.staff], { title: 'a', body: 'b' });
      expect(svc.pendingReceipts).toBe(2);
      const ids = ['T1', 'T2'];
      // Sin tiempo suficiente todavía: no se consulta nada.
      expect(await svc.checkReceipts(Date.now() + 14 * 60_000)).toEqual({ checked: 0, removed: 0 });
      expect(sender.receiptCalls).toHaveLength(0);

      sender.receipts = {
        [ids[0]!]: { status: 'error', error: 'DeviceNotRegistered' },
        [ids[1]!]: { status: 'ok' },
      };
      const r = await svc.checkReceipts(Date.now() + 16 * 60_000);
      expect(r).toEqual({ checked: 2, removed: 1 });
      expect(svc.pendingReceipts).toBe(0);

      const gone = sender.sent[0]!.to;
      const rows = await e.w.handle.db.select().from(deviceTokens);
      expect(rows.map((x) => x.token)).not.toContain(gone);
      expect(rows.map((x) => x.token)).toContain(sender.sent[1]!.to);
    });

    it('un recibo que aún no está disponible se vuelve a pedir después', async () => {
      await svc.notify([e.ids.admin], { title: 'a', body: 'b' });
      const r = await svc.checkReceipts(Date.now() + 16 * 60_000);
      expect(r).toEqual({ checked: 0, removed: 0 });
      expect(svc.pendingReceipts).toBe(1);
      // Pasadas 24 h sin recibo, se descarta.
      await svc.checkReceipts(Date.now() + 25 * 60 * 60_000);
      expect(svc.pendingReceipts).toBe(0);
    });
  });
});

// ───────────────────────── configuración y cableado de producción ─────────────────────────

describe('config: PUSH_ENABLED y EXPO_ACCESS_TOKEN', () => {
  it('sin PUSH_ENABLED el push está activo, salvo en pruebas', () => {
    expect(loadConfig({}).pushEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: 'development' }).pushEnabled).toBe(true);
    expect(loadConfig({ NODE_ENV: 'test' }).pushEnabled).toBe(false);
  });

  it('PUSH_ENABLED manda sobre el valor por defecto, en cualquier entorno', () => {
    for (const on of ['1', 'true', 'TRUE', ' true ']) {
      expect(loadConfig({ NODE_ENV: 'test', PUSH_ENABLED: on }).pushEnabled, on).toBe(true);
    }
    for (const off of ['0', 'false', 'False']) {
      expect(loadConfig({ PUSH_ENABLED: off }).pushEnabled, off).toBe(false);
    }
  });

  it('un valor ambiguo no se adivina: el arranque falla con un mensaje claro', () => {
    expect(() => loadConfig({ PUSH_ENABLED: 'quizás' })).toThrow(/PUSH_ENABLED debe ser 1\/0/);
  });

  it('EXPO_ACCESS_TOKEN es opcional y se recorta; vacío cuenta como ausente', () => {
    expect(loadConfig({}).expoAccessToken).toBeNull();
    expect(loadConfig({ EXPO_ACCESS_TOKEN: '   ' }).expoAccessToken).toBeNull();
    expect(loadConfig({ EXPO_ACCESS_TOKEN: '  abc123  ' }).expoAccessToken).toBe('abc123');
  });
});

describe('registros de acceso: sin tokens', () => {
  it('redactUrl oculta el token de la ruta y del query, y no toca el resto', () => {
    expect(redactUrl('/v1/me/devices/ExponentPushToken%5Babcd1234%5D')).toBe(
      '/v1/me/devices/:token',
    );
    expect(redactUrl('/v1/me/devices/ExponentPushToken[abcd1234]?x=1')).toBe(
      '/v1/me/devices/:token?x=1',
    );
    expect(redactUrl('/v1/payments/p1/redirect?token=abc.def&lang=es')).toBe(
      '/v1/payments/p1/redirect?token=:token&lang=es',
    );
    expect(redactUrl('/v1/orders?status=confirmed&limit=5')).toBe(
      '/v1/orders?status=confirmed&limit=5',
    );
    expect(redactUrl('/v1/me/devices')).toBe('/v1/me/devices');
  });

  it('el log de la app no guarda el token de DELETE /v1/me/devices/:token', async () => {
    const w = await makeWorld({ pushEnabled: true });
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      pushSender: new FakePushSender(),
      now: () => NOW,
      logger: { stream },
    });
    try {
      const headers = {
        authorization: `Bearer ${app.jwt.sign({ sub: w.customerId, role: 'customer' })}`,
      };
      const token = tok('secretolog');
      const reg = await app.inject({
        method: 'POST',
        url: '/v1/me/devices',
        headers,
        payload: { token, platform: 'ios' },
      });
      expect(reg.statusCode).toBe(200);
      const del = await app.inject({
        method: 'DELETE',
        url: `/v1/me/devices/${encodeURIComponent(token)}`,
        headers,
      });
      expect(del.statusCode).toBe(204);

      const log = lines.join('');
      // El registro existe y trae la ruta (sin el token)...
      expect(log).toContain('"method":"DELETE"');
      expect(log).toContain('/v1/me/devices/:token');
      // ...pero el token no aparece de ninguna forma.
      expect(log).not.toContain('secretolog');
    } finally {
      await app.close();
      await w.close();
    }
  });
});

describe('sin transporte inyectado: Expo real con el token de la configuración', () => {
  let w: World;
  let fetchSpy: ReturnType<typeof vi.fn>;
  const registered = { customer: tok('cliente'), admin: tok('admin') };

  beforeAll(async () => {
    w = await makeWorld({
      windows: ROOMY,
      pushEnabled: true,
      expoAccessToken: 'expo-token-prueba',
    });
    await w.handle.db.update(variants).set({ onHand: 10_000 });
    await w.handle.db.insert(deviceTokens).values([
      { userId: w.customerId, token: registered.customer, platform: 'ios' },
      { userId: w.adminId, token: registered.admin, platform: 'android' },
    ]);
  });
  afterAll(() => w.close());

  beforeEach(() => {
    fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const batch = JSON.parse(init.body as string) as PushMessage[];
      return json({ data: batch.map((_, i) => ({ status: 'ok', id: `id-${i}` })) });
    });
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function cashOrder(app: FastifyInstance) {
    const cmb = await w.variant('CMB-1');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: w.customerId, role: 'customer' })}` },
      payload: {
        items: [{ variantId: cmb.id, quantity: 1 }],
        address: ADDRESS,
        slotStart: (await w.firstSlot()).toISOString(),
        paymentMethod: 'cash',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    await app.push.drain();
  }

  it('un pedido confirmado llega a Expo: URL oficial, Bearer y los dispositivos correctos', async () => {
    const app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      now: () => NOW,
    });
    try {
      await cashOrder(app);

      expect(fetchSpy).toHaveBeenCalled();
      const sentTo: string[] = [];
      for (const [url, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
        expect(url).toBe(EXPO_PUSH_URL);
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ Authorization: 'Bearer expo-token-prueba' });
        sentTo.push(...(JSON.parse(init.body as string) as PushMessage[]).map((m) => m.to));
      }
      expect(sentTo.sort()).toEqual([registered.admin, registered.customer].sort());
    } finally {
      await app.close();
    }
  });

  it('sin EXPO_ACCESS_TOKEN no manda cabecera Authorization', async () => {
    const app = await buildApp({
      db: w.handle.db,
      config: { ...w.config, expoAccessToken: null },
      otpSender: new MemoryOtpSender(),
      now: () => NOW,
    });
    try {
      await cashOrder(app);
      expect(fetchSpy).toHaveBeenCalled();
      for (const [, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
        expect(init.headers).not.toHaveProperty('Authorization');
      }
    } finally {
      await app.close();
    }
  });

  it('si Expo no contesta, el pedido igual se crea y la respuesta no se retrasa', async () => {
    // El `fetch` global queda colgado hasta que la prueba lo suelte: la API no debe esperarlo.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal('fetch', async () => {
      await gate;
      throw new TypeError('fetch failed');
    });
    const app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      now: () => NOW,
    });
    try {
      const cmb = await w.variant('CMB-1');
      const started = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: {
          authorization: `Bearer ${app.jwt.sign({ sub: w.customerId, role: 'customer' })}`,
        },
        payload: {
          items: [{ variantId: cmb.id, quantity: 1 }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await app.close();
    }
  });
});

describe('ExpoPushSender con sockets reales (servidor local)', () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function localServer(handler: (body: string, res: ServerResponse, n: number) => void) {
    const seen: { headers: IncomingMessage['headers']; url?: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ headers: req.headers, url: req.url, body });
        handler(body, res, seen.length);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const handle = {
      seen,
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
    servers.push(handle);
    return handle;
  }

  const viaLocal =
    (base: string) =>
    (url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      fetch(String(url).replace('https://exp.host', base), init);

  const m = (n: number): PushMessage => ({ to: tok(`real${n}`), title: `t${n}`, body: `b${n}` });

  it('lo que sale por el cable: POST JSON con Bearer, y los tickets vuelven en orden', async () => {
    const srv = await localServer((body, res) => {
      const batch = JSON.parse(body) as PushMessage[];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: batch.map((x, i) =>
            i === 1
              ? {
                  status: 'error',
                  message: 'no registrado',
                  details: { error: 'DeviceNotRegistered' },
                }
              : { status: 'ok', id: `id-${x.title}` },
          ),
        }),
      );
    });
    const sender = new ExpoPushSender({
      accessToken: 'expo-token-prueba',
      fetch: viaLocal(srv.base),
      logger: recordingLogger().logger,
    });
    const tickets = await sender.send([m(1), m(2), m(3)]);

    expect(srv.seen).toHaveLength(1);
    expect(srv.seen[0]!.url).toBe('/--/api/v2/push/send');
    expect(srv.seen[0]!.headers.authorization).toBe('Bearer expo-token-prueba');
    expect(srv.seen[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(srv.seen[0]!.body)).toEqual([m(1), m(2), m(3)]);
    expect(tickets).toEqual([
      { status: 'ok', id: 'id-t1' },
      { status: 'error', error: 'DeviceNotRegistered', message: 'no registrado' },
      { status: 'ok', id: 'id-t3' },
    ]);
  });

  it('un servidor que no contesta se corta por plazo y devuelve tickets de error, sin lanzar', async () => {
    const srv = await localServer(() => {
      /* nunca responde */
    });
    const sender = new ExpoPushSender({
      fetch: viaLocal(srv.base),
      timeoutMs: 150,
      sleep: async () => {},
      logger: recordingLogger().logger,
    });
    const started = Date.now();
    const tickets = await sender.send([m(1), m(2)]);

    expect(tickets.map((t) => t.error)).toEqual(['TransportError', 'TransportError']);
    expect(srv.seen).toHaveLength(2); // el original y su único reintento
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
