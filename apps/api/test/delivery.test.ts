import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ORDER_STATUSES, type OrderStatus } from '@jellyfish/shared';
import { buildApp } from '../src/app';
import { driverLocations, orderEvents, orders, users, variants } from '../src/db/schema';
import { MemoryOtpSender } from '../src/services/auth';
import {
  DRIVER_VIEWER,
  INTERNAL_VIEWER,
  PIN_MAX_ATTEMPTS,
  PIN_VISIBLE_STATUSES,
  deliveryFieldsFor,
  generateDeliveryPin,
  isPinFailureEvent,
  recordDriverLocation,
  timelineFor,
} from '../src/services/delivery';
import { getOrder, transitionOrder, viewerForActor } from '../src/services/orders';
import { ADDRESS, NOW, type World, makeWorld } from './helpers';

type Headers = { authorization: string };
const json = (res: { body: string }) => JSON.parse(res.body);

const SD = { latitude: 18.4861, longitude: -69.9312 }; // Santo Domingo
const SANTIAGO = { latitude: 19.4517, longitude: -70.697 };

interface Env {
  w: World;
  app: FastifyInstance;
  clock: { now: Date };
  customer: Headers;
  other: Headers;
  admin: Headers;
  staff: Headers;
  driver: Headers;
  driver2: Headers;
  otherId: string;
  driver2Id: string;
}

/**
 * Cada prueba usa un API nuevo sobre la misma base: así el límite global de 300 peticiones por
 * minuto (que sí existe en producción) no se agota con las decenas de pedidos que crea este archivo.
 */
const newApp = (w: World, clock: { now: Date }) =>
  buildApp({
    db: w.handle.db,
    config: w.config,
    otpSender: new MemoryOtpSender(),
    now: () => clock.now,
  });

async function setup(): Promise<Env> {
  // Capacidad grande: estas pruebas crean decenas de pedidos en la misma franja.
  const w = await makeWorld({
    windows: {
      startHour: 10,
      endHour: 20,
      windowHours: 2,
      capacityPerWindow: 1000,
      leadMinutes: 90,
      daysAhead: 3,
    },
  });
  const db = w.handle.db;
  await db.update(variants).set({ onHand: 1_000_000 }).where(eq(variants.sku, 'POL-1'));
  const [other, staff, driver2] = await db
    .insert(users)
    .values([
      { phone: '+18095550011', name: 'Otra Cliente', role: 'customer' },
      { phone: '+18095550012', name: 'Personal', role: 'staff' },
      { phone: '+18095550013', name: 'Otro Motorista', role: 'driver' },
    ])
    .returning({ id: users.id });
  const clock = { now: new Date(NOW) };
  const app = await newApp(w, clock);
  const auth = (id: string, role: 'customer' | 'admin' | 'staff' | 'driver') => ({
    authorization: `Bearer ${app.jwt.sign({ sub: id, role })}`,
  });
  return {
    w,
    app,
    clock,
    customer: auth(w.customerId, 'customer'),
    other: auth(other!.id, 'customer'),
    admin: auth(w.adminId, 'admin'),
    staff: auth(staff!.id, 'staff'),
    driver: auth(w.driverId, 'driver'),
    driver2: auth(driver2!.id, 'driver'),
    otherId: other!.id,
    driver2Id: driver2!.id,
  };
}

const inject = (
  e: Env,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  headers?: Headers | null,
  payload?: unknown,
) =>
  e.app.inject({
    method,
    url,
    headers: headers ?? undefined,
    payload: payload as object | undefined,
  });

async function place(
  e: Env,
  opts: {
    method?: 'cash' | 'transfer';
    headers?: Headers;
    sku?: string;
    qty?: number;
    address?: object;
    addressId?: string;
  } = {},
) {
  const v = await e.w.variant(opts.sku ?? 'POL-1');
  const res = await inject(e, 'POST', '/v1/orders', opts.headers ?? e.customer, {
    items: [{ variantId: v.id, quantity: opts.qty ?? 500 }],
    ...(opts.addressId ? { addressId: opts.addressId } : { address: opts.address ?? ADDRESS }),
    slotStart: (await e.w.firstSlot()).toISOString(),
    paymentMethod: opts.method ?? 'cash',
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res);
}

const adminStep = (e: Env, id: string, to: string, extra: object = {}, headers = e.admin) =>
  inject(e, 'POST', `/v1/admin/orders/${id}/transition`, headers, { to, ...extra });

/** confirmed → picking → packed → (asignado) → out_for_delivery, siempre por la API. */
async function toPacked(e: Env, order: { id: string; items: { id: string }[] }, driverId?: string) {
  expect((await adminStep(e, order.id, 'picking')).statusCode).toBe(200);
  const weigh = await inject(e, 'POST', `/v1/admin/orders/${order.id}/weights`, e.admin, {
    weights: order.items.map((i) => ({ itemId: i.id, finalQuantity: 500 })),
  });
  expect(weigh.statusCode, weigh.body).toBe(200);
  expect((await adminStep(e, order.id, 'packed')).statusCode).toBe(200);
  const assign = await inject(e, 'POST', `/v1/admin/orders/${order.id}/assign-driver`, e.admin, {
    driverId: driverId ?? e.w.driverId,
  });
  expect(assign.statusCode, assign.body).toBe(200);
}

async function toOut(e: Env, order: { id: string; items: { id: string }[] }, driverId?: string) {
  await toPacked(e, order, driverId);
  const res = await adminStep(e, order.id, 'out_for_delivery');
  expect(res.statusCode, res.body).toBe(200);
}

const driverStep = (e: Env, id: string, body: object, headers = e.driver) =>
  inject(e, 'POST', `/v1/driver/orders/${id}/transition`, headers, body);

async function collectCash(e: Env, id: string) {
  const o = json(await inject(e, 'GET', `/v1/admin/orders/${id}`, e.admin));
  const res = await inject(e, 'POST', `/v1/driver/orders/${id}/collect`, e.driver, {
    amount: o.finalTotal ?? o.total,
  });
  expect(res.statusCode, res.body).toBe(200);
}

const row = async (e: Env, id: string) =>
  (await e.w.handle.db.select().from(orders).where(eq(orders.id, id)))[0]!;
const events = (e: Env, id: string) =>
  e.w.handle.db.select().from(orderEvents).where(eq(orderEvents.orderId, id));
const locationRows = (e: Env) => e.w.handle.db.select().from(driverLocations);
const wrongPinFor = (pin: string) => (pin === '7391' ? '2468' : '7391');

/** Todos los valores que cuelgan de una clave con ese nombre, en cualquier parte del JSON. */
function valuesOfKey(node: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => valuesOfKey(n, key, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      valuesOfKey(v, key, out);
    }
  }
  return out;
}

let e: Env;
beforeAll(async () => (e = await setup()));
afterAll(async () => {
  await e.app.close();
  await e.w.close();
});
beforeEach(async () => {
  e.clock.now = new Date(NOW);
  await e.app.close();
  e.app = await newApp(e.w, e.clock);
});

// ───────────────────────── A) PIN: quién lo ve ─────────────────────────

describe('PIN de entrega: visibilidad', () => {
  it('se genera al crear el pedido: 4 dígitos, guardado, y el dueño lo recibe al confirmarse', async () => {
    const order = await place(e);
    expect(order.status).toBe('confirmed');
    expect(order.deliveryPin).toMatch(/^\d{4}$/);
    expect(order.pinRequired).toBe(true);
    expect(order.pinAttemptsLeft).toBe(PIN_MAX_ATTEMPTS);
    expect((await row(e, order.id)).deliveryPin).toBe(order.deliveryPin);
  });

  it('generateDeliveryPin da siempre 4 dígitos (con ceros a la izquierda) y no es constante', () => {
    const pins = Array.from({ length: 400 }, () => generateDeliveryPin());
    expect(pins.every((p) => /^\d{4}$/.test(p))).toBe(true);
    expect(new Set(pins).size).toBeGreaterThan(300);
    expect(pins.some((p) => p.startsWith('0'))).toBe(true);
  });

  it('un pedido a la espera de pago lleva PIN guardado pero el cliente aún no lo ve', async () => {
    const order = await place(e, { method: 'transfer' });
    expect(order.status).toBe('pending_payment');
    expect(order.deliveryPin).toBeNull();
    expect((await row(e, order.id)).deliveryPin).toMatch(/^\d{4}$/);

    const paid = await inject(
      e,
      'POST',
      `/v1/admin/payments/${order.payments[0].id}/mark-paid`,
      e.admin,
      { reference: 'BPD-123456' },
    );
    expect(paid.statusCode, paid.body).toBe(200);
    const seen = json(await inject(e, 'GET', `/v1/orders/${order.id}`, e.customer));
    expect(seen.status).toBe('confirmed');
    expect(seen.deliveryPin).toBe((await row(e, order.id)).deliveryPin);
  });

  it('solo en confirmado, preparación, empacado, en camino y entrega fallida (matriz completa)', () => {
    const base = {
      userId: 'cliente',
      deliveryPin: '4821',
      pinVerifiedAt: null,
      pinOverrideReason: null,
    };
    const visibleFor = (status: OrderStatus, viewer: Parameters<typeof deliveryFieldsFor>[2]) =>
      deliveryFieldsFor({ ...base, status }, [], viewer).deliveryPin;
    const owner = { role: 'customer', userId: 'cliente' } as const;
    const stranger = { role: 'customer', userId: 'otra-persona' } as const;

    const shown = ORDER_STATUSES.filter((s) => visibleFor(s, owner) === '4821');
    expect([...shown].sort()).toEqual(
      ['confirmed', 'picking', 'packed', 'out_for_delivery', 'delivery_failed'].sort(),
    );
    expect([...PIN_VISIBLE_STATUSES].sort()).toEqual([...shown].sort());
    for (const status of ORDER_STATUSES) {
      expect(visibleFor(status, INTERNAL_VIEWER)).toBeNull();
      expect(visibleFor(status, stranger)).toBeNull();
    }
  });

  it('por la API el dueño lo ve en cada paso hasta la entrega y deja de verlo al entregarse', async () => {
    const order = await place(e);
    const pin = order.deliveryPin as string;
    const asOwner = async () => json(await inject(e, 'GET', `/v1/orders/${order.id}`, e.customer));

    expect((await asOwner()).deliveryPin).toBe(pin); // confirmed
    await adminStep(e, order.id, 'picking');
    expect(await asOwner()).toMatchObject({ status: 'picking', deliveryPin: pin });
    await inject(e, 'POST', `/v1/admin/orders/${order.id}/weights`, e.admin, {
      weights: [{ itemId: order.items[0].id, finalQuantity: 500 }],
    });
    await adminStep(e, order.id, 'packed');
    expect(await asOwner()).toMatchObject({ status: 'packed', deliveryPin: pin });
    await inject(e, 'POST', `/v1/admin/orders/${order.id}/assign-driver`, e.admin, {
      driverId: e.w.driverId,
    });
    await adminStep(e, order.id, 'out_for_delivery');
    expect(await asOwner()).toMatchObject({ status: 'out_for_delivery', deliveryPin: pin });

    expect((await driverStep(e, order.id, { to: 'delivery_failed' })).statusCode).toBe(200);
    expect(await asOwner()).toMatchObject({ status: 'delivery_failed', deliveryPin: pin });

    expect((await adminStep(e, order.id, 'out_for_delivery')).statusCode).toBe(200);
    await collectCash(e, order.id);
    expect((await driverStep(e, order.id, { to: 'delivered', pin })).statusCode).toBe(200);
    expect(await asOwner()).toMatchObject({ status: 'delivered', deliveryPin: null });
  });

  it('un pedido cancelado tampoco muestra el PIN', async () => {
    const order = await place(e);
    expect(order.deliveryPin).toBeTruthy();
    const res = await inject(e, 'POST', `/v1/orders/${order.id}/cancel`, e.customer, {});
    expect(json(res)).toMatchObject({ status: 'cancelled', deliveryPin: null });
    expect(
      json(await inject(e, 'GET', `/v1/orders/${order.id}`, e.customer)).deliveryPin,
    ).toBeNull();
  });

  it('el repartidor, el personal y el administrador nunca lo reciben, en ninguna ruta ni listado', async () => {
    const order = await place(e);
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;

    const responses = [
      await inject(e, 'GET', '/v1/driver/orders', e.driver),
      await inject(e, 'GET', `/v1/admin/orders/${order.id}`, e.admin),
      await inject(e, 'GET', `/v1/admin/orders/${order.id}`, e.staff),
      await inject(e, 'GET', '/v1/admin/orders?limit=200', e.admin),
      await inject(e, 'GET', '/v1/admin/orders?limit=200', e.staff),
      // respuestas que devuelven el pedido tras una acción del repartidor o del personal
      await driverStep(e, order.id, { to: 'delivery_failed' }),
    ];
    for (const res of responses) {
      expect(res.statusCode, res.body).toBe(200);
      const keys = valuesOfKey(json(res), 'deliveryPin');
      expect(keys.length).toBeGreaterThan(0); // el campo viaja...
      expect(keys.every((v) => v === null)).toBe(true); // ...siempre vacío
    }
    // y el valor real no aparece en ningún lado de esas respuestas
    for (const res of responses) expect(res.body).not.toContain(`"${pin}"`);

    // el cobro del repartidor también devuelve el pedido completo
    await adminStep(e, order.id, 'out_for_delivery');
    const collected = await inject(e, 'POST', `/v1/driver/orders/${order.id}/collect`, e.driver, {
      amount: json(await inject(e, 'GET', `/v1/admin/orders/${order.id}`, e.admin)).finalTotal,
    });
    expect(collected.statusCode, collected.body).toBe(200);
    expect(valuesOfKey(json(collected), 'deliveryPin').every((v) => v === null)).toBe(true);
  });

  it('otro cliente no ve el pedido ni el PIN, y su listado solo trae lo suyo', async () => {
    const mine = await place(e);
    const hers = await place(e, { headers: e.other });
    expect(hers.deliveryPin).toMatch(/^\d{4}$/);

    expect((await inject(e, 'GET', `/v1/orders/${mine.id}`, e.other)).statusCode).toBe(404);
    const herList = await inject(e, 'GET', '/v1/orders', e.other);
    expect(herList.body).not.toContain(mine.id);
    expect(herList.body).not.toContain(`"${mine.deliveryPin}"`);
    for (const o of json(herList)) expect(o.userId).toBe(e.otherId);

    const myList = json(await inject(e, 'GET', '/v1/orders', e.customer));
    expect(myList.find((o: { id: string }) => o.id === mine.id).deliveryPin).toBe(mine.deliveryPin);
  });

  it('un pedido anterior al PIN (deliveryPin null) no lo exige ni lo muestra', async () => {
    const order = await place(e);
    await e.w.handle.db.update(orders).set({ deliveryPin: null }).where(eq(orders.id, order.id));
    const seen = json(await inject(e, 'GET', `/v1/orders/${order.id}`, e.customer));
    expect(seen).toMatchObject({ deliveryPin: null, pinRequired: false, pinAttemptsLeft: null });

    await toOut(e, order);
    await collectCash(e, order.id);
    // sin PIN en el pedido, el repartidor entrega como siempre
    expect((await driverStep(e, order.id, { to: 'delivered' })).statusCode).toBe(200);
  });
});

// ───────────────────────── A) PIN: entrega del repartidor ─────────────────────────

describe('PIN de entrega: repartidor', () => {
  async function outForDelivery(method: 'cash' | 'transfer' = 'cash') {
    const order = await place(e, { method });
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;
    await collectCash(e, order.id);
    return { id: order.id, pin, wrong: wrongPinFor(pin) };
  }
  const attemptsLeft = async (id: string) =>
    json(await inject(e, 'GET', '/v1/driver/orders', e.driver)).find(
      (o: { id: string }) => o.id === id,
    ).pinAttemptsLeft;

  it('sin PIN no se entrega: error claro y no gasta un intento', async () => {
    const o = await outForDelivery();
    const res = await driverStep(e, o.id, { to: 'delivered' });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe('pin_required');
    expect(json(res).error.message).toMatch(/PIN/);
    expect((await row(e, o.id)).status).toBe('out_for_delivery');
    expect(await attemptsLeft(o.id)).toBe(PIN_MAX_ATTEMPTS);
  });

  it('un PIN mal escrito (letras o menos de 4 dígitos) se rechaza sin contarlo como intento', async () => {
    const o = await outForDelivery();
    for (const bad of ['12', 'abcd', '12345', '1 34']) {
      const res = await driverStep(e, o.id, { to: 'delivered', pin: bad });
      expect(res.statusCode, bad).toBe(400);
      expect(json(res).error.code).toBe('validation');
    }
    expect(await attemptsLeft(o.id)).toBe(PIN_MAX_ATTEMPTS);
  });

  it('un PIN equivocado se rechaza, descuenta un intento y queda en el historial sin el número tecleado', async () => {
    const o = await outForDelivery();
    const res = await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toMatchObject({
      code: 'pin_incorrect',
      details: { attemptsLeft: PIN_MAX_ATTEMPTS - 1 },
    });
    expect(json(res).error.message).toMatch(/PIN incorrecto/);

    expect((await row(e, o.id)).status).toBe('out_for_delivery');
    expect((await row(e, o.id)).pinVerifiedAt).toBeNull();
    expect(await attemptsLeft(o.id)).toBe(PIN_MAX_ATTEMPTS - 1);

    const failures = (await events(e, o.id)).filter(isPinFailureEvent);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.note).toBe(`PIN incorrecto (intento 1 de ${PIN_MAX_ATTEMPTS})`);
    expect(failures[0]!.actorId).toBe(e.w.driverId);
    expect(JSON.stringify(await events(e, o.id))).not.toContain(o.wrong);
  });

  it('con el PIN correcto se entrega, se registra la verificación y el PIN se oculta', async () => {
    const o = await outForDelivery();
    await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
    const res = await driverStep(e, o.id, { to: 'delivered', pin: o.pin });
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ status: 'delivered', deliveryPin: null, pinOverrideReason: null });
    expect(body.pinVerifiedAt).toBe(NOW.toISOString());
    expect(body.deliveredAt).toBe(NOW.toISOString());
    const last = body.timeline[body.timeline.length - 1];
    expect(last).toMatchObject({
      toStatus: 'delivered',
      note: 'Entrega confirmada con el PIN del cliente',
    });
  });

  it('tras 5 fallos el pedido queda bloqueado, incluso con el PIN correcto', async () => {
    const o = await outForDelivery();
    const codes: [number, string][] = [];
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      const res = await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
      codes.push([res.statusCode, json(res).error.code]);
    }
    expect(codes).toEqual([
      [409, 'pin_incorrect'],
      [409, 'pin_incorrect'],
      [409, 'pin_incorrect'],
      [409, 'pin_incorrect'],
      [423, 'pin_locked'],
    ]);
    expect((await events(e, o.id)).filter(isPinFailureEvent)).toHaveLength(PIN_MAX_ATTEMPTS);
    expect(await attemptsLeft(o.id)).toBe(0);

    const late = await driverStep(e, o.id, { to: 'delivered', pin: o.pin });
    expect(late.statusCode).toBe(423);
    expect(json(late).error.code).toBe('pin_locked');
    expect(json(late).error.message).toMatch(/administraci/);
    expect((await row(e, o.id)).status).toBe('out_for_delivery');
    // bloqueado no es una puerta para seguir escribiendo eventos
    expect((await events(e, o.id)).filter(isPinFailureEvent)).toHaveLength(PIN_MAX_ATTEMPTS);
    // y no bloquea otras acciones del repartidor sobre el pedido (p. ej. reportar entrega fallida)
    expect((await driverStep(e, o.id, { to: 'delivery_failed' })).statusCode).toBe(200);
  });

  it('el bloqueo vive en la base de datos: sobrevive a un reinicio del API', async () => {
    const o = await outForDelivery();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
    }
    const restarted = await buildApp({
      db: e.w.handle.db,
      config: e.w.config,
      otpSender: new MemoryOtpSender(),
      now: () => e.clock.now,
    });
    const token = `Bearer ${restarted.jwt.sign({ sub: e.w.driverId, role: 'driver' })}`;
    const res = await restarted.inject({
      method: 'POST',
      url: `/v1/driver/orders/${o.id}/transition`,
      headers: { authorization: token },
      payload: { to: 'delivered', pin: o.pin },
    });
    expect(res.statusCode).toBe(423);
    await restarted.close();
  });

  it('intentos que llegan a la vez no pueden pasar del límite', async () => {
    const o = await outForDelivery();
    const results = await Promise.all(
      Array.from({ length: 9 }, () => driverStep(e, o.id, { to: 'delivered', pin: o.wrong })),
    );
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(PIN_MAX_ATTEMPTS - 1);
    expect(results.filter((r) => r.statusCode === 423)).toHaveLength(9 - (PIN_MAX_ATTEMPTS - 1));
    expect((await events(e, o.id)).filter(isPinFailureEvent)).toHaveLength(PIN_MAX_ATTEMPTS);
  });

  it('la cuenta es por pedido: bloquear uno no afecta a otro', async () => {
    const a = await outForDelivery();
    const b = await outForDelivery();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await driverStep(e, a.id, { to: 'delivered', pin: a.wrong });
    }
    expect((await driverStep(e, a.id, { to: 'delivered', pin: a.pin })).statusCode).toBe(423);
    expect((await driverStep(e, b.id, { to: 'delivered', pin: b.pin })).statusCode).toBe(200);
  });

  it('otro repartidor no puede ni probar el PIN de un pedido ajeno', async () => {
    const o = await outForDelivery();
    const res = await driverStep(e, o.id, { to: 'delivered', pin: o.pin }, e.driver2);
    expect(res.statusCode).toBe(403);
    expect((await events(e, o.id)).filter(isPinFailureEvent)).toHaveLength(0);
    expect((await row(e, o.id)).status).toBe('out_for_delivery');
  });

  it('sin el efectivo cobrado no se prueba el PIN: el cobro exacto sigue mandando', async () => {
    const order = await place(e);
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;

    // efectivo sin cobrar: 409 cash_not_collected, con PIN bueno o malo, y sin gastar intentos
    for (const p of [pin, wrongPinFor(pin)]) {
      const res = await driverStep(e, order.id, { to: 'delivered', pin: p });
      expect(res.statusCode).toBe(409);
      expect(json(res).error.code).toBe('cash_not_collected');
    }
    expect((await events(e, order.id)).filter(isPinFailureEvent)).toHaveLength(0);

    // cobro con monto incorrecto sigue rechazado como antes
    const due = json(await inject(e, 'GET', `/v1/admin/orders/${order.id}`, e.admin)).finalTotal;
    const bad = await inject(e, 'POST', `/v1/driver/orders/${order.id}/collect`, e.driver, {
      amount: due - 1,
    });
    expect(json(bad).error.code).toBe('wrong_amount');

    await collectCash(e, order.id);
    expect(
      (await driverStep(e, order.id, { to: 'delivered', pin: wrongPinFor(pin) })).statusCode,
    ).toBe(409);
    const ok = await driverStep(e, order.id, { to: 'delivered', pin });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(json(ok).status).toBe('delivered');
  });

  it('la regla vive en el servicio, no solo en la ruta: sin PIN no se entrega por ninguna vía', async () => {
    const o = await outForDelivery();
    await expect(
      transitionOrder(e.app.orderCtx, o.id, 'delivered', { id: e.w.driverId, role: 'driver' }),
    ).rejects.toMatchObject({ code: 'pin_required' });
    await expect(
      transitionOrder(e.app.orderCtx, o.id, 'delivered', { id: e.w.adminId, role: 'admin' }),
    ).rejects.toMatchObject({ code: 'pin_override_required' });
    await expect(
      transitionOrder(e.app.orderCtx, o.id, 'delivered', { id: null, role: 'system' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect((await row(e, o.id)).status).toBe('out_for_delivery');
  });

  it('entrega fallida y reintento: los intentos siguen contando para el mismo pedido', async () => {
    const o = await outForDelivery();
    await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
    await driverStep(e, o.id, { to: 'delivered', pin: o.wrong });
    expect((await driverStep(e, o.id, { to: 'delivery_failed' })).statusCode).toBe(200);
    expect((await adminStep(e, o.id, 'out_for_delivery')).statusCode).toBe(200);
    expect(await attemptsLeft(o.id)).toBe(PIN_MAX_ATTEMPTS - 2);
    expect((await driverStep(e, o.id, { to: 'delivered', pin: o.pin })).statusCode).toBe(200);
  });
});

// ───────────────────────── A) PIN: anulación del administrador ─────────────────────────

describe('PIN de entrega: anulación del personal', () => {
  async function blockedOrder() {
    const order = await place(e);
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;
    await collectCash(e, order.id);
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await driverStep(e, order.id, { to: 'delivered', pin: wrongPinFor(pin) });
    }
    return { id: order.id, pin };
  }

  it('sin motivo (o con motivo corto) no se puede entregar sin PIN', async () => {
    const o = await blockedOrder();
    const none = await adminStep(e, o.id, 'delivered');
    expect(none.statusCode).toBe(400);
    expect(json(none).error.code).toBe('pin_override_required');
    expect(json(none).error.message).toMatch(/motivo/);
    for (const reason of ['', '   ', 'corto', '1234567', '   ab   ']) {
      const res = await adminStep(e, o.id, 'delivered', { pinOverrideReason: reason });
      expect(res.statusCode, reason).toBe(400);
      expect(json(res).error.code).toBe('pin_override_required');
    }
    expect((await row(e, o.id)).status).toBe('out_for_delivery');
  });

  it('el administrador manda el PIN en vez del motivo: tampoco basta (no tiene por qué saberlo)', async () => {
    const o = await blockedOrder();
    const res = await adminStep(e, o.id, 'delivered', { pin: o.pin });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe('pin_override_required');
  });

  it('con un motivo de 8+ caracteres entrega, aun con el pedido bloqueado, y queda registrado', async () => {
    const o = await blockedOrder();
    const reason = '  Cliente sin teléfono, confirmado por llamada  ';
    const res = await adminStep(e, o.id, 'delivered', { pinOverrideReason: reason });
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({
      status: 'delivered',
      deliveryPin: null,
      pinOverrideReason: 'Cliente sin teléfono, confirmado por llamada',
      pinVerifiedAt: null,
    });
    expect((await row(e, o.id)).pinOverrideReason).toBe(
      'Cliente sin teléfono, confirmado por llamada',
    );
    const last = body.timeline[body.timeline.length - 1];
    expect(last.toStatus).toBe('delivered');
    expect(last.note).toBe(
      'Entrega sin PIN autorizada: Cliente sin teléfono, confirmado por llamada',
    );
    expect((await events(e, o.id)).find((ev) => ev.toStatus === 'delivered')!.actorId).toBe(
      e.w.adminId,
    );
    // el cliente no recibe el motivo interno
    const mine = json(await inject(e, 'GET', `/v1/orders/${o.id}`, e.customer));
    expect(mine).toMatchObject({ status: 'delivered', pinOverrideReason: null });
  });

  it('el personal (staff) también puede anular, y su nota se suma al motivo', async () => {
    const order = await place(e);
    await toOut(e, order);
    await collectCash(e, order.id);
    const res = await adminStep(
      e,
      order.id,
      'delivered',
      { pinOverrideReason: 'El cliente perdió el PIN', note: 'Lo recibió su hermana' },
      e.staff,
    );
    expect(res.statusCode, res.body).toBe(200);
    const last = json(res).timeline.at(-1);
    expect(last.note).toBe(
      'Entrega sin PIN autorizada: El cliente perdió el PIN. Lo recibió su hermana',
    );
  });

  it('la anulación no salta el cobro en efectivo: sin cobro exacto sigue siendo 409', async () => {
    const order = await place(e);
    await toOut(e, order);
    const res = await adminStep(e, order.id, 'delivered', {
      pinOverrideReason: 'Cliente sin teléfono a mano',
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('cash_not_collected');
    expect((await row(e, order.id)).pinOverrideReason).toBeNull();
  });

  it('una anulación rechazada no deja motivo guardado', async () => {
    const order = await place(e);
    await toOut(e, order);
    await adminStep(e, order.id, 'delivered', {
      pinOverrideReason: 'Motivo suficientemente largo',
    });
    const r = await row(e, order.id);
    expect(r.status).toBe('out_for_delivery');
    expect(r.pinOverrideReason).toBeNull();
    expect(r.deliveredAt).toBeNull();
  });

  it('un pedido sin PIN (anterior a la función) lo entrega el personal sin motivo', async () => {
    const order = await place(e);
    await e.w.handle.db.update(orders).set({ deliveryPin: null }).where(eq(orders.id, order.id));
    await toOut(e, order);
    await collectCash(e, order.id);
    expect((await adminStep(e, order.id, 'delivered')).statusCode).toBe(200);
  });
});

// ───────────────────────── A2) el motivo interno no llega al cliente ─────────────────────────

describe('entrega sin PIN: el motivo es interno', () => {
  const REASON = 'Cliente en silla de ruedas sin celular, lo recibió el vecino';
  const STAFF_NOTE = 'Firmó doña Carmen del 4B';
  const NEUTRAL = 'Entrega confirmada por administración';

  async function overridden() {
    const order = await place(e);
    await toOut(e, order);
    await collectCash(e, order.id);
    const res = await adminStep(e, order.id, 'delivered', {
      pinOverrideReason: REASON,
      note: STAFF_NOTE,
    });
    expect(res.statusCode, res.body).toBe(200);
    return order.id as string;
  }
  const deliveredEvent = (o: { timeline: { toStatus: string; note: string }[] }) =>
    o.timeline.find((ev) => ev.toStatus === 'delivered')!;

  it('el cliente dueño ve el evento con un texto neutro, en el pedido y en su lista', async () => {
    const id = await overridden();
    const one = await inject(e, 'GET', `/v1/orders/${id}`, e.customer);
    const list = await inject(e, 'GET', '/v1/orders', e.customer);
    const fromList = json(list).find((o: { id: string }) => o.id === id);
    expect(fromList).toBeDefined();
    for (const o of [json(one), fromList]) {
      expect(deliveredEvent(o).note).toBe(NEUTRAL);
      expect(o.pinOverrideReason).toBeNull();
      // el evento sigue en el historial: solo cambia el texto
      expect(o.timeline.map((ev: { toStatus: string }) => ev.toStatus)).toContain('delivered');
    }
    for (const res of [one, list]) {
      expect(res.body).not.toContain('silla de ruedas');
      expect(res.body).not.toContain('doña Carmen');
      expect(res.body).not.toContain('Entrega sin PIN');
    }
  });

  it('el administrador y el personal siguen leyendo el motivo completo', async () => {
    const id = await overridden();
    const full = `Entrega sin PIN autorizada: ${REASON}. ${STAFF_NOTE}`;
    for (const who of [e.admin, e.staff]) {
      const one = json(await inject(e, 'GET', `/v1/admin/orders/${id}`, who));
      expect(deliveredEvent(one).note).toBe(full);
      expect(one.pinOverrideReason).toBe(REASON);
      const list = json(await inject(e, 'GET', '/v1/admin/orders?status=delivered', who));
      const fromList = list.find((o: { id: string }) => o.id === id);
      expect(deliveredEvent(fromList).note).toBe(full);
    }
    // y en la base queda intacto
    const stored = (await events(e, id)).find((ev) => ev.toStatus === 'delivered')!;
    expect(stored.note).toBe(full);
  });

  it('otra persona no ve ese pedido (404) ni por la lista', async () => {
    const id = await overridden();
    expect((await inject(e, 'GET', `/v1/orders/${id}`, e.other)).statusCode).toBe(404);
    const list = json(await inject(e, 'GET', '/v1/orders', e.other));
    expect(JSON.stringify(list)).not.toContain('silla de ruedas');
  });

  it('la vista del repartidor tampoco lleva el motivo', async () => {
    const id = await overridden();
    const asDriver = await getOrder(e.app.orderCtx, id, { viewer: DRIVER_VIEWER });
    expect(deliveredEvent(asDriver).note).toBe(NEUTRAL);
    expect(asDriver.pinOverrideReason).toBeNull();
    expect(JSON.stringify(asDriver)).not.toContain('silla de ruedas');
    // sin vista indicada es la interna (admin, pagos): con el motivo
    expect((await getOrder(e.app.orderCtx, id)).pinOverrideReason).toBe(REASON);
  });

  it('las respuestas de las acciones usan la vista de quien actúa', () => {
    expect(viewerForActor({ id: 'c1', role: 'customer' })).toEqual({
      role: 'customer',
      userId: 'c1',
    });
    expect(viewerForActor({ id: 'd1', role: 'driver' })).toEqual(DRIVER_VIEWER);
    for (const role of ['admin', 'staff', 'system'] as const) {
      expect(viewerForActor({ id: null, role })).toEqual(INTERNAL_VIEWER);
    }
  });

  it('timelineFor: solo la vista interna lee el motivo; lo demás del historial no se toca', () => {
    const at = new Date(NOW);
    const ev = (toStatus: OrderStatus, note: string) => ({
      id: toStatus + note,
      orderId: 'o',
      fromStatus: null,
      toStatus,
      actorId: null,
      note,
      createdAt: at,
    });
    const timeline = [
      ev('confirmed', 'Pedido creado'),
      ev('delivered', 'Entrega sin PIN autorizada: motivo interno largo'),
      ev('refunded', 'Entrega sin PIN autorizada: eso no es una entrega'),
      ev('delivered', 'Entrega confirmada con el PIN del cliente. Lo recibió su hermana'),
    ];
    expect(timelineFor(timeline, INTERNAL_VIEWER)).toEqual(timeline);
    for (const viewer of [DRIVER_VIEWER, { role: 'customer', userId: 'x' } as const]) {
      const seen = timelineFor(timeline, viewer);
      expect(seen.map((x) => x.note)).toEqual([
        'Pedido creado',
        NEUTRAL,
        'Entrega sin PIN autorizada: eso no es una entrega',
        'Entrega confirmada con el PIN del cliente. Lo recibió su hermana',
      ]);
      expect(seen[1]).toMatchObject({ toStatus: 'delivered', id: timeline[1]!.id });
    }
    // no muta lo que recibe
    expect(timeline[1]!.note).toBe('Entrega sin PIN autorizada: motivo interno largo');
  });
});

// ───────────────────────── B) ubicación del repartidor ─────────────────────────

describe('ubicación del repartidor', () => {
  const ping = (body: object, headers: Headers | null = e.driver) =>
    inject(e, 'POST', '/v1/driver/location', headers, body);
  const advance = (ms: number) => (e.clock.now = new Date(e.clock.now.getTime() + ms));

  beforeEach(async () => {
    await e.w.handle.db.delete(driverLocations);
    // Pedidos que otras pruebas dejaron "en camino" harían que la posición se conserve (a propósito).
    await e.w.handle.db
      .update(orders)
      .set({ status: 'delivery_failed' })
      .where(eq(orders.status, 'out_for_delivery'));
  });

  it('guarda la última posición (una fila por repartidor, sin historial)', async () => {
    const res = await ping({ ...SD, accuracyM: 12.5 });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toEqual({ ok: true, updatedAt: NOW.toISOString() });
    expect(await locationRows(e)).toEqual([
      {
        driverId: e.w.driverId,
        latitude: SD.latitude,
        longitude: SD.longitude,
        accuracyM: 12.5,
        orderId: null,
        updatedAt: NOW,
      },
    ]);

    advance(5_000);
    expect((await ping(SANTIAGO)).statusCode).toBe(200);
    const rows = await locationRows(e);
    expect(rows).toHaveLength(1); // upsert, no historial
    expect(rows[0]).toMatchObject({ ...SANTIAGO, accuracyM: null });
    expect(rows[0]!.updatedAt.getTime()).toBe(NOW.getTime() + 5_000);
  });

  it('rechaza coordenadas fuera de República Dominicana y datos mal formados', async () => {
    const bad: object[] = [
      { latitude: 25.7617, longitude: -80.1918 }, // Miami
      { latitude: 37.3349, longitude: -122.009 }, // simulador de iPhone (Cupertino)
      { latitude: 17.29, longitude: -69.9 }, // justo al sur del borde
      { latitude: 20.11, longitude: -69.9 },
      { latitude: 18.5, longitude: -72.11 },
      { latitude: 18.5, longitude: -68.19 },
      { latitude: 0, longitude: 0 },
      { latitude: 18.5 },
      { latitude: '18.5', longitude: '-69.9' },
      { latitude: null, longitude: null },
      { ...SD, accuracyM: -1 },
      { ...SD, orderId: 'no-es-uuid' },
    ];
    for (const body of bad) {
      const res = await ping(body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(json(res).error.code).toBe('validation');
    }
    expect((await ping({ latitude: 25.7617, longitude: -80.1918 })).body).toMatch(
      /República Dominicana/,
    );
    expect(await locationRows(e)).toHaveLength(0);
  });

  it('el servicio también valida (no depende de la ruta): fuera del país o precisión absurda', async () => {
    const call = (input: Parameters<typeof recordDriverLocation>[2]) =>
      recordDriverLocation(e.app.orderCtx, e.w.driverId, input);
    await expect(call({ latitude: 40.7, longitude: -74 })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(call({ ...SD, accuracyM: Number.NaN })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(call({ ...SD, accuracyM: 1e9 })).rejects.toMatchObject({ code: 'validation' });
    expect(await locationRows(e)).toHaveLength(0);
    await expect(call({ ...SD, accuracyM: 5 })).resolves.toMatchObject({ updatedAt: NOW });
  });

  it('acepta justo los bordes del país', async () => {
    const edges = [
      { latitude: 17.3, longitude: -72.1 },
      { latitude: 20.1, longitude: -68.2 },
    ];
    for (const edge of edges) {
      expect((await ping(edge)).statusCode, JSON.stringify(edge)).toBe(200);
      advance(4_000);
    }
  });

  it('solo el repartidor la envía', async () => {
    expect((await ping(SD, e.customer)).statusCode).toBe(403);
    expect((await ping(SD, e.admin)).statusCode).toBe(403);
    expect((await ping(SD, e.staff)).statusCode).toBe(403);
    expect((await ping(SD, null)).statusCode).toBe(401);
    expect(await locationRows(e)).toHaveLength(0);
  });

  it('con orderId, el pedido debe estar asignado a ese repartidor', async () => {
    const order = await place(e);
    await toOut(e, order); // asignado a e.w.driverId

    const otherDriver = await ping({ ...SD, orderId: order.id }, e.driver2);
    expect(otherDriver.statusCode).toBe(403);
    expect(json(otherDriver).error.message).toMatch(/no está asignado/);
    expect(await locationRows(e)).toHaveLength(0);

    const unassigned = await place(e);
    expect((await ping({ ...SD, orderId: unassigned.id })).statusCode).toBe(403);
    expect(
      (await ping({ ...SD, orderId: '00000000-0000-4000-8000-000000000000' })).statusCode,
    ).toBe(404);

    const mine = await ping({ ...SD, orderId: order.id });
    expect(mine.statusCode, mine.body).toBe(200);
    expect((await locationRows(e))[0]!.orderId).toBe(order.id);
  });

  it('una actualización cada 4 segundos por repartidor; cada repartidor tiene su propio reloj', async () => {
    expect((await ping(SD)).statusCode).toBe(200);

    advance(3_999);
    const early = await ping(SANTIAGO);
    expect(early.statusCode).toBe(429);
    expect(json(early).error).toMatchObject({
      code: 'rate_limited',
      details: { retryAfterMs: 4000 },
    });
    // la posición vieja no se pisó
    expect((await locationRows(e))[0]).toMatchObject(SD);

    // otro repartidor no se ve afectado
    expect((await ping(SANTIAGO, e.driver2)).statusCode).toBe(200);

    advance(1); // exactamente 4 s desde la última aceptada
    expect((await ping(SANTIAGO)).statusCode).toBe(200);
    expect((await locationRows(e)).find((r) => r.driverId === e.w.driverId)).toMatchObject(
      SANTIAGO,
    );
  });

  it('peticiones simultáneas del mismo repartidor: solo una entra', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => ping(SD)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(5);
  });

  for (const [label, finish] of [
    ['se entrega', 'delivered'],
    ['falla la entrega', 'delivery_failed'],
  ] as const) {
    it(`se borra la posición cuando ${label}`, async () => {
      const order = await place(e);
      await toOut(e, order);
      const pin = (await row(e, order.id)).deliveryPin as string;
      await collectCash(e, order.id);
      expect((await ping({ ...SD, orderId: order.id })).statusCode).toBe(200);
      expect(await locationRows(e)).toHaveLength(1);

      const res = await driverStep(
        e,
        order.id,
        finish === 'delivered' ? { to: finish, pin } : { to: finish },
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(await locationRows(e)).toHaveLength(0);
    });
  }

  it('se borra la posición cuando se cancela el pedido que llevaba', async () => {
    const order = await place(e);
    await toPacked(e, order);
    expect((await ping({ ...SD, orderId: order.id })).statusCode).toBe(200);
    expect(await locationRows(e)).toHaveLength(1);
    expect((await adminStep(e, order.id, 'cancelled')).statusCode).toBe(200);
    expect(await locationRows(e)).toHaveLength(0);
  });

  it('con otra entrega todavía en camino la posición se queda, sin apuntar al pedido terminado', async () => {
    const first = await place(e);
    const second = await place(e);
    await toOut(e, first);
    await toOut(e, second);
    const pins = {
      first: (await row(e, first.id)).deliveryPin as string,
      second: (await row(e, second.id)).deliveryPin as string,
    };
    await collectCash(e, first.id);
    await collectCash(e, second.id);
    expect((await ping({ ...SD, orderId: first.id })).statusCode).toBe(200);

    expect((await driverStep(e, first.id, { to: 'delivered', pin: pins.first })).statusCode).toBe(
      200,
    );
    const kept = await locationRows(e);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.orderId).toBeNull();

    expect((await driverStep(e, second.id, { to: 'delivered', pin: pins.second })).statusCode).toBe(
      200,
    );
    expect(await locationRows(e)).toHaveLength(0);
  });

  it('un ping que llega justo después de entregar se guarda pero sin apuntar al pedido terminado', async () => {
    const order = await place(e);
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;
    await collectCash(e, order.id);
    await driverStep(e, order.id, { to: 'delivered', pin });
    const res = await ping({ ...SD, orderId: order.id });
    expect(res.statusCode, res.body).toBe(200);
    expect((await locationRows(e))[0]!.orderId).toBeNull();
  });
});

// ───────────────────────── B) seguimiento para el cliente ─────────────────────────

describe('seguimiento del pedido (cliente)', () => {
  const track = (id: string, headers: Headers | null = e.customer) =>
    inject(e, 'GET', `/v1/orders/${id}/tracking`, headers);
  const ping = (body: object, headers: Headers | null = e.driver) =>
    inject(e, 'POST', '/v1/driver/location', headers, body);
  const advance = (ms: number) => (e.clock.now = new Date(e.clock.now.getTime() + ms));

  beforeEach(async () => {
    await e.w.handle.db.delete(driverLocations);
    // Pedidos que otras pruebas dejaron "en camino" harían que la posición se conserve (a propósito).
    await e.w.handle.db
      .update(orders)
      .set({ status: 'delivery_failed' })
      .where(eq(orders.status, 'out_for_delivery'));
  });

  it('antes de salir (o ya terminado) no hay seguimiento', async () => {
    const order = await place(e);
    expect(json(await track(order.id))).toEqual({
      available: false,
      reason: 'not_out_for_delivery',
    });
    await toPacked(e, order);
    expect(json(await track(order.id))).toEqual({
      available: false,
      reason: 'not_out_for_delivery',
    });
  });

  it('en camino pero sin posición todavía: no_position', async () => {
    const order = await place(e);
    await toOut(e, order);
    expect(json(await track(order.id))).toEqual({ available: false, reason: 'no_position' });
  });

  it('en camino con posición reciente: coordenadas, hora y antigüedad', async () => {
    const order = await place(e);
    await toOut(e, order);
    await ping({ ...SD, orderId: order.id });
    advance(25_400);
    const res = await track(order.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(json(res)).toEqual({
      available: true,
      ...SD,
      updatedAt: NOW.toISOString(),
      ageSeconds: 25,
    });
  });

  it('una posición de más de 3 minutos ya no se muestra (180 s todavía sí)', async () => {
    const order = await place(e);
    await toOut(e, order);
    await ping({ ...SD, orderId: order.id });

    advance(180_000);
    expect(json(await track(order.id))).toMatchObject({ available: true, ageSeconds: 180 });
    advance(1_000);
    expect(json(await track(order.id))).toEqual({ available: false, reason: 'stale' });

    // el repartidor vuelve a reportar y el seguimiento regresa
    await ping(SANTIAGO);
    expect(json(await track(order.id))).toMatchObject({
      available: true,
      ...SANTIAGO,
      ageSeconds: 0,
    });
  });

  it('al entregarse el seguimiento termina y la posición ya no existe', async () => {
    const order = await place(e);
    await toOut(e, order);
    const pin = (await row(e, order.id)).deliveryPin as string;
    await collectCash(e, order.id);
    await ping({ ...SD, orderId: order.id });
    expect(json(await track(order.id)).available).toBe(true);
    await driverStep(e, order.id, { to: 'delivered', pin });
    expect(json(await track(order.id))).toEqual({
      available: false,
      reason: 'not_out_for_delivery',
    });
    expect(await locationRows(e)).toHaveLength(0);
  });

  it('privacidad: solo el cliente dueño; ni otro cliente, ni personal, ni repartidor, ni sin sesión', async () => {
    const order = await place(e);
    await toOut(e, order);
    await ping({ ...SD, orderId: order.id });
    expect(json(await track(order.id)).available).toBe(true);

    for (const headers of [e.other, e.admin, e.staff, e.driver, e.driver2]) {
      const res = await track(order.id, headers);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(String(SD.latitude));
    }
    expect((await track(order.id, null)).statusCode).toBe(401);
    expect((await track('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await track('no-es-uuid')).statusCode).toBe(400);
  });

  it('la respuesta no revela nada del repartidor: ni su id ni el pedido que lleva', async () => {
    const order = await place(e);
    await toOut(e, order);
    await ping({ ...SD, orderId: order.id, accuracyM: 8 });
    const body = json(await track(order.id));
    expect(Object.keys(body).sort()).toEqual([
      'ageSeconds',
      'available',
      'latitude',
      'longitude',
      'updatedAt',
    ]);
  });

  it('no usa la posición de otro repartidor', async () => {
    const order = await place(e);
    await toOut(e, order); // lo lleva e.driver
    await ping(SD, e.driver2);
    expect(json(await track(order.id))).toEqual({ available: false, reason: 'no_position' });
  });

  it('en camino sin repartidor asignado (dato inconsistente): no_driver', async () => {
    const order = await place(e);
    await e.w.handle.db
      .update(orders)
      .set({ status: 'out_for_delivery', driverId: null })
      .where(eq(orders.id, order.id));
    expect(json(await track(order.id))).toEqual({ available: false, reason: 'no_driver' });
  });
});

// ───────────────────────── B) coordenadas en direcciones ─────────────────────────

describe('coordenadas de la dirección', () => {
  const newAddress = (extra: object) =>
    inject(e, 'POST', '/v1/me/addresses', e.customer, {
      label: 'Oficina',
      line1: 'Av. Winston Churchill 100',
      reference: 'Torre azul, piso 3',
      sector: 'Piantini',
      city: 'Santo Domingo',
      ...extra,
    });

  it('guarda latitud y longitud válidas y las devuelve', async () => {
    const res = await newAddress({ ...SD });
    expect(res.statusCode, res.body).toBe(201);
    expect(json(res)).toMatchObject(SD);
    const list = json(await inject(e, 'GET', '/v1/me/addresses', e.customer));
    expect(list.find((a: { id: string }) => a.id === json(res).id)).toMatchObject(SD);
  });

  it('rechaza coordenadas fuera de República Dominicana (al crear y al editar)', async () => {
    for (const bad of [
      { latitude: 25.76, longitude: -80.19 },
      { latitude: 18.5, longitude: -122 },
      { latitude: 95, longitude: -69.9 },
    ]) {
      const res = await newAddress(bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(json(res).error.message).toMatch(/República Dominicana/);
    }
    const ok = json(await newAddress({ ...SD }));
    const put = await inject(e, 'PUT', `/v1/me/addresses/${ok.id}`, e.customer, {
      label: 'Oficina',
      line1: 'Av. Winston Churchill 100',
      sector: 'Piantini',
      city: 'Santo Domingo',
      latitude: 40.7,
      longitude: -74,
    });
    expect(put.statusCode).toBe(400);
  });

  it('el pedido lleva las coordenadas de la dirección y el repartidor las ve para navegar', async () => {
    const saved = json(await newAddress({ ...SANTIAGO }));
    const order = await place(e, { addressId: saved.id });
    expect(order.address).toMatchObject(SANTIAGO);
    await toOut(e, order);
    const mine = json(await inject(e, 'GET', '/v1/driver/orders', e.driver));
    expect(mine.find((o: { id: string }) => o.id === order.id).address).toMatchObject(SANTIAGO);
  });

  it('sin coordenadas, el pedido las trae explícitamente en null', async () => {
    const { latitude: _la, longitude: _lo, ...noCoords } = ADDRESS;
    const order = await place(e, { address: noCoords });
    expect(order.address.latitude).toBeNull();
    expect(order.address.longitude).toBeNull();
    const fromAdmin = json(await inject(e, 'GET', `/v1/admin/orders/${order.id}`, e.admin));
    expect(fromAdmin.address).toMatchObject({ latitude: null, longitude: null });
  });
});

// ───────────────────────── C) pedir de nuevo ─────────────────────────

describe('pedir de nuevo', () => {
  const reorder = (id: string, headers: Headers | null = e.customer) =>
    inject(e, 'GET', `/v1/orders/${id}/reorder`, headers);
  type Line = {
    variantId: string;
    name: string;
    variant: string;
    pricingUnit: string;
    unitPrice: number;
    previousUnitPrice: number;
    requestedQuantity: number;
    quantity: number;
    status: 'ok' | 'reduced' | 'unavailable';
    reason?: string;
    photoIllustrative: boolean;
  };
  /** Un pedido con una pechuga (lb), un camarón (lb, paso 1) y un combo (unidad). */
  async function threeLineOrder() {
    const pol = await e.w.variant('POL-1');
    const cam = await e.w.variant('CAM-1');
    const cmb = await e.w.variant('CMB-1');
    const res = await inject(e, 'POST', '/v1/orders', e.customer, {
      items: [
        { variantId: pol.id, quantity: 500 },
        { variantId: cam.id, quantity: 200 },
        { variantId: cmb.id, quantity: 1 },
      ],
      address: ADDRESS,
      slotStart: (await e.w.firstSlot()).toISOString(),
      paymentMethod: 'cash',
    });
    expect(res.statusCode, res.body).toBe(201);
    return { order: json(res), pol, cam, cmb };
  }

  async function setStock(sku: string, onHand: number, reserved = 0) {
    await e.w.handle.db.update(variants).set({ onHand, reserved }).where(eq(variants.sku, sku));
  }
  const byId = (body: { lines: Line[] }, id: string) => body.lines.find((l) => l.variantId === id)!;

  beforeEach(async () => {
    // Estado base conocido para cada prueba.
    await setStock('POL-1', 1_000_000);
    await setStock('CAM-1', 2000);
    await setStock('CMB-1', 50);
    await e.w.handle.db
      .update(variants)
      .set({ price: 17_495, priceSource: 'usuario', active: true })
      .where(eq(variants.sku, 'POL-1'));
    await e.w.handle.db
      .update(variants)
      .set({ price: 245_000, priceSource: 'usuario', active: true, itbisBps: 1800 })
      .where(eq(variants.sku, 'CMB-1'));
  });

  it('con todo igual, cada línea vuelve tal cual y lista para agregar', async () => {
    const { order, pol, cam, cmb } = await threeLineOrder();
    const res = await reorder(order.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res);
    expect(body).toMatchObject({ orderId: order.id, code: order.code, demo: false });
    expect(body.lines).toHaveLength(3);
    expect(byId(body, pol.id)).toMatchObject({
      name: 'Pechuga de pollo',
      pricingUnit: 'lb',
      unitPrice: 17_495,
      previousUnitPrice: 17_495,
      requestedQuantity: 500,
      quantity: 500,
      status: 'ok',
    });
    expect(byId(body, cam.id)).toMatchObject({
      variant: '16/20',
      requestedQuantity: 200,
      quantity: 200,
      status: 'ok',
    });
    expect(byId(body, cmb.id)).toMatchObject({
      pricingUnit: 'unit',
      requestedQuantity: 1,
      quantity: 1,
      status: 'ok',
    });
    expect(byId(body, pol.id).reason).toBeUndefined();
  });

  it('producto agotado: no disponible, cantidad 0 y motivo', async () => {
    const { order, cam } = await threeLineOrder();
    await setStock('CAM-1', 0);
    const line = byId(json(await reorder(order.id)), cam.id);
    expect(line).toMatchObject({
      status: 'unavailable',
      quantity: 0,
      requestedQuantity: 200,
      reason: 'Agotado por ahora',
    });
  });

  it('pocas existencias: reduce la cantidad a lo disponible y a un múltiplo del paso', async () => {
    const { order, pol } = await threeLineOrder();
    await setStock('POL-1', 350); // 3.5 lb, paso de media libra
    let line = byId(json(await reorder(order.id)), pol.id);
    expect(line).toMatchObject({ status: 'reduced', quantity: 350, requestedQuantity: 500 });
    expect(line.reason).toBe('Solo quedan 3.5 lb disponibles');

    await setStock('POL-1', 1000, 620); // 3.8 lb libres → baja al paso de 0.5 lb
    line = byId(json(await reorder(order.id)), pol.id);
    expect(line).toMatchObject({ status: 'reduced', quantity: 350 });
  });

  it('menos del mínimo disponible: no se puede ofrecer', async () => {
    const { order, pol } = await threeLineOrder();
    await setStock('POL-1', 60); // 0.6 lb, el mínimo es 1 lb
    const line = byId(json(await reorder(order.id)), pol.id);
    expect(line).toMatchObject({ status: 'unavailable', quantity: 0 });
    expect(line.reason).toBe('Solo quedan 0.6 lb y lo mínimo es 1 lb');
  });

  it('las reservas de otros pedidos cuentan: lo disponible es existencias menos reservado', async () => {
    const { order, cmb } = await threeLineOrder();
    await setStock('CMB-1', 5, 5);
    expect(byId(json(await reorder(order.id)), cmb.id)).toMatchObject({
      status: 'unavailable',
      reason: 'Agotado por ahora',
    });
    await setStock('CMB-1', 5, 4);
    expect(byId(json(await reorder(order.id)), cmb.id)).toMatchObject({
      status: 'ok',
      quantity: 1,
    });
  });

  it('precio cambiado: trae el precio de hoy y el de la vez anterior; sigue siendo ok', async () => {
    const { order, cmb, pol } = await threeLineOrder();
    const patch = await inject(e, 'PATCH', `/v1/admin/variants/${cmb.id}`, e.admin, {
      price: 260_000,
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const body = json(await reorder(order.id));
    expect(byId(body, cmb.id)).toMatchObject({
      unitPrice: 260_000,
      previousUnitPrice: 245_000,
      status: 'ok',
      quantity: 1,
    });
    expect(byId(body, pol.id)).toMatchObject({ unitPrice: 17_495, previousUnitPrice: 17_495 });
  });

  it('el nombre y la foto salen del catálogo de hoy; la foto indica si es ilustrativa', async () => {
    const { order, pol, cmb } = await threeLineOrder();
    await e.w.handle.db
      .update(variants)
      .set({ photo: 'pechuga-real.jpg', photoIllustrative: false })
      .where(eq(variants.id, pol.id));
    await e.w.handle.db
      .update(variants)
      .set({ photo: 'combo.jpg', photoIllustrative: true })
      .where(eq(variants.id, cmb.id));
    const body = json(await reorder(order.id));
    expect(byId(body, pol.id)).toMatchObject({
      photo: 'pechuga-real.jpg',
      photoIllustrative: false,
    });
    expect(byId(body, cmb.id)).toMatchObject({ photo: 'combo.jpg', photoIllustrative: true });
  });

  it('respeta la publicación: inactivo o precio estimado no se ofrecen (igual que el catálogo)', async () => {
    const { order, pol, cam, cmb } = await threeLineOrder();
    await e.w.handle.db.update(variants).set({ active: false }).where(eq(variants.id, pol.id));
    await e.w.handle.db
      .update(variants)
      .set({ priceSource: 'estimado' })
      .where(eq(variants.id, cmb.id));
    const body = json(await reorder(order.id));
    expect(byId(body, pol.id)).toMatchObject({
      status: 'unavailable',
      quantity: 0,
      reason: 'Ya no está disponible',
    });
    expect(byId(body, cmb.id)).toMatchObject({ status: 'unavailable', quantity: 0 });
    expect(byId(body, cam.id).status).toBe('ok');

    // coherencia con el catálogo público: lo que no se lista tampoco se ofrece
    const catalog = json(await inject(e, 'GET', '/v1/products?limit=100'));
    const listed = new Set(
      catalog.items.flatMap((p: { variants: { id: string }[] }) => p.variants.map((v) => v.id)),
    );
    for (const l of body.lines as Line[]) {
      expect(l.status === 'unavailable').toBe(!listed.has(l.variantId));
    }
  });

  it('en modo demo un precio estimado sí se ofrece (como en el catálogo); al apagarlo, no', async () => {
    const demoWorld = await makeWorld({ demo: true });
    try {
      const { app, auth } = await (async () => {
        const app = await buildApp({
          db: demoWorld.handle.db,
          config: demoWorld.config,
          otpSender: new MemoryOtpSender(),
          now: demoWorld.ctx.now,
        });
        return {
          app,
          auth: (id: string, role: 'customer' | 'admin') => ({
            authorization: `Bearer ${app.jwt.sign({ sub: id, role })}`,
          }),
        };
      })();
      const est = await demoWorld.variant('EST-1');
      const created = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: auth(demoWorld.customerId, 'customer'),
        payload: {
          items: [{ variantId: est.id, quantity: 300 }],
          address: ADDRESS,
          slotStart: (await demoWorld.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = json(created).id;
      const ask = () =>
        app.inject({
          method: 'GET',
          url: `/v1/orders/${id}/reorder`,
          headers: auth(demoWorld.customerId, 'customer'),
        });
      expect(json(await ask())).toMatchObject({
        demo: true,
        lines: [{ status: 'ok', quantity: 300 }],
      });

      demoWorld.config.demo = false; // la publicación se aprieta: ya no se puede vender un estimado
      expect(json(await ask())).toMatchObject({
        demo: false,
        lines: [{ status: 'unavailable', quantity: 0 }],
      });
      await app.close();
    } finally {
      await demoWorld.close();
    }
  });

  it('respeta el máximo por línea', async () => {
    const { order, pol } = await threeLineOrder();
    const original = e.w.config.maxCentilbPerLine;
    e.w.config.maxCentilbPerLine = 300;
    try {
      const line = byId(json(await reorder(order.id)), pol.id);
      expect(line).toMatchObject({ status: 'reduced', quantity: 300 });
      expect(line.reason).toBe('El máximo por pedido es 3 lb');
    } finally {
      e.w.config.maxCentilbPerLine = original;
    }
  });

  it('si el paso o el mínimo cambiaron desde la última compra, ajusta a lo que hoy se puede cotizar', async () => {
    const { order, pol } = await threeLineOrder();
    // paso de 2 lb: 5 lb ya no es múltiplo → baja a 4 lb
    await e.w.handle.db.update(variants).set({ stepCentilb: 200 }).where(eq(variants.id, pol.id));
    let line = byId(json(await reorder(order.id)), pol.id);
    expect(line).toMatchObject({ status: 'reduced', quantity: 400 });
    expect(line.reason).toBe('Se vende en múltiplos de 2 lb');

    // mínimo de 8 lb (pidió 5): sube al mínimo en vez de perder la línea
    await e.w.handle.db
      .update(variants)
      .set({ stepCentilb: 50, minCentilb: 800 })
      .where(eq(variants.id, pol.id));
    line = byId(json(await reorder(order.id)), pol.id);
    expect(line).toMatchObject({ status: 'ok', quantity: 800 });
    expect(line.reason).toBe('Ahora lo mínimo es 8 lb');
    await e.w.handle.db.update(variants).set({ minCentilb: 100 }).where(eq(variants.id, pol.id));
  });

  it('toda cantidad sugerida se puede cotizar tal cual (nunca propone algo que el pedido rechazaría)', async () => {
    const { order } = await threeLineOrder();
    const scenarios: [string, number, number][] = [
      ['POL-1', 275, 0],
      ['POL-1', 100, 0],
      ['POL-1', 1_000_000, 0],
      ['CAM-1', 350, 0],
      ['CMB-1', 3, 1],
    ];
    for (const [sku, onHand, reserved] of scenarios) {
      await setStock(sku, onHand, reserved);
      const body = json(await reorder(order.id));
      const offered = (body.lines as Line[]).filter((l) => l.quantity > 0);
      const quote = await inject(e, 'POST', '/v1/quote', undefined, {
        items: offered.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
      });
      expect(quote.statusCode, `${sku}/${onHand}: ${quote.body}`).toBe(200);
    }
  });

  it('no toca el carrito ni el inventario: es solo lectura', async () => {
    const { order } = await threeLineOrder();
    const before = {
      stock: await e.w.handle.db.select().from(variants),
      orders: (await e.w.handle.db.select({ id: orders.id }).from(orders)).length,
    };
    await reorder(order.id);
    await reorder(order.id);
    const after = {
      stock: await e.w.handle.db.select().from(variants),
      orders: (await e.w.handle.db.select({ id: orders.id }).from(orders)).length,
    };
    expect(after).toEqual(before);
  });

  it('funciona con pedidos ya entregados o cancelados, y solo para su dueño', async () => {
    const { order } = await threeLineOrder();
    await inject(e, 'POST', `/v1/orders/${order.id}/cancel`, e.customer, {});
    expect((await reorder(order.id)).statusCode).toBe(200);
    expect((await reorder(order.id, e.other)).statusCode).toBe(404);
    expect((await reorder(order.id, e.admin)).statusCode).toBe(404);
    expect((await reorder(order.id, null)).statusCode).toBe(401);
    expect((await reorder('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await reorder('xyz')).statusCode).toBe(400);
  });
});

// ───────────────────────── límites geográficos ─────────────────────────

describe('límites de República Dominicana', () => {
  it('la caja es inclusiva en sus bordes y rechaza lo que cae fuera', async () => {
    const { isInDominicanRepublic } = await import('@jellyfish/shared');
    expect(isInDominicanRepublic(18.4861, -69.9312)).toBe(true);
    expect(isInDominicanRepublic(17.3, -72.1)).toBe(true);
    expect(isInDominicanRepublic(20.1, -68.2)).toBe(true);
    expect(isInDominicanRepublic(17.2999, -69.9)).toBe(false);
    expect(isInDominicanRepublic(18.5, -68.1999)).toBe(false);
    expect(isInDominicanRepublic(Number.NaN, -69.9)).toBe(false);
    expect(isInDominicanRepublic(18.5, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isInDominicanRepublic(-18.4861, -69.9312)).toBe(false); // signo equivocado
  });
});
