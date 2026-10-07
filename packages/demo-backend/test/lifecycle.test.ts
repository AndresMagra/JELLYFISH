import { computeOrderTotals } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import { clientFor, fakeClock, makeServer, placeOrder, variantBySku } from './helpers';

const S = 1000;

function setup(speed = 1) {
  const clock = fakeClock();
  const { server } = makeServer({ speed }, clock);
  const c = clientFor(server);
  const { token } = c.login();
  return { clock, server, c, token };
}

const statusOf = (c: ReturnType<typeof clientFor>, token: string, id: string) =>
  c.call('GET', `/v1/orders/${id}`, { token }).body.status as string;

describe('ciclo del pedido con reloj falso (efectivo)', () => {
  it('confirmado → preparando → empacado → en camino → entregado, a ≈ 25/20/20/30 s por etapa', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token);
    expect(res.status).toBe(201);
    const id = res.body.id;
    expect(res.body.status).toBe('confirmed');

    const seen: [number, string][] = [];
    for (let s = 0; s <= 100; s += 5) {
      clock.set(clock.now() + (s === 0 ? 0 : 5 * S));
      seen.push([s, statusOf(c, token, id)]);
    }
    const at = (s: number) => seen.find(([t]) => t === s)![1];
    expect(at(20)).toBe('confirmed');
    expect(at(25)).toBe('picking');
    expect(at(40)).toBe('picking');
    expect(at(45)).toBe('packed');
    expect(at(60)).toBe('packed');
    expect(at(65)).toBe('out_for_delivery');
    expect(at(90)).toBe('out_for_delivery');
    expect(at(95)).toBe('delivered');
  });

  it('?speed= acelera todo: con speed 5 cada etapa dura la quinta parte', () => {
    const { clock, c, token } = setup(5);
    const { res } = placeOrder(c, token);
    const id = res.body.id;
    clock.advance(5 * S);
    expect(statusOf(c, token, id)).toBe('picking');
    clock.advance(4 * S);
    expect(statusOf(c, token, id)).toBe('packed');
    clock.advance(4 * S);
    expect(statusOf(c, token, id)).toBe('out_for_delivery');
    clock.advance(6 * S);
    expect(statusOf(c, token, id)).toBe('delivered');
  });

  it('el PIN se ve desde la confirmación hasta la entrega y no cambia', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token);
    const pin = res.body.deliveryPin as string;
    expect(pin).toMatch(/^\d{4}$/);
    expect(res.body.pinRequired).toBe(true);
    expect(res.body.pinAttemptsLeft).toBe(5);
    for (const secs of [30, 50, 70]) {
      clock.set(Date.parse('2026-10-07T14:00:00Z') + secs * S);
      const o = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body;
      expect(o.deliveryPin).toBe(pin);
    }
    clock.set(Date.parse('2026-10-07T14:00:00Z') + 100 * S);
    const done = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body;
    expect(done.status).toBe('delivered');
    expect(done.deliveryPin).toBeNull();
    expect(done.pinVerifiedAt).not.toBeNull();
    expect(done.deliveredAt).not.toBeNull();
  });

  it('al empacar pesa de verdad: peso real, total final y el cobro en efectivo del monto real', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token);
    const id = res.body.id;
    expect(res.body.finalTotal).toBeNull();
    expect(res.body.items[0].finalQuantity).toBeNull();

    clock.advance(50 * S); // empacado
    const packed = c.call('GET', `/v1/orders/${id}`, { token }).body;
    expect(packed.status).toBe('packed');
    const item = packed.items[0];
    expect(item.finalQuantity).toBeGreaterThan(0);
    expect(item.finalQuantity).toBeGreaterThanOrEqual(Math.floor(item.quantity * 0.94));
    expect(item.finalQuantity).toBeLessThanOrEqual(Math.ceil(item.quantity * 1.07));

    // El total final sale del MISMO código de dinero que usa el API.
    const totals = computeOrderTotals(
      [
        {
          id: item.id,
          pricingUnit: item.pricingUnit,
          unitPrice: item.unitPrice,
          itbisBps: 1800,
          quantity: item.finalQuantity,
          variableWeight: true,
        },
      ],
      { discount: 0, deliveryFee: packed.deliveryFee },
    );
    expect(packed.finalTotal).toBe(totals.total);
    expect(packed.finalTotal).toBeLessThanOrEqual(packed.authorizedAmount);
    expect(packed.payments[0].amount).toBe(packed.finalTotal); // el efectivo pendiente se ajusta

    clock.advance(60 * S); // entregado
    const done = c.call('GET', `/v1/orders/${id}`, { token }).body;
    expect(done.status).toBe('delivered');
    expect(done.payments[0]).toMatchObject({
      status: 'captured',
      capturedAmount: done.finalTotal,
    });
  });

  it('el inventario se reserva al pedir y se descuenta (peso real) al empacar', () => {
    const { clock, c, token } = setup();
    const v0 = variantBySku(c, 'JF-MAR-004');
    const { res } = placeOrder(c, token, { quantity: 400 });
    expect(variantBySku(c, 'JF-MAR-004').available).toBe(v0.available - 400);
    clock.advance(50 * S);
    c.call('GET', `/v1/orders/${res.body.id}`, { token });
    const final = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body.items[0]
      .finalQuantity as number;
    expect(variantBySku(c, 'JF-MAR-004').available).toBe(v0.available - final);
  });

  it('el seguimiento solo existe en camino y el repartidor se mueve entre dos puntos de Santo Domingo', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token);
    const id = res.body.id;
    expect(c.call('GET', `/v1/orders/${id}/tracking`, { token }).body).toEqual({
      available: false,
      reason: 'not_out_for_delivery',
    });
    clock.advance(66 * S);
    const first = c.call('GET', `/v1/orders/${id}/tracking`, { token });
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body.available).toBe(true);
    clock.advance(20 * S);
    const later = c.call('GET', `/v1/orders/${id}/tracking`, { token }).body;
    expect(later.available).toBe(true);
    for (const p of [first.body, later]) {
      expect(p.latitude).toBeGreaterThan(17.3);
      expect(p.latitude).toBeLessThan(20.1);
      expect(p.longitude).toBeGreaterThan(-72.1);
      expect(p.longitude).toBeLessThan(-68.2);
      expect(p.ageSeconds).toBeGreaterThanOrEqual(0);
      expect(p.ageSeconds).toBeLessThan(4);
    }
    // Se acerca al destino con el tiempo.
    const dist = (p: { latitude: number; longitude: number }) =>
      Math.hypot(p.latitude - 18.4861, p.longitude + 69.9312);
    expect(dist(later)).toBeLessThan(dist(first.body));
    clock.advance(40 * S);
    expect(c.call('GET', `/v1/orders/${id}/tracking`, { token }).body).toEqual({
      available: false,
      reason: 'not_out_for_delivery',
    });
  });

  it('un pedido de otra persona es 404 (no se revela que existe)', () => {
    const { server, c, token } = setup();
    const { res } = placeOrder(c, token);
    const other = clientFor(server).login('829-555-0202');
    for (const path of [
      `/v1/orders/${res.body.id}`,
      `/v1/orders/${res.body.id}/tracking`,
      `/v1/orders/${res.body.id}/reorder`,
    ]) {
      const r = c.call('GET', path, { token: other.token });
      expect(r.status, path).toBe(404);
      expect(r.body.error.code).toBe('not_found');
    }
  });
});

describe('cancelar', () => {
  it('en confirmado libera el stock y anula el pago; luego ya no se puede cancelar', () => {
    const { clock, c, token } = setup();
    const v0 = variantBySku(c, 'JF-MAR-004');
    const { res } = placeOrder(c, token);
    clock.advance(10 * S);
    const cancel = c.call('POST', `/v1/orders/${res.body.id}/cancel`, {
      token,
      body: { reason: 'Cambié de idea' },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.cancelReason).toBe('Cambié de idea');
    expect(cancel.body.payments[0].status).toBe('voided');
    expect(variantBySku(c, 'JF-MAR-004').available).toBe(v0.available);
    const again = c.call('POST', `/v1/orders/${res.body.id}/cancel`, { token, body: {} });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('forbidden');
  });

  it('una vez que empezó la preparación no se puede cancelar (403, mismo mensaje del API)', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token);
    clock.advance(30 * S);
    const r = c.call('POST', `/v1/orders/${res.body.id}/cancel`, { token, body: {} });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe(
      'Solo puedes cancelar un pedido que aún no empezamos a preparar',
    );
  });
});

describe('pago con tarjeta simulado', () => {
  it('el banco simulado aprueba ≈ 2 s después de iniciar el pago y confirma el pedido', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token, { paymentMethod: 'card' });
    const id = res.body.id;
    expect(res.body.status).toBe('pending_payment');
    expect(res.body.deliveryPin).toBeNull(); // el PIN aparece al confirmar

    const pay = c.call('POST', `/v1/orders/${id}/pay`, { token });
    expect(pay.status).toBe(200);
    expect(pay.body).toMatchObject({ amount: res.body.total });
    expect(pay.body.redirectUrl).toMatch(/^https:\/\/demo\.jellyfish\.local\//);
    expect(pay.body.paymentId).toMatch(/^[0-9a-f-]{36}$/);

    clock.advance(1500);
    expect(statusOf(c, token, id)).toBe('pending_payment');
    clock.advance(600);
    const o = c.call('GET', `/v1/orders/${id}`, { token }).body;
    expect(o.status).toBe('confirmed');
    expect(o.deliveryPin).toMatch(/^\d{4}$/);
    expect(o.payments.at(-1)).toMatchObject({ status: 'captured', capturedAmount: o.total });
    expect(o.timeline.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'pending_payment',
      'confirmed',
    ]);
    expect(o.timeline.at(-1).note).toBe('Pago con tarjeta aprobado');

    // Después sigue el ciclo normal.
    clock.advance(26 * S);
    expect(statusOf(c, token, id)).toBe('picking');
    // Y no se puede pagar dos veces.
    const again = c.call('POST', `/v1/orders/${id}/pay`, { token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_payable');
  });

  it('si el peso real pesa menos, lo cobrado de más queda por devolver', () => {
    const { clock, c, token } = setup();
    // Se prueba con varios pedidos: el peso real es al azar y al menos uno cae por debajo de lo pedido.
    let refundSeen = 0;
    for (let i = 0; i < 8; i++) {
      const { res } = placeOrder(c, token, { paymentMethod: 'card', quantity: 400 });
      c.call('POST', `/v1/orders/${res.body.id}/pay`, { token });
      clock.advance(3 * S);
      clock.advance(50 * S);
      const o = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body;
      expect(o.status).toBe('packed');
      const refund = o.payments.at(-1).refundPending as number;
      expect(refund).toBe(Math.max(0, o.total - o.finalTotal));
      if (refund > 0) refundSeen++;
      c.call('POST', `/v1/orders/${res.body.id}/cancel`, { token, body: {} }); // 403: ya empacado
      clock.advance(120 * S);
    }
    expect(refundSeen).toBeGreaterThan(0);
  });

  it('cancelar un pedido pagado deja el dinero por devolver', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token, { paymentMethod: 'card' });
    c.call('POST', `/v1/orders/${res.body.id}/pay`, { token });
    clock.advance(3 * S);
    const cancel = c.call('POST', `/v1/orders/${res.body.id}/cancel`, {
      token,
      body: { reason: 'x' },
    });
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.payments.at(-1)).toMatchObject({
      status: 'captured',
      refundPending: res.body.total,
    });
  });

  it('cancelar antes de que el banco apruebe anula el intento: el pago nunca se cobra', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token, { paymentMethod: 'card' });
    c.call('POST', `/v1/orders/${res.body.id}/pay`, { token });
    clock.advance(500);
    c.call('POST', `/v1/orders/${res.body.id}/cancel`, { token, body: {} });
    clock.advance(10 * S);
    const o = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body;
    expect(o.status).toBe('cancelled');
    expect(o.payments.at(-1)).toMatchObject({ status: 'voided', capturedAmount: 0 });
  });

  it('la reserva sin pago vence a los 15 minutos y libera el stock', () => {
    const { clock, c, token } = setup();
    const v0 = variantBySku(c, 'JF-MAR-004');
    const { res } = placeOrder(c, token, { paymentMethod: 'card' });
    expect(res.body.reservationExpiresAt).toBe(new Date(clock.now() + 15 * 60_000).toISOString());
    clock.advance(14 * 60_000);
    expect(statusOf(c, token, res.body.id)).toBe('pending_payment');
    clock.advance(2 * 60_000);
    const o = c.call('GET', `/v1/orders/${res.body.id}`, { token }).body;
    expect(o.status).toBe('cancelled');
    expect(o.cancelReason).toBe('Reserva vencida sin pago');
    expect(variantBySku(c, 'JF-MAR-004').available).toBe(v0.available);
    const pay = c.call('POST', `/v1/orders/${res.body.id}/pay`, { token });
    expect(pay.status).toBe(409);
  });
});

describe('transferencia', () => {
  it('con la referencia enviada, la verificación simulada confirma el pedido unos segundos después', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token, { paymentMethod: 'transfer' });
    const id = res.body.id;
    expect(res.body.reservationExpiresAt).toBe(new Date(clock.now() + 120 * 60_000).toISOString());
    const info = c.call('GET', '/v1/payments/transfer-info', { token });
    expect(info.body).toMatchObject({
      bank: expect.any(String),
      accountNumber: expect.any(String),
    });

    const proof = c.call('POST', `/v1/orders/${id}/transfer-proof`, {
      token,
      body: { reference: '889900123' },
    });
    expect(proof.status).toBe(200);
    expect(proof.body.payments[0].proofSubmitted).toBe(true);
    expect(proof.body.status).toBe('pending_payment');
    clock.advance(7 * S);
    const o = c.call('GET', `/v1/orders/${id}`, { token }).body;
    expect(o.status).toBe('confirmed');
    expect(o.payments[0].status).toBe('captured');
  });

  it('sin referencia el pedido sigue esperando el pago', () => {
    const { clock, c, token } = setup();
    const { res } = placeOrder(c, token, { paymentMethod: 'transfer' });
    clock.advance(60 * S);
    expect(statusOf(c, token, res.body.id)).toBe('pending_payment');
  });
});

describe('persistencia (localStorage) y recargas', () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  };

  it('el pedido, la sesión y el stock sobreviven a recargar la página y el ciclo sigue corriendo', () => {
    const storage = memory();
    const clock = fakeClock();
    const a = makeServer({ storage, seed: 1 }, clock).server;
    const ca = clientFor(a);
    const { token } = ca.login();
    const { res } = placeOrder(ca, token);
    const id = res.body.id;
    expect(storage.map.size).toBe(1);

    // "Se cierra la pestaña" 70 s y se vuelve a abrir: otro servidor, mismo almacenamiento.
    clock.advance(70 * S);
    const b = makeServer({ storage, seed: 2 }, clock).server;
    const cb = clientFor(b);
    const o = cb.call('GET', `/v1/orders/${id}`, { token });
    expect(o.status).toBe(200);
    expect(o.body.status).toBe('out_for_delivery');
    expect(o.body.timeline.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'confirmed',
      'picking',
      'packed',
      'out_for_delivery',
    ]);
    // Los eventos quedan con la hora exacta en que tocaban, no con la hora de la recarga.
    expect(o.body.timeline[1].createdAt).toBe(new Date(T0() + 25 * S).toISOString());
    expect(cb.call('GET', '/v1/me', { token }).body.phone).toBe('+18095550101');
    expect(cb.call('GET', '/v1/me/addresses', { token }).body).toHaveLength(1);
    // Un segundo servidor con otra semilla no repite ids.
    const next = placeOrder(cb, token, { key: 'otra-clave-1' });
    expect(next.res.body.id).not.toBe(id);
    expect(next.res.body.number).toBe(2);
  });

  it('sin almacenamiento, o con uno roto, la demostración funciona igual', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
      removeItem: () => {
        throw new Error('bloqueado');
      },
    };
    for (const storage of [null, broken]) {
      const { server } = makeServer({ storage });
      const c = clientFor(server);
      const { token } = c.login();
      expect(placeOrder(c, token).res.status).toBe(201);
    }
  });

  it('un estado guardado de otro catálogo se descarta (no mezcla precios viejos)', () => {
    const storage = memory();
    const clock = fakeClock();
    const a = clientFor(makeServer({ storage }, clock).server);
    placeOrder(a, a.login().token);
    const changed = SEED_WITH_OTHER_PRICE();
    const b = clientFor(makeServer({ storage, catalogCsv: changed }, clock).server);
    const { token } = b.login(); // la sesión vieja tampoco sobrevive
    expect(b.call('GET', '/v1/orders', { token }).body).toEqual([]);
    expect(variantBySku(b, 'JF-MAR-001').price).toBe(17063);
  });

  it('reset() borra todo', () => {
    const storage = memory();
    const { server } = makeServer({ storage });
    const c = clientFor(server);
    const { token } = c.login();
    placeOrder(c, token);
    server.reset();
    expect(storage.map.size).toBe(0);
    expect(c.call('GET', '/v1/me', { token }).status).toBe(401);
  });
});

function T0() {
  return Date.parse('2026-10-07T14:00:00Z');
}

import { SEED_CSV } from './helpers';
function SEED_WITH_OTHER_PRICE(): string {
  return SEED_CSV.replace('169.63', '170.63');
}
