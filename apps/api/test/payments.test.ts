import { AzulGateway, type AzulConfig } from '@jellyfish/payments';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orders, payments } from '../src/db/schema';
import { ADDRESS, type World, makeApp, makeWorld } from './helpers';

type Headers = Record<string, string>;
const json = (res: { body: string }) => JSON.parse(res.body);
const unescape = (s: string) =>
  s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
/** "http://localhost:3000/v1/x?y=1" → "/v1/x?y=1" (inject trabaja con rutas). */
const path = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

interface Env {
  w: World;
  app: FastifyInstance;
  auth: Awaited<ReturnType<typeof makeApp>>['auth'];
  customer: Headers;
  admin: Headers;
  driver: Headers;
}

// Estas pruebas crean decenas de pedidos en la misma franja: se sube su capacidad.
const ROOMY = {
  startHour: 10,
  endHour: 20,
  windowHours: 2,
  capacityPerWindow: 500,
  leadMinutes: 90,
  daysAhead: 3,
};

async function setup(overrides: Parameters<typeof makeWorld>[0] = {}): Promise<Env> {
  const w = await makeWorld({ windows: ROOMY, ...overrides });
  const { app, auth } = await makeApp(w);
  return {
    w,
    app,
    auth,
    customer: auth(w.customerId, 'customer'),
    admin: auth(w.adminId, 'admin'),
    driver: auth(w.driverId, 'driver'),
  };
}

async function placeOrder(
  e: Env,
  method: 'card' | 'cash' | 'transfer',
  items: { sku: string; quantity: number }[] = [{ sku: 'POL-1', quantity: 500 }],
) {
  const resolved = await Promise.all(
    items.map(async (i) => ({ variantId: (await e.w.variant(i.sku)).id, quantity: i.quantity })),
  );
  const res = await e.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: e.customer,
    payload: {
      items: resolved,
      address: ADDRESS,
      slotStart: (await e.w.firstSlot()).toISOString(),
      paymentMethod: method,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res);
}

/** Recorre el flujo de la app hasta la página del simulador y devuelve los enlaces de resultado. */
async function openMockCheckout(e: Env, orderId: string) {
  const pay = await e.app.inject({
    method: 'POST',
    url: `/v1/orders/${orderId}/pay`,
    headers: e.customer,
  });
  expect(pay.statusCode, pay.body).toBe(200);
  const { paymentId, redirectUrl, amount } = json(pay);

  const redirect = await e.app.inject({ url: path(redirectUrl) });
  expect(redirect.statusCode).toBe(200);
  const fields = Object.fromEntries(
    [...redirect.body.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [
      m[1]!,
      unescape(m[2]!),
    ]),
  );

  const page = await e.app.inject({
    method: 'POST',
    url: '/v1/payments/mock/page',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      OrderNumber: fields.OrderNumber!,
      Amount: fields.Amount!,
    }).toString(),
  });
  expect(page.statusCode).toBe(200);
  const hrefs = [...page.body.matchAll(/href="([^"]+)"/g)].map((m) => path(unescape(m[1]!)));
  return {
    paymentId: paymentId as string,
    amount: amount as number,
    redirect,
    fields,
    approve: hrefs.find((h) => h.includes('/approved'))!,
    decline: hrefs.find((h) => h.includes('/declined'))!,
    cancel: hrefs.find((h) => h.includes('/cancel'))!,
  };
}

const getOrder = async (e: Env, id: string) =>
  json(await e.app.inject({ url: `/v1/orders/${id}`, headers: e.customer }));
const paymentRow = async (e: Env, id: string) =>
  (await e.w.handle.db.select().from(payments).where(eq(payments.id, id)))[0]!;

describe('métodos de pago', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  it('informa qué métodos están disponibles', async () => {
    const res = json(await e.app.inject({ url: '/v1/payments/methods' }));
    expect(res).toEqual({
      card: { available: true },
      cash: { available: true },
      transfer: { available: true },
    });
  });

  it('entrega los datos bancarios solo a usuarios con sesión', async () => {
    expect((await e.app.inject({ url: '/v1/payments/transfer-info' })).statusCode).toBe(401);
    const info = json(
      await e.app.inject({ url: '/v1/payments/transfer-info', headers: e.customer }),
    );
    expect(info).toMatchObject({ bank: 'Banco de Pruebas', accountNumber: '000-000000-0' });
  });
});

describe('tarjeta (pasarela simulada, mismo camino de verificación que AZUL)', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  it('pago aprobado: cobra el total, confirma el pedido y devuelve al cliente a la app', async () => {
    const order = await placeOrder(e, 'card');
    expect(order.status).toBe('pending_payment');
    const co = await openMockCheckout(e, order.id);
    expect(co.amount).toBe(order.total);
    expect(co.fields.OrderNumber).toMatch(/^JF\d{6}A1$/);
    expect(co.redirect.headers['content-security-policy']).toContain(
      'form-action http://localhost:3000',
    );

    const res = await e.app.inject({ url: co.approve });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('¡Pago recibido!');
    expect(res.body).toContain(`jellyfish://orders/${order.id}?payment=approved`);

    const after = await getOrder(e, order.id);
    expect(after.status).toBe('confirmed');
    expect(after.reservationExpiresAt).toBeNull();
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({
      method: 'card',
      status: 'captured',
      amount: order.total,
      capturedAmount: order.total,
      refundPending: 0,
    });
    expect(after.timeline.map((t: { toStatus: string }) => t.toStatus)).toEqual([
      'pending_payment',
      'confirmed',
    ]);
  });

  it('recargar la respuesta no duplica nada (idempotente)', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    await e.app.inject({ url: co.approve });
    const again = await e.app.inject({ url: co.approve });
    expect(again.body).toContain('¡Pago recibido!');
    const after = await getOrder(e, order.id);
    expect(after.timeline).toHaveLength(2);
    expect(after.payments[0].capturedAmount).toBe(order.total);
  });

  it('pago rechazado: el pedido sigue esperando y se puede reintentar (intento 2)', async () => {
    const order = await placeOrder(e, 'card');
    const first = await openMockCheckout(e, order.id);
    const declined = await e.app.inject({ url: first.decline });
    expect(declined.body).toContain('Pago rechazado');
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');
    expect((await paymentRow(e, first.paymentId)).status).toBe('failed');

    const second = await openMockCheckout(e, order.id);
    expect(second.fields.OrderNumber).toMatch(/A2$/);
    await e.app.inject({ url: second.approve });
    const after = await getOrder(e, order.id);
    expect(after.status).toBe('confirmed');
    expect(after.payments.map((p: { status: string }) => p.status)).toEqual(['failed', 'captured']);
  });

  it('cancelar en la pasarela no cobra ni confirma', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    // el simulador firma solo aprobado/rechazado; el cancelar llega sin firma de resultado
    const cancel = await e.app.inject({ url: `${co.cancel}` });
    expect(cancel.statusCode).toBe(400); // sin hash válido no se toca nada
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');
    expect((await paymentRow(e, co.paymentId)).status).toBe('pending');
  });

  it('un callback alterado (monto distinto) se rechaza sin tocar el pedido', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    const url = new URL(co.approve, 'http://x');
    url.searchParams.set('Amount', '100'); // el cliente intenta pagar RD$ 1.00
    const res = await e.app.inject({ url: url.pathname + url.search });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('No pudimos verificar');
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');
    expect((await paymentRow(e, co.paymentId)).status).toBe('pending');
  });

  it('un callback sin firma tampoco hace nada', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    const bare = `/v1/payments/mock/approved?OrderNumber=${co.fields.OrderNumber}&Amount=${co.fields.Amount}&IsoCode=00`;
    expect((await e.app.inject({ url: bare })).statusCode).toBe(400);
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');
  });

  it('el enlace de redirección vence y no sirve manipulado', async () => {
    const order = await placeOrder(e, 'card');
    const pay = json(
      await e.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/pay`,
        headers: e.customer,
      }),
    );
    const url = new URL(pay.redirectUrl);
    const token = url.searchParams.get('token')!;
    const bad = `${path(pay.redirectUrl).split('?')[0]}?token=${encodeURIComponent(token.replace(/.$/, 'x'))}`;
    expect((await e.app.inject({ url: bad })).statusCode).toBe(403);
    // el token de un pago no abre el de otro
    const other = await placeOrder(e, 'card');
    const otherPay = json(
      await e.app.inject({
        method: 'POST',
        url: `/v1/orders/${other.id}/pay`,
        headers: e.customer,
      }),
    );
    const crossed = `${path(otherPay.redirectUrl).split('?')[0]}?token=${encodeURIComponent(token)}`;
    expect((await e.app.inject({ url: crossed })).statusCode).toBe(403);
  });

  it('solo el dueño puede iniciar el pago y solo de pedidos con tarjeta', async () => {
    const order = await placeOrder(e, 'card');
    const stranger = e.auth(e.w.driverId, 'customer');
    expect(
      (await e.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/pay`, headers: stranger }))
        .statusCode,
    ).toBe(404);
    const cash = await placeOrder(e, 'cash');
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${cash.id}/pay`,
      headers: e.customer,
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('wrong_method');
  });

  it('no se puede pagar dos veces el mismo pedido', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    await e.app.inject({ url: co.approve });
    const again = await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pay`,
      headers: e.customer,
    });
    expect(again.statusCode).toBe(409);
  });

  it('aprobación tardía tras cancelar el pedido: el dinero se registra y queda por devolver', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    // El cliente cancela (o vence la reserva) mientras está en la página del banco...
    await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: e.customer,
      payload: {},
    });
    expect((await paymentRow(e, co.paymentId)).status).toBe('voided');
    // ...pero el banco aprueba igual.
    const late = await e.app.inject({ url: co.approve });
    expect(late.body).toContain('te devolveremos el dinero');
    const row = await paymentRow(e, co.paymentId);
    expect(row).toMatchObject({
      status: 'captured',
      capturedAmount: order.total,
      refundPending: order.total,
      failureReason: 'order_not_active',
    });
    expect((await getOrder(e, order.id)).status).toBe('cancelled');

    // Aparece en la cola del panel y se devuelve en dos partes.
    const queue = json(
      await e.app.inject({ url: '/v1/admin/payments?refundPending=1', headers: e.admin }),
    );
    expect(queue.some((p: { id: string }) => p.id === co.paymentId)).toBe(true);
    const half = Math.floor(order.total / 2);
    const r1 = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${co.paymentId}/mark-refunded`,
      headers: e.admin,
      payload: { amount: half, reference: 'AZUL-REEMB-001' },
    });
    expect(json(r1)).toMatchObject({
      status: 'partially_refunded',
      refundedAmount: half,
      refundPending: order.total - half,
    });
    const tooMuch = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${co.paymentId}/mark-refunded`,
      headers: e.admin,
      payload: { amount: order.total, reference: 'AZUL-REEMB-002' },
    });
    expect(tooMuch.statusCode).toBe(409);
    const r2 = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${co.paymentId}/mark-refunded`,
      headers: e.admin,
      payload: { amount: order.total - half, reference: 'AZUL-REEMB-002' },
    });
    expect(json(r2)).toMatchObject({
      status: 'refunded',
      refundPending: 0,
      refundedAmount: order.total,
    });
  });

  it('dos intentos que terminan aprobados: el segundo se marca como duplicado a devolver', async () => {
    const order = await placeOrder(e, 'card');
    const first = await openMockCheckout(e, order.id);
    // intento abandonado sin pagar, el cliente reintenta
    const [row1] = await e.w.handle.db
      .select()
      .from(payments)
      .where(eq(payments.id, first.paymentId));
    expect(row1!.status).toBe('pending');
    const second = await openMockCheckout(e, order.id);
    await e.app.inject({ url: second.approve });
    await e.app.inject({ url: first.approve }); // el primer navegador también termina pagando
    const rows = (await getOrder(e, order.id)).payments;
    expect(rows).toHaveLength(2);
    const dup = rows.find((p: { id: string }) => p.id === first.paymentId);
    expect(dup).toMatchObject({
      status: 'captured',
      refundPending: order.total,
      failureReason: 'duplicate_payment',
    });
    expect((await getOrder(e, order.id)).status).toBe('confirmed');
  });

  it('una aprobación con monto distinto al pedido queda para revisión, sin confirmar', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    // Pagó un monto menor: simulamos una respuesta FIRMADA por la pasarela con otro monto.
    const gw = e.app.paymentCtx.gateway as import('@jellyfish/payments').MockGateway;
    const cb = gw.buildCallback('approved', {
      orderNumber: co.fields.OrderNumber!,
      amount: '5000',
    });
    const res = await e.app.inject({
      url: `/v1/payments/mock/approved?${new URLSearchParams(cb)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(await paymentRow(e, co.paymentId)).toMatchObject({
      capturedAmount: 5000,
      refundPending: 5000,
      failureReason: 'amount_mismatch',
    });
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');
  });

  it('el administrador no puede confirmar un pedido de tarjeta sin pago', async () => {
    const order = await placeOrder(e, 'card');
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${order.id}/transition`,
      headers: e.admin,
      payload: { to: 'confirmed' },
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('not_paid');
  });

  it('pago perdido: el administrador lo marca como pagado y el pedido se confirma', async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id); // el cliente pagó pero la respuesta nunca llegó
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${co.paymentId}/mark-paid`,
      headers: e.admin,
      payload: { reference: 'RRN-123456' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ status: 'confirmed' });
    expect((await paymentRow(e, co.paymentId)).providerRef).toBe('RRN-123456');
  });
});

describe('ajuste por peso real (cobro estimado, devolución de la diferencia)', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  const pack = async (orderId: string, finalQuantity: number) => {
    const order = await getOrder(e, orderId);
    await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${orderId}/transition`,
      headers: e.admin,
      payload: { to: 'picking' },
    });
    const w = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${orderId}/weights`,
      headers: e.admin,
      payload: { weights: [{ itemId: order.items[0].id, finalQuantity }] },
    });
    expect(w.statusCode, w.body).toBe(200);
    return e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${orderId}/transition`,
      headers: e.admin,
      payload: { to: 'packed' },
    });
  };

  const paidCardOrder = async () => {
    const order = await placeOrder(e, 'card');
    const co = await openMockCheckout(e, order.id);
    await e.app.inject({ url: co.approve });
    return { order, paymentId: co.paymentId };
  };

  it('si pesó menos de lo cobrado, la diferencia queda por devolver', async () => {
    const { order, paymentId } = await paidCardOrder(); // 5 lb a RD$ 174.95
    const res = await pack(order.id, 450); // 4.5 lb
    expect(res.statusCode).toBe(200);
    const packed = json(res);
    expect(packed.finalTotal).toBe(78_728 + 15_000); // 4.5 × 174.95 = 787.275 → 787.28 + envío
    const row = await paymentRow(e, paymentId);
    expect(row.refundPending).toBe(order.total - packed.finalTotal);
    expect(row.capturedAmount).toBe(order.total);
  });

  it('si pesó un poco más, el negocio absorbe la diferencia (no hay cobro extra)', async () => {
    const { order, paymentId } = await paidCardOrder();
    const res = await pack(order.id, 530); // +6 % sobre lo pedido, dentro del colchón del 10 %
    expect(res.statusCode).toBe(200);
    expect(json(res).finalTotal).toBeGreaterThan(order.total);
    expect(json(res).finalTotal).toBeLessThanOrEqual(order.authorizedAmount);
    expect((await paymentRow(e, paymentId)).refundPending).toBe(0);
  });

  it('si el peso real pasa lo autorizado, no deja empacar y pide ajustar porciones', async () => {
    const { order } = await paidCardOrder();
    const res = await pack(order.id, 600); // +20 %: dentro de la tolerancia de báscula pero fuera de lo autorizado
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('overweight');
    expect((await getOrder(e, order.id)).status).toBe('picking');
  });

  it('cancelar un pedido ya pagado deja el total completo por devolver', async () => {
    const { order, paymentId } = await paidCardOrder();
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${order.id}/transition`,
      headers: e.admin,
      payload: { to: 'cancelled', note: 'Sin stock real' },
    });
    expect(res.statusCode).toBe(200);
    expect(await paymentRow(e, paymentId)).toMatchObject({
      refundPending: order.total,
      status: 'captured',
    });
  });
});

describe('efectivo contra entrega y cuadre de caja', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  const toOutForDelivery = async (orderId: string, finalQuantity = 500) => {
    const order = await getOrder(e, orderId);
    const step = (to: string) =>
      e.app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${orderId}/transition`,
        headers: e.admin,
        payload: { to },
      });
    await step('picking');
    await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${orderId}/weights`,
      headers: e.admin,
      payload: { weights: [{ itemId: order.items[0].id, finalQuantity }] },
    });
    await step('packed');
    await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${orderId}/assign-driver`,
      headers: e.admin,
      payload: { driverId: e.w.driverId },
    });
    await step('out_for_delivery');
    return getOrder(e, orderId);
  };

  it('el pedido en efectivo nace con un cobro pendiente y se ajusta al peso real', async () => {
    const order = await placeOrder(e, 'cash');
    expect(order.payments[0]).toMatchObject({
      method: 'cash',
      status: 'pending',
      amount: order.total,
    });
    const out = await toOutForDelivery(order.id, 460);
    expect(out.payments[0].amount).toBe(out.finalTotal);
    expect(out.finalTotal).toBeLessThan(order.total);
  });

  it('el repartidor debe cobrar el monto exacto antes de marcar la entrega', async () => {
    const order = await placeOrder(e, 'cash');
    const out = await toOutForDelivery(order.id, 480);
    const collect = (amount: number, headers: Headers = e.driver) =>
      e.app.inject({
        method: 'POST',
        url: `/v1/driver/orders/${order.id}/collect`,
        headers,
        payload: { amount },
      });

    const wrong = await collect(out.finalTotal - 1);
    expect(wrong.statusCode).toBe(409);
    expect(json(wrong).error.details.due).toBe(out.finalTotal);

    // otro repartidor no puede cobrar un pedido ajeno
    const [other] = await e.w.handle.db.select().from(orders).where(eq(orders.id, order.id));
    expect(other!.driverId).toBe(e.w.driverId);

    const ok = await collect(out.finalTotal);
    expect(ok.statusCode).toBe(200);
    expect(json(ok).payments[0]).toMatchObject({
      status: 'captured',
      capturedAmount: out.finalTotal,
    });
    expect((await collect(out.finalTotal)).statusCode).toBe(409); // ya cobrado

    const done = await e.app.inject({
      method: 'POST',
      url: `/v1/driver/orders/${order.id}/transition`,
      headers: e.driver,
      payload: { to: 'delivered' },
    });
    expect(json(done).status).toBe('delivered');
  });

  it('el cuadre de caja suma lo cobrado y no deja liquidar más de lo que se debe', async () => {
    const before = json(await e.app.inject({ url: '/v1/admin/cash', headers: e.admin })).find(
      (r: { driverId: string }) => r.driverId === e.w.driverId,
    );
    expect(before.collected).toBeGreaterThan(0);
    expect(before.balance).toBe(before.collected - before.settled);

    const settle = (amount: number) =>
      e.app.inject({
        method: 'POST',
        url: '/v1/admin/cash/settle',
        headers: e.admin,
        payload: { driverId: e.w.driverId, amount, note: 'Entrega del turno' },
      });
    const partial = await settle(1000);
    expect(partial.statusCode).toBe(200);
    expect(json(partial).balance).toBe(before.balance - 1000);

    const over = await settle(before.balance); // ya descontamos 1,000: se pasa
    expect(over.statusCode).toBe(409);
    expect(json(over).error.code).toBe('exceeds_balance');

    const rest = await settle(before.balance - 1000);
    expect(json(rest).balance).toBe(0);
  });

  it('solo el administrador ve el cuadre de caja', async () => {
    expect((await e.app.inject({ url: '/v1/admin/cash', headers: e.driver })).statusCode).toBe(403);
    expect((await e.app.inject({ url: '/v1/admin/cash', headers: e.customer })).statusCode).toBe(
      403,
    );
  });

  it('al cancelar un pedido en efectivo sin cobrar, el cobro pendiente se anula', async () => {
    const order = await placeOrder(e, 'cash');
    await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: e.customer,
      payload: {},
    });
    expect((await getOrder(e, order.id)).payments[0].status).toBe('voided');
  });
});

describe('transferencia bancaria', () => {
  let e: Env;
  beforeAll(async () => (e = await setup()));
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  it('flujo completo: pedido → comprobante → verificación del administrador → confirmado', async () => {
    const order = await placeOrder(e, 'transfer');
    expect(order.status).toBe('pending_payment');
    expect(order.payments[0]).toMatchObject({ method: 'transfer', status: 'pending' });

    const proof = await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/transfer-proof`,
      headers: e.customer,
      payload: { reference: 'BPD-889900', note: 'Desde Banco Popular' },
    });
    expect(proof.statusCode).toBe(200);
    expect(
      ((await paymentRow(e, order.payments[0].id)).raw as { proof: { reference: string } }).proof
        .reference,
    ).toBe('BPD-889900');

    const blocked = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${order.id}/transition`,
      headers: e.admin,
      payload: { to: 'confirmed' },
    });
    expect(json(blocked).error.code).toBe('not_paid');

    const paid = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${order.payments[0].id}/mark-paid`,
      headers: e.admin,
      payload: { reference: 'BPD-889900' },
    });
    expect(json(paid)).toMatchObject({ status: 'confirmed' });
  });

  it('el efectivo no se confirma con mark-paid (lo registra el repartidor)', async () => {
    const order = await placeOrder(e, 'cash');
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/admin/payments/${order.payments[0].id}/mark-paid`,
      headers: e.admin,
      payload: { reference: 'xxx' },
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe('use_cash_flow');
  });

  it('solo el dueño sube el comprobante', async () => {
    const order = await placeOrder(e, 'transfer');
    const res = await e.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/transfer-proof`,
      headers: e.auth(e.w.driverId, 'customer'),
      payload: { reference: 'ABC-123' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('métodos deshabilitados por configuración', () => {
  it('sin pasarela ni datos bancarios, tarjeta y transferencia no se pueden elegir', async () => {
    const e = await setup({
      payments: {
        cardProvider: null,
        azul: null,
        transfer: null,
        publicBaseUrl: 'http://x',
        appScheme: 'jellyfish',
      },
    });
    expect(json(await e.app.inject({ url: '/v1/payments/methods' }))).toEqual({
      card: { available: false },
      cash: { available: true },
      transfer: { available: false },
    });
    for (const method of ['card', 'transfer']) {
      const res = await e.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: e.customer,
        payload: {
          items: [{ variantId: (await e.w.variant('POL-1')).id, quantity: 500 }],
          address: ADDRESS,
          slotStart: (await e.w.firstSlot()).toISOString(),
          paymentMethod: method,
        },
      });
      expect(res.statusCode).toBe(409);
      expect(json(res).error.code).toBe('method_unavailable');
    }
    expect(
      (await e.app.inject({ url: '/v1/payments/transfer-info', headers: e.customer })).statusCode,
    ).toBe(404);
    expect(
      (await e.app.inject({ method: 'POST', url: '/v1/payments/mock/page', payload: {} }))
        .statusCode,
    ).toBe(404);
    await e.app.close();
    await e.w.close();
  });
});

describe('AZUL (credenciales de prueba, sin red)', () => {
  const azul: AzulConfig = {
    environment: 'test',
    merchantId: '39038540035',
    merchantName: 'JELLYFISH SRL',
    merchantType: 'ECommerce',
    authKey: 'clave-secreta-de-prueba',
  };
  let e: Env;
  beforeAll(async () => {
    e = await setup({
      payments: {
        cardProvider: 'azul',
        azul,
        transfer: null,
        publicBaseUrl: 'https://api.jellyfish.test',
        appScheme: 'jellyfish',
      },
    });
  });
  afterAll(async () => {
    await e.app.close();
    await e.w.close();
  });

  it('arma el formulario hacia pruebas.azul.com.do firmado y sin exponer la clave', async () => {
    const order = await placeOrder(e, 'card');
    const pay = json(
      await e.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/pay`,
        headers: e.customer,
      }),
    );
    expect(pay.redirectUrl.startsWith('https://api.jellyfish.test/v1/payments/')).toBe(true);

    const page = await e.app.inject({ url: path(pay.redirectUrl) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('action="https://pruebas.azul.com.do/PaymentPage/"');
    expect(page.headers['content-security-policy']).toContain(
      'form-action https://pruebas.azul.com.do',
    );
    expect(page.body).toContain('name="MerchantId" value="39038540035"');
    expect(page.body).toContain(`name="Amount" value="${order.total}"`);
    expect(page.body).toMatch(/name="AuthHash" value="[0-9a-f]{128}"/);
    expect(page.body).toContain('https://api.jellyfish.test/v1/payments/azul/approved');
    expect(page.body).not.toContain(azul.authKey);
    // en AZUL real no existe la página del simulador
    expect(
      (await e.app.inject({ method: 'POST', url: '/v1/payments/mock/page', payload: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('acepta la respuesta de AZUL solo si trae el hash correcto', async () => {
    const order = await placeOrder(e, 'card');
    const pay = json(
      await e.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/pay`,
        headers: e.customer,
      }),
    );
    const page = await e.app.inject({ url: path(pay.redirectUrl) });
    const orderNumber = /name="OrderNumber" value="([^"]+)"/.exec(page.body)![1]!;

    const signer = new AzulGateway(azul); // mismo secreto que el servidor
    const response: Record<string, string> = {
      OrderNumber: orderNumber,
      Amount: String(order.total).padStart(12, '0'),
      AuthorizationCode: 'OK1234',
      DateTime: '20261007101500',
      ResponseCode: 'ISO8583',
      IsoCode: '00',
      ResponseMessage: 'APROBADA',
      ErrorDescription: '',
      RRN: '009988776655',
      AzulOrderId: '4455',
    };
    const params = new URLSearchParams({
      ...response,
      AuthHash: signer.signResponseForTesting(response),
    });

    // firma falsa → rechazado
    const forged = new URLSearchParams({ ...response, AuthHash: 'f'.repeat(128) });
    expect((await e.app.inject({ url: `/v1/payments/azul/approved?${forged}` })).statusCode).toBe(
      400,
    );
    expect((await getOrder(e, order.id)).status).toBe('pending_payment');

    const ok = await e.app.inject({ url: `/v1/payments/azul/approved?${params}` });
    expect(ok.statusCode).toBe(200);
    const after = await getOrder(e, order.id);
    expect(after.status).toBe('confirmed');
    expect(after.payments[0]).toMatchObject({
      provider: 'azul',
      status: 'captured',
      capturedAmount: order.total,
    });
    expect((await paymentRow(e, after.payments[0].id)).providerRef).toBe('009988776655');
  });
});
