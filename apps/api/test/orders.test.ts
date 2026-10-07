import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { inventoryMovements, orders } from '../src/db/schema';
import { DomainError } from '../src/errors';
import {
  assignDriver,
  createOrder,
  expireStaleOrders,
  getOrder,
  quoteOrder,
  recordWeights,
  transitionOrder,
} from '../src/services/orders';
import { ADDRESS, NOW, type World, makeWorld } from './helpers';

const admin = (w: World) => ({ id: w.adminId, role: 'admin' as const });

async function place(
  w: World,
  items: { sku: string; quantity: number }[],
  extra: Partial<Parameters<typeof createOrder>[1]> = {},
) {
  const resolved = await Promise.all(
    items.map(async (i) => ({ variantId: (await w.variant(i.sku)).id, quantity: i.quantity })),
  );
  return createOrder(w.ctx, {
    userId: w.customerId,
    items: resolved,
    address: ADDRESS,
    slotStart: await w.firstSlot(),
    paymentMethod: 'card',
    ...extra,
  });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('cotización', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('calcula líneas por libra y por unidad con el ITBIS de cada artículo', async () => {
    const pol = await w.variant('POL-1');
    const cmb = await w.variant('CMB-1');
    const q = await quoteOrder(w.ctx, {
      items: [
        { variantId: pol.id, quantity: 200 },
        { variantId: cmb.id, quantity: 1 },
      ],
    });
    expect(q.subtotal).toBe(34_990 + 245_000);
    expect(q.itbis).toBe(Math.round((245_000 * 1800) / 11_800));
    expect(q.total).toBe(q.subtotal);
    // colchón del 10 % solo sobre la parte de peso variable (la pechuga)
    expect(q.authorizedAmount).toBe(q.total + Math.ceil(34_990 * 0.1));
  });

  it('junta líneas repetidas del mismo artículo', async () => {
    const pol = await w.variant('POL-1');
    const q = await quoteOrder(w.ctx, {
      items: [
        { variantId: pol.id, quantity: 100 },
        { variantId: pol.id, quantity: 100 },
      ],
    });
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0]!.quantity).toBe(200);
  });

  it('valida mínimo, paso y máximo por libra', async () => {
    const pol = await w.variant('POL-1');
    const cam = await w.variant('CAM-1');
    await expectCode(
      quoteOrder(w.ctx, { items: [{ variantId: pol.id, quantity: 50 }] }),
      'validation',
    );
    await expectCode(
      quoteOrder(w.ctx, { items: [{ variantId: pol.id, quantity: 125 }] }),
      'validation',
    );
    await expectCode(
      quoteOrder(w.ctx, { items: [{ variantId: cam.id, quantity: 150 }] }),
      'validation',
    );
    await expectCode(
      quoteOrder(w.ctx, { items: [{ variantId: pol.id, quantity: 20_000 }] }),
      'validation',
    );
  });

  it('rechaza carrito vacío y productos inexistentes', async () => {
    await expectCode(quoteOrder(w.ctx, { items: [] }), 'validation');
    await expectCode(
      quoteOrder(w.ctx, {
        items: [{ variantId: '00000000-0000-4000-8000-000000000000', quantity: 100 }],
      }),
      'invalid_item',
    );
  });

  it('avisa cuando no hay suficiente existencia', async () => {
    const cmb = await w.variant('CMB-1'); // 5 unidades
    await expect(
      quoteOrder(w.ctx, { items: [{ variantId: cmb.id, quantity: 6 }] }),
    ).rejects.toMatchObject({ code: 'out_of_stock', details: { available: 5 } });
  });

  it('bloquea artículos con precio estimado fuera de modo demo', async () => {
    const est = await w.variant('EST-1');
    await expectCode(
      quoteOrder(w.ctx, { items: [{ variantId: est.id, quantity: 100 }] }),
      'unavailable',
    );
  });

  it('en modo demo sí permite vender el estimado y lo señala', async () => {
    const demo = await makeWorld({ demo: true });
    const est = await demo.variant('EST-1');
    const q = await quoteOrder(demo.ctx, { items: [{ variantId: est.id, quantity: 100 }] });
    expect(q.demo).toBe(true);
    expect(q.total).toBe(30_000);
    await demo.close();
  });
});

describe('crear pedido', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('pedido con tarjeta: queda pendiente de pago, reserva stock y vence', async () => {
    const before = await w.variant('POL-1');
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }]); // 5 lb = 874.75
    expect(order.status).toBe('pending_payment');
    expect(order.code).toMatch(/^JF-\d{6}$/);
    expect(order.subtotal).toBe(87_475);
    expect(order.deliveryFee).toBe(15_000);
    expect(order.total).toBe(102_475);
    expect(order.authorizedAmount).toBe(order.total + Math.ceil(87_475 * 0.1));
    expect(order.reservationExpiresAt!.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    expect(order.items[0]).toMatchObject({ sku: 'POL-1', quantity: 500, lineTotal: 87_475 });
    expect(order.timeline.map((e) => e.toStatus)).toEqual(['pending_payment']);

    const after = await w.variant('POL-1');
    expect(after.reserved - before.reserved).toBe(500);
    expect(after.onHand).toBe(before.onHand);
  });

  it('pago contra entrega: se confirma al instante y no vence', async () => {
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    expect(order.status).toBe('confirmed');
    expect(order.reservationExpiresAt).toBeNull();
  });

  it('transferencia: reserva más tiempo', async () => {
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'transfer' });
    expect(order.reservationExpiresAt!.getTime()).toBe(NOW.getTime() + 120 * 60_000);
  });

  it('envío gratis sobre el umbral de la zona', async () => {
    const order = await place(w, [{ sku: 'CMB-1', quantity: 2 }]); // 4,900 > 4,000
    expect(order.deliveryFee).toBe(0);
  });

  it('rechaza direcciones fuera de zona', async () => {
    await expectCode(
      place(w, [{ sku: 'POL-1', quantity: 500 }], {
        address: { ...ADDRESS, sector: 'Higüey', city: 'Higüey' },
      }),
      'out_of_zone',
    );
  });

  it('exige el pedido mínimo de la zona y dice cuánto falta', async () => {
    await expect(place(w, [{ sku: 'POL-1', quantity: 100 }])).rejects.toMatchObject({
      code: 'below_minimum',
      details: { missing: 80_000 - 17_495 },
    });
  });

  it('rechaza franjas que no se ofrecen', async () => {
    await expectCode(
      place(w, [{ sku: 'POL-1', quantity: 500 }], { slotStart: new Date('2026-10-07T14:00:00Z') }),
      'validation',
    );
  });

  it('no deja registros a medias cuando falla (transacción)', async () => {
    const before = await w.handle.db.select().from(orders);
    await expectCode(place(w, [{ sku: 'CMB-1', quantity: 20 }]), 'out_of_stock');
    expect(await w.handle.db.select().from(orders)).toHaveLength(before.length);
  });
});

describe('concurrencia de stock y cupos', () => {
  it('con 3 lb disponibles y dos pedidos de 2 lb a la vez, solo uno se queda con ellas', async () => {
    const w = await makeWorld();
    const { variants } = await import('../src/db/schema');
    await w.handle.db
      .update(variants)
      .set({ onHand: 400, reserved: 0 })
      .where(eq(variants.sku, 'CAM-1'));
    // 4 lb en total pero 1 lb de colchón: pedimos 3 lb + 3 lb de camarón (RD$ 2,639 c/u)
    const attempts = await Promise.allSettled([
      place(w, [{ sku: 'CAM-1', quantity: 300 }]),
      place(w, [{ sku: 'CAM-1', quantity: 300 }]),
    ]);
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as DomainError).code).toBe('out_of_stock');
    expect((await w.variant('CAM-1')).reserved).toBe(300);
    await w.close();
  });

  it('respeta la capacidad de la franja', async () => {
    const w = await makeWorld({
      windows: {
        startHour: 10,
        endHour: 20,
        windowHours: 2,
        capacityPerWindow: 2,
        leadMinutes: 90,
        daysAhead: 3,
      },
    });
    await place(w, [{ sku: 'POL-1', quantity: 500 }]);
    await place(w, [{ sku: 'POL-1', quantity: 500 }]);
    await expect(place(w, [{ sku: 'POL-1', quantity: 500 }])).rejects.toThrow(/llena/);
    await w.close();
  });
});

describe('ciclo de vida del pedido', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('confirmar → preparar → pesar → empacar → entregar, con inventario y totales reales', async () => {
    const pol0 = await w.variant('POL-1');
    const cmb0 = await w.variant('CMB-1');
    let order = await place(w, [
      { sku: 'POL-1', quantity: 500 }, // 5 lb pedidas
      { sku: 'CMB-1', quantity: 1 },
    ]);
    expect(order.total).toBe(87_475 + 245_000 + 15_000); // subtotal + envío (bajo el umbral gratis)

    order = await transitionOrder(w.ctx, order.id, 'confirmed', admin(w), 'Pago recibido');
    expect(order.reservationExpiresAt).toBeNull();
    order = await transitionOrder(w.ctx, order.id, 'picking', admin(w));

    // no se puede empacar sin pesar la pechuga
    await expectCode(transitionOrder(w.ctx, order.id, 'packed', admin(w)), 'weights_missing');

    const pechuga = order.items.find((i) => i.sku === 'POL-1')!;
    order = await recordWeights(w.ctx, order.id, [{ itemId: pechuga.id, finalQuantity: 523 }]); // 5.23 lb
    order = await transitionOrder(w.ctx, order.id, 'packed', admin(w));

    const finalPechuga = order.items.find((i) => i.sku === 'POL-1')!;
    expect(finalPechuga.finalQuantity).toBe(523);
    expect(finalPechuga.finalLineTotal).toBe(Math.round((17_495 * 523) / 100)); // 91,499
    // El envío queda como se cobró al pedir, aunque el peso real cambie el subtotal.
    expect(order.finalTotal).toBe(91_499 + 245_000 + 15_000);
    expect(order.total).toBe(87_475 + 245_000 + 15_000); // el estimado original se conserva
    expect(order.finalTotal!).toBeLessThanOrEqual(order.authorizedAmount);

    // inventario: descuenta el peso REAL y libera la reserva original
    const pol1 = await w.variant('POL-1');
    expect(pol1.onHand).toBe(pol0.onHand - 523);
    expect(pol1.reserved).toBe(pol0.reserved);
    const cmb1 = await w.variant('CMB-1');
    expect(cmb1.onHand).toBe(cmb0.onHand - 1);

    await expectCode(transitionOrder(w.ctx, order.id, 'out_for_delivery', admin(w)), 'no_driver');
    order = await assignDriver(w.ctx, order.id, w.driverId);
    const driver = { id: w.driverId, role: 'driver' as const };
    order = await transitionOrder(w.ctx, order.id, 'out_for_delivery', driver);
    order = await transitionOrder(w.ctx, order.id, 'delivered', driver);
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt).toEqual(NOW);
    expect(order.timeline.map((e) => e.toStatus)).toEqual([
      'pending_payment',
      'confirmed',
      'picking',
      'packed',
      'out_for_delivery',
      'delivered',
    ]);
  });

  it('rechaza pesos absurdos (báscula mal tarada)', async () => {
    let order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    const item = order.items[0]!;
    await expectCode(
      recordWeights(w.ctx, order.id, [{ itemId: item.id, finalQuantity: 5000 }]),
      'validation',
    );
    await expectCode(
      recordWeights(w.ctx, order.id, [{ itemId: item.id, finalQuantity: 100 }]),
      'validation',
    );
    order = await recordWeights(w.ctx, order.id, [{ itemId: item.id, finalQuantity: 450 }]);
    expect(order.items[0]!.finalQuantity).toBe(450);
  });

  it('no pesa artículos de cantidad fija', async () => {
    const order = await place(
      w,
      [
        { sku: 'CMB-1', quantity: 1 },
        { sku: 'POL-1', quantity: 500 },
      ],
      {
        paymentMethod: 'cash',
      },
    );
    const combo = order.items.find((i) => i.sku === 'CMB-1')!;
    await expectCode(
      recordWeights(w.ctx, order.id, [{ itemId: combo.id, finalQuantity: 1 }]),
      'validation',
    );
  });

  it('prohíbe saltos y retrocesos de estado', async () => {
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    await expectCode(transitionOrder(w.ctx, order.id, 'delivered', admin(w)), 'invalid_transition');
    await expectCode(
      transitionOrder(w.ctx, order.id, 'pending_payment', admin(w)),
      'invalid_transition',
    );
  });
});

describe('cancelaciones y vencimiento', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('cancelar libera la reserva', async () => {
    const before = await w.variant('POL-1');
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }]);
    expect((await w.variant('POL-1')).reserved).toBe(before.reserved + 500);
    const cancelled = await transitionOrder(
      w.ctx,
      order.id,
      'cancelled',
      { id: w.customerId, role: 'customer' },
      'Me equivoqué',
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Me equivoqué');
    expect((await w.variant('POL-1')).reserved).toBe(before.reserved);
  });

  it('el cliente no puede cancelar una vez empezamos a prepararlo', async () => {
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    await expect(
      transitionOrder(w.ctx, order.id, 'cancelled', { id: w.customerId, role: 'customer' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('un cliente no puede tocar pedidos ajenos (404, no 403)', async () => {
    const order = await place(w, [{ sku: 'POL-1', quantity: 500 }]);
    await expect(
      transitionOrder(w.ctx, order.id, 'cancelled', { id: w.driverId, role: 'customer' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getOrder(w.ctx, order.id, { userId: w.driverId })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('cancelar un pedido ya empacado devuelve el producto al inventario', async () => {
    const pol0 = await w.variant('POL-1');
    let order = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    order = await recordWeights(w.ctx, order.id, [
      { itemId: order.items[0]!.id, finalQuantity: 510 },
    ]);
    await transitionOrder(w.ctx, order.id, 'packed', admin(w));
    expect((await w.variant('POL-1')).onHand).toBe(pol0.onHand - 510);
    await transitionOrder(w.ctx, order.id, 'cancelled', admin(w), 'Cliente no contesta');
    const after = await w.variant('POL-1');
    expect(after.onHand).toBe(pol0.onHand);
    expect(after.reserved).toBe(pol0.reserved);
  });

  it('expireStaleOrders cancela lo no pagado a tiempo y libera el stock', async () => {
    const base = await w.variant('CAM-1');
    const stale = await place(w, [
      { sku: 'CAM-1', quantity: 100 },
      { sku: 'POL-1', quantity: 500 },
    ]);
    const cash = await place(w, [{ sku: 'POL-1', quantity: 500 }], { paymentMethod: 'cash' });
    const later = { ...w.ctx, now: () => new Date(NOW.getTime() + 16 * 60_000) };
    expect(await expireStaleOrders(later)).toBeGreaterThanOrEqual(1);
    expect((await getOrder(w.ctx, stale.id)).status).toBe('cancelled');
    expect((await getOrder(w.ctx, cash.id)).status).toBe('confirmed');
    expect((await w.variant('CAM-1')).reserved).toBe(base.reserved);
  });

  it('deja bitácora de cada movimiento de inventario', async () => {
    const movements = await w.handle.db.select().from(inventoryMovements);
    const types = new Set(movements.map((m) => m.type));
    expect(types.has('receive')).toBe(true);
    expect(types.has('reserve')).toBe(true);
    expect(types.has('release')).toBe(true);
  });
});
