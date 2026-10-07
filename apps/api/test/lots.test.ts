import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { inventoryMovements, orders, products, stockLots, users, variants } from '../src/db/schema';
import { MemoryOtpSender } from '../src/services/auth';
import {
  addDays,
  classifyLot,
  consumeFefo,
  daysBetween,
  isCalendarDate,
  localDate,
  reconcileLots,
} from '../src/services/lots';
import { ADDRESS, NOW, SMALL_CSV, type World, makeWorld } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const TODAY = '2026-10-07'; // día local de RD en NOW (10:00 en UTC-4)
const day = (n: number) => addDays(TODAY, n);

describe('lotes: fechas y clasificación', () => {
  it('el día local de RD sigue a UTC-4, no a UTC', () => {
    expect(localDate(new Date('2026-10-07T14:00:00Z'), -240)).toBe('2026-10-07');
    // 02:00 UTC del 8 son las 22:00 del 7 en RD
    expect(localDate(new Date('2026-10-08T02:00:00Z'), -240)).toBe('2026-10-07');
    expect(localDate(new Date('2026-10-08T04:00:00Z'), -240)).toBe('2026-10-08');
  });

  it('valida fechas de calendario reales', () => {
    expect(isCalendarDate('2026-10-07')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    for (const bad of [
      '2026-02-30',
      '2026-13-01',
      '2026-1-7',
      '07/10/2026',
      '',
      '2026-10-07T00:00',
    ]) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
  });

  it('suma días y los cuenta con signo, también al cruzar mes y año', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-07', '2026-10-17')).toBe(10);
    expect(daysBetween('2026-10-07', '2026-10-06')).toBe(-1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('vence hoy sigue siendo válido; ayer ya venció; hasta 7 días es por vencer', () => {
    expect(classifyLot(day(-1), TODAY)).toEqual({ daysLeft: -1, status: 'expired' });
    expect(classifyLot(day(0), TODAY)).toEqual({ daysLeft: 0, status: 'expiring' });
    expect(classifyLot(day(7), TODAY)).toEqual({ daysLeft: 7, status: 'expiring' });
    expect(classifyLot(day(8), TODAY)).toEqual({ daysLeft: 8, status: 'ok' });
    expect(classifyLot(null, TODAY)).toEqual({ daysLeft: null, status: 'no_expiry' });
  });
});

describe('lotes con vencimiento (FEFO)', () => {
  let w: World;
  let app: FastifyInstance;
  let clock = NOW;
  let admin: Record<string, string>;
  let staff: Record<string, string>;
  let customer: Record<string, string>;
  let driver: Record<string, string>;
  let staffId: string;
  let seq = 0;

  const sign = (id: string, role: 'customer' | 'admin' | 'staff' | 'driver') => ({
    authorization: `Bearer ${app.jwt.sign({ sub: id, role })}`,
  });

  beforeAll(async () => {
    w = await makeWorld({
      windows: {
        startHour: 10,
        endHour: 20,
        windowHours: 2,
        capacityPerWindow: 500,
        leadMinutes: 90,
        daysAhead: 3,
      },
    });
    // Reloj propio: algunas pruebas necesitan que dos lotes entren en momentos distintos.
    app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      now: () => clock,
    });
    const [s] = await w.handle.db
      .insert(users)
      .values({ phone: '+18095550004', name: 'Almacén', role: 'staff' })
      .returning({ id: users.id });
    staffId = s!.id;
    admin = sign(w.adminId, 'admin');
    staff = sign(staffId, 'staff');
    customer = sign(w.customerId, 'customer');
    driver = sign(w.driverId, 'driver');
  });
  afterAll(async () => {
    await app.close();
    // Las pruebas que fuerzan errores de la base dejan conexiones cerrándose; con Postgres real hay que
    // dejarlas terminar antes de que el cierre borre la base (DROP DATABASE … FORCE las corta).
    await new Promise((resolve) => setTimeout(resolve, 300));
    await w.close();
  });

  /** Artículo nuevo por prueba: así los lotes de una no contaminan a otra. */
  async function makeVariant(onHand: number, pricingUnit: 'lb' | 'unit' = 'lb') {
    const sku = `LOT-${++seq}`;
    const [product] = await w.handle.db
      .insert(products)
      .values({
        group: sku.toLowerCase(),
        name: `Producto ${sku}`,
        categorySlug: 'aves',
        pricingUnit,
      })
      .returning({ id: products.id });
    const [v] = await w.handle.db
      .insert(variants)
      .values({
        productId: product!.id,
        sku,
        pricingUnit,
        // RD$1,000 por libra: así cualquier pedido de 1 lb ya supera el mínimo de la zona de pruebas.
        price: 100_000,
        priceSource: 'usuario',
        itbisBps: 0,
        variableWeight: pricingUnit === 'lb',
        stepCentilb: pricingUnit === 'lb' ? 50 : null,
        minCentilb: pricingUnit === 'lb' ? 100 : null,
        onHand,
      })
      .returning({ id: variants.id });
    return v!.id;
  }

  const receive = (
    variantId: string,
    body: Partial<{
      lotCode: string;
      expiresOn: string;
      quantity: number;
      unitCostCentavos: number | null;
      note: string;
    }> = {},
    headers = admin,
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/admin/inventory/lots',
      headers,
      payload: { variantId, lotCode: `L-${++seq}`, expiresOn: day(10), quantity: 500, ...body },
    });

  const lotsOf = (variantId: string) =>
    w.handle.db
      .select()
      .from(stockLots)
      .where(eq(stockLots.variantId, variantId))
      .orderBy(asc(stockLots.lotCode));
  const remaining = async (variantId: string) =>
    Object.fromEntries((await lotsOf(variantId)).map((l) => [l.lotCode, l.qtyRemaining]));
  const stock = async (variantId: string) => {
    const [v] = await w.handle.db.select().from(variants).where(eq(variants.id, variantId));
    return v!;
  };
  const movements = (variantId: string) =>
    w.handle.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.variantId, variantId))
      .orderBy(asc(inventoryMovements.createdAt));

  /** Pedido en efectivo listo para empacar (ya pesado). */
  async function prepare(variantId: string, quantity: number, finalQuantity = quantity) {
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: {
          items: [{ variantId, quantity }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      }),
    );
    expect(created.id, JSON.stringify(created)).toBeTruthy();
    const step = (to: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to },
      });
    expect((await step('picking')).statusCode).toBe(200);
    const weigh = await app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${created.id}/weights`,
      headers: admin,
      payload: { weights: [{ itemId: created.items[0].id, finalQuantity }] },
    });
    expect(weigh.statusCode, weigh.body).toBe(200);
    return { orderId: created.id as string, step };
  }

  /** Pedido en efectivo hasta `packed`, con el peso real indicado. */
  async function pack(variantId: string, quantity: number, finalQuantity = quantity) {
    const order = await prepare(variantId, quantity, finalQuantity);
    const packed = await order.step('packed');
    expect(packed.statusCode, packed.body).toBe(200);
    return order;
  }

  /** Mientras `fn` corre, cualquier INSERT/UPDATE en stock_lots falla: sirve para probar atomicidad. */
  async function withFailingLots(event: 'INSERT' | 'UPDATE', fn: () => Promise<void>) {
    const { db } = w.handle;
    await db.execute(
      sql`CREATE FUNCTION jf_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla de prueba'; END $$`,
    );
    await db.execute(
      sql.raw(
        `CREATE TRIGGER jf_test_fail_trg BEFORE ${event} ON stock_lots FOR EACH ROW EXECUTE FUNCTION jf_test_fail()`,
      ),
    );
    try {
      await fn();
    } finally {
      await db.execute(sql`DROP TRIGGER jf_test_fail_trg ON stock_lots`);
      await db.execute(sql`DROP FUNCTION jf_test_fail()`);
    }
  }

  describe('recepción', () => {
    it('crea el lote y suma al inventario con un movimiento "receive" coherente', async () => {
      const id = await makeVariant(1000);
      const res = await receive(id, {
        lotCode: 'POL-2610-A',
        expiresOn: day(45),
        quantity: 1200,
        unitCostCentavos: 9_500,
        note: 'Proveedor Avícola',
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res)).toMatchObject({
        variantId: id,
        lotCode: 'POL-2610-A',
        expiresOn: day(45),
        daysLeft: 45,
        status: 'ok',
        qtyReceived: 1200,
        qtyRemaining: 1200,
        unitCostCentavos: 9_500,
        note: 'Proveedor Avícola',
        receivedBy: w.adminId,
      });

      expect((await stock(id)).onHand).toBe(2200);
      const log = await movements(id);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ type: 'receive', qty: 1200, actorId: w.adminId });
      expect(log[0]!.note).toContain('POL-2610-A');
      expect(log[0]!.note).toContain(day(45));
    });

    it('el personal de almacén también puede recibir; clientes y repartidores no', async () => {
      const id = await makeVariant(0);
      const ok = await receive(id, {}, staff);
      expect(ok.statusCode, ok.body).toBe(201);
      expect(json(ok).receivedBy).toBe(staffId);
      expect((await receive(id, {}, customer)).statusCode).toBe(403);
      expect((await receive(id, {}, driver)).statusCode).toBe(403);
      const anon = await app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/lots',
        payload: { variantId: id, lotCode: 'X', expiresOn: day(5), quantity: 100 },
      });
      expect(anon.statusCode).toBe(401);
      // Lo rechazado no dejó nada: solo existe el lote del personal.
      expect(await lotsOf(id)).toHaveLength(1);
      expect((await stock(id)).onHand).toBe(500);
    });

    it('rechaza datos inválidos sin tocar el inventario', async () => {
      const id = await makeVariant(1000);
      const bad: [string, Record<string, unknown>][] = [
        ['fecha mal escrita', { expiresOn: '07/11/2026' }],
        // Fechas que no existen pero que Date "corrige" en silencio (31 de noviembre → 1 de diciembre).
        ['31 de noviembre', { expiresOn: '2026-11-31' }],
        ['29 de febrero sin año bisiesto', { expiresOn: '2027-02-29' }],
        ['mes 13', { expiresOn: '2026-13-01' }],
        ['vencida hace más de 30 días', { expiresOn: day(-31) }],
        ['dentro de 6 años', { expiresOn: day(6 * 365) }],
        ['cantidad cero', { quantity: 0 }],
        ['cantidad negativa', { quantity: -5 }],
        ['cantidad decimal', { quantity: 2.5 }],
        ['código vacío', { lotCode: '   ' }],
        ['código con caracteres de control', { lotCode: 'A\u0007B' }],
        ['costo negativo', { unitCostCentavos: -1 }],
      ];
      for (const [name, patch] of bad) {
        const res = await receive(id, patch);
        expect(res.statusCode, `${name}: ${res.body}`).toBe(400);
      }
      expect(await lotsOf(id)).toEqual([]);
      expect((await stock(id)).onHand).toBe(1000);
      expect(await movements(id)).toEqual([]);
    });

    it('acepta un lote que venció hace poco (para darlo de baja) y lo marca vencido', async () => {
      const id = await makeVariant(0);
      const res = await receive(id, { expiresOn: day(-5), quantity: 300 });
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res)).toMatchObject({ daysLeft: -5, status: 'expired' });
    });

    it('artículo inexistente: 404; mismo código dos veces: 409 sin duplicar el stock', async () => {
      const ghost = await receive('00000000-0000-4000-8000-000000000000');
      expect(ghost.statusCode).toBe(404);

      const id = await makeVariant(0);
      const other = await makeVariant(0);
      expect((await receive(id, { lotCode: 'ABC-1', quantity: 400 })).statusCode).toBe(201);
      const dup = await receive(id, { lotCode: 'abc-1', quantity: 400 });
      expect(dup.statusCode).toBe(409);
      expect(json(dup).error.code).toBe('lot_exists');
      expect((await stock(id)).onHand).toBe(400); // no se contó dos veces
      expect(await movements(id)).toHaveLength(1);
      // El mismo código en OTRO artículo es normal (cada proveedor numera a su manera).
      expect((await receive(other, { lotCode: 'ABC-1' })).statusCode).toBe(201);
    });

    it('varias recepciones simultáneas del mismo código: entra una sola y el stock se cuenta una vez', async () => {
      const id = await makeVariant(0);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => receive(id, { lotCode: 'DOBLE-CLIC', quantity: 400 })),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409, 409, 409, 409]);
      expect(await lotsOf(id)).toHaveLength(1);
      expect((await stock(id)).onHand).toBe(400);
      expect(await movements(id)).toHaveLength(1);
    });

    it('es atómica: si falla guardar el lote, tampoco queda el movimiento ni el stock', async () => {
      const id = await makeVariant(1000);
      await withFailingLots('INSERT', async () => {
        const res = await receive(id, { quantity: 700 });
        expect(res.statusCode).toBe(500);
      });
      expect((await stock(id)).onHand).toBe(1000);
      expect(await movements(id)).toEqual([]);
      expect(await lotsOf(id)).toEqual([]);
    });

    it('para artículos por unidad la cantidad son unidades', async () => {
      const id = await makeVariant(5, 'unit');
      const res = await receive(id, { quantity: 12 });
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res)).toMatchObject({ pricingUnit: 'unit', qtyRemaining: 12 });
      expect((await stock(id)).onHand).toBe(17);
    });
  });

  describe('consumo al empacar (FEFO)', () => {
    it('descuenta primero el lote que vence antes, aunque haya entrado después', async () => {
      const id = await makeVariant(0);
      // Entran en este orden: A (vence en 10 días), B (en 3), C (en 20).
      await receive(id, { lotCode: 'A', expiresOn: day(10), quantity: 300 });
      await receive(id, { lotCode: 'B', expiresOn: day(3), quantity: 200 });
      await receive(id, { lotCode: 'C', expiresOn: day(20), quantity: 500 });

      await pack(id, 300);
      // 300 = todo B (200) y 100 de A. C intacto.
      expect(await remaining(id)).toEqual({ A: 200, B: 0, C: 500 });
      expect((await stock(id)).onHand).toBe(1000 - 300);
    });

    it('un empaque que cruza varios lotes usa el peso real, no el pedido', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'B', expiresOn: day(3), quantity: 200 });
      await receive(id, { lotCode: 'A', expiresOn: day(10), quantity: 300 });
      await receive(id, { lotCode: 'C', expiresOn: day(20), quantity: 500 });

      await pack(id, 500, 530); // pidieron 5 lb, pesó 5.30 lb
      expect(await remaining(id)).toEqual({ A: 0, B: 0, C: 470 });
      expect((await stock(id)).onHand).toBe(1000 - 530);
    });

    it('a igual vencimiento sale primero el lote que entró antes', async () => {
      const id = await makeVariant(0);
      clock = NOW;
      await receive(id, { lotCode: 'PRIMERO', expiresOn: day(9), quantity: 300 });
      clock = new Date(NOW.getTime() + 60_000);
      await receive(id, { lotCode: 'SEGUNDO', expiresOn: day(9), quantity: 300 });
      clock = NOW;

      await pack(id, 400);
      expect(await remaining(id)).toEqual({ PRIMERO: 0, SEGUNDO: 200 });
    });

    it('con stock sin lote: consume los lotes que haya y sigue sin error', async () => {
      const id = await makeVariant(2000); // 20 lb de antes de usar lotes
      await receive(id, { lotCode: 'ÚNICO', expiresOn: day(5), quantity: 300 });

      await pack(id, 500);
      expect(await remaining(id)).toEqual({ ÚNICO: 0 });
      const v = await stock(id);
      expect(v.onHand).toBe(2300 - 500);
      expect((await movements(id)).filter((m) => m.type === 'pick')).toHaveLength(1);
    });

    it('un artículo sin ningún lote se empaca como siempre', async () => {
      const id = await makeVariant(1000);
      await pack(id, 200);
      expect((await stock(id)).onHand).toBe(800);
      expect(await lotsOf(id)).toEqual([]);
    });

    it('lotes y bitácora de inventario cuadran: los lotes nunca suman más que el stock físico', async () => {
      const id = await makeVariant(500);
      await receive(id, { lotCode: 'A', expiresOn: day(4), quantity: 400 });
      await receive(id, { lotCode: 'B', expiresOn: day(12), quantity: 600 });
      await pack(id, 700);
      await pack(id, 500, 450);
      const v = await stock(id);
      const lots = await lotsOf(id);
      const lotTotal = lots.reduce((a, l) => a + l.qtyRemaining, 0);
      expect(lotTotal).toBeLessThanOrEqual(v.onHand);
      expect(lots.every((l) => l.qtyRemaining >= 0 && l.qtyRemaining <= l.qtyReceived)).toBe(true);
      // on_hand sale de la bitácora: recibido − empacado
      const net = (await movements(id))
        .filter((m) => m.type === 'receive' || m.type === 'pick')
        .reduce((a, m) => a + m.qty, 0);
      expect(v.onHand).toBe(500 + net);
      expect(v.onHand).toBe(500 + 1000 - 700 - 450);
    });

    it('dos pedidos empacándose a la vez no dejan un lote negativo ni cobran dos veces', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(3), quantity: 300 });
      await receive(id, { lotCode: 'B', expiresOn: day(6), quantity: 400 });
      const [one, two] = await Promise.all([pack(id, 300), pack(id, 300)]);
      expect(one.orderId).not.toBe(two.orderId);
      expect(await remaining(id)).toEqual({ A: 0, B: 100 });
      expect((await stock(id)).onHand).toBe(100);
    });

    it('cancelar un pedido ya empacado devuelve el stock como "sin lote" y no rompe la suma', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(5), quantity: 500 });
      const { step } = await pack(id, 300);
      expect(await remaining(id)).toEqual({ A: 200 });
      expect((await step('cancelled')).statusCode).toBe(200);
      const v = await stock(id);
      expect(v.onHand).toBe(500); // volvió al congelador
      expect(await remaining(id)).toEqual({ A: 200 }); // no sabemos de qué lote: queda sin lote
      expect(200).toBeLessThanOrEqual(v.onHand);
    });

    it('es atómico: si falla el descuento de lotes, el pedido no queda empacado ni se toca el stock', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 500 });
      const { orderId, step } = await prepare(id, 300);
      await withFailingLots('UPDATE', async () => {
        const res = await step('packed');
        expect(res.statusCode).toBe(500);
      });
      const [order] = await w.handle.db.select().from(orders).where(eq(orders.id, orderId));
      expect(order!.status).toBe('picking');
      expect(order!.finalTotal).toBeNull();
      const v = await stock(id);
      expect([v.onHand, v.reserved]).toEqual([500, 300]);
      expect(await remaining(id)).toEqual({ A: 500 });
      expect((await movements(id)).filter((m) => m.type === 'pick')).toEqual([]);
      // reintentar sin la falla funciona y descuenta una sola vez
      expect((await step('packed')).statusCode).toBe(200);
      expect(await remaining(id)).toEqual({ A: 200 });
      expect((await stock(id)).onHand).toBe(200);
    });

    it('los lotes nunca bloquean la venta: manda on_hand − reserved', async () => {
      const id = await makeVariant(3000);
      await receive(id, { lotCode: 'VIEJO', expiresOn: day(-3), quantity: 200 }); // ya vencido
      // 30 lb en stock, solo 2 lb "con lote" y vencidas: igual se puede pedir 25 lb
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: {
          items: [{ variantId: id, quantity: 2500 }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(ok.statusCode, ok.body).toBe(201);
      // y no se puede pedir más de lo que hay físicamente disponible
      const over = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: {
          items: [{ variantId: id, quantity: 1000 }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(over.statusCode).toBe(409);
    });
  });

  describe('mermas y ajustes manuales', () => {
    const adjust = (variantId: string, type: string, delta: number, headers = staff) =>
      app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/adjust',
        headers,
        payload: { variantId, type, delta, note: 'prueba' },
      });

    it('una merma descuenta de los lotes en orden FEFO y del stock', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      await receive(id, { lotCode: 'B', expiresOn: day(-2), quantity: 200 }); // vencido: se tira primero
      const res = await adjust(id, 'waste', -250);
      expect(res.statusCode, res.body).toBe(200);
      expect(await remaining(id)).toEqual({ A: 250, B: 0 });
      expect((await stock(id)).onHand).toBe(250);
      expect((await movements(id)).at(-1)).toMatchObject({ type: 'waste', qty: -250 });
    });

    it('un ajuste negativo (conteo menor) también baja los lotes', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      expect((await adjust(id, 'adjust', -100)).statusCode).toBe(200);
      expect(await remaining(id)).toEqual({ A: 200 });
      expect((await stock(id)).onHand).toBe(200);
    });

    it('un ajuste al alza o una entrada suelta suman stock SIN lote y no tocan los lotes', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      expect((await adjust(id, 'adjust', 150)).statusCode).toBe(200);
      expect((await adjust(id, 'receive', 100)).statusCode).toBe(200);
      expect(await remaining(id)).toEqual({ A: 300 });
      expect((await stock(id)).onHand).toBe(550);
    });

    it('una baja mayor que lo "con lote" vacía los lotes y el resto sale del stock sin lote', async () => {
      const id = await makeVariant(1000);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      expect((await adjust(id, 'waste', -800)).statusCode).toBe(200);
      expect(await remaining(id)).toEqual({ A: 0 });
      expect((await stock(id)).onHand).toBe(500);
    });

    it('si el ajuste se rechaza (bajaría de lo reservado) los lotes quedan intactos', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 500 });
      await w.handle.db.update(variants).set({ reserved: 400 }).where(eq(variants.id, id));
      const res = await adjust(id, 'waste', -300); // dejaría 200 < 400 reservadas
      expect(res.statusCode).toBe(409);
      expect(await remaining(id)).toEqual({ A: 500 });
      expect((await stock(id)).onHand).toBe(500);
    });

    it('los ajustes siguen siendo del personal', async () => {
      const id = await makeVariant(500);
      expect((await adjust(id, 'adjust', -10, customer)).statusCode).toBe(403);
      expect((await adjust(id, 'adjust', -10, driver)).statusCode).toBe(403);
    });

    it('es atómico: si falla descontar de los lotes, tampoco baja el stock ni queda la merma', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 500 });
      await withFailingLots('UPDATE', async () => {
        const res = await adjust(id, 'waste', -200);
        expect(res.statusCode).toBe(500);
      });
      expect((await stock(id)).onHand).toBe(500);
      expect(await remaining(id)).toEqual({ A: 500 });
      expect((await movements(id)).filter((m) => m.type === 'waste')).toEqual([]);
      // y sin la falla, la misma baja sí se aplica
      expect((await adjust(id, 'waste', -200)).statusCode).toBe(200);
      expect(await remaining(id)).toEqual({ A: 300 });
    });

    it('importar el catálogo aplicando existencias cuadra los lotes con el nuevo stock', async () => {
      const pol = await w.variant('POL-1');
      await receive(pol.id, { lotCode: 'IMP-1', expiresOn: day(6), quantity: 5000 });
      await receive(pol.id, { lotCode: 'IMP-2', expiresOn: day(30), quantity: 5000 });
      // El conteo físico del Excel dice que quedan 20 lb (2000) en total.
      const csv = SMALL_CSV.replace(/(POL-1,.*,)100$/m, (_m, head: string) => `${head}20`);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog/import?dryRun=0&applyStock=1',
        headers: { ...admin, 'content-type': 'text/csv' },
        payload: csv,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await stock(pol.id)).onHand).toBe(2000);
      expect(await remaining(pol.id)).toEqual({ 'IMP-1': 0, 'IMP-2': 2000 });
    });

    it('reconcileLots no toca lo que ya cuadra y corrige solo el exceso', async () => {
      const ok = await makeVariant(0);
      const off = await makeVariant(0);
      await receive(ok, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      await receive(off, { lotCode: 'B', expiresOn: day(2), quantity: 100 });
      await receive(off, { lotCode: 'C', expiresOn: day(8), quantity: 400 });
      // Alguien dejó el stock por debajo de los lotes sin pasar por los servicios.
      await w.handle.db.update(variants).set({ onHand: 250 }).where(eq(variants.id, off));
      expect(await reconcileLots(w.handle.db)).toBe(1);
      expect(await remaining(off)).toEqual({ B: 0, C: 250 });
      expect(await remaining(ok)).toEqual({ A: 300 });
      expect(await reconcileLots(w.handle.db)).toBe(0);
    });

    it('consumeFefo con cantidad cero o negativa no hace nada', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'A', expiresOn: day(9), quantity: 300 });
      expect(await consumeFefo(w.handle.db, id, 0)).toEqual({
        consumed: 0,
        shortfall: 0,
        allocations: [],
      });
      expect(await remaining(id)).toEqual({ A: 300 });
    });
  });

  describe('listados', () => {
    it('lista los lotes de un artículo por vencimiento y oculta los agotados', async () => {
      const id = await makeVariant(0);
      await receive(id, { lotCode: 'LEJOS', expiresOn: day(60), quantity: 100 });
      await receive(id, { lotCode: 'CERCA', expiresOn: day(2), quantity: 100 });
      await receive(id, { lotCode: 'AGOTADO', expiresOn: day(1), quantity: 100 });
      await w.handle.db
        .update(stockLots)
        .set({ qtyRemaining: 0 })
        .where(and(eq(stockLots.variantId, id), eq(stockLots.lotCode, 'AGOTADO')));

      const res = await app.inject({
        url: `/v1/admin/inventory/lots?variantId=${id}`,
        headers: staff,
      });
      expect(res.statusCode).toBe(200);
      expect(json(res).map((l: { lotCode: string }) => l.lotCode)).toEqual(['CERCA', 'LEJOS']);
      expect(json(res)[0]).toMatchObject({
        status: 'expiring',
        daysLeft: 2,
        sku: expect.any(String),
      });

      const all = json(
        await app.inject({
          url: `/v1/admin/inventory/lots?variantId=${id}&includeEmpty=1`,
          headers: staff,
        }),
      );
      expect(all.map((l: { lotCode: string }) => l.lotCode)).toEqual(['AGOTADO', 'CERCA', 'LEJOS']);
    });

    it('"por vencer" trae vencidos y próximos, con días restantes, y deja fuera lo lejano y lo agotado', async () => {
      const a = await makeVariant(0);
      const b = await makeVariant(0);
      await receive(a, { lotCode: 'X-VENCIDO', expiresOn: day(-4), quantity: 100 });
      await receive(a, { lotCode: 'X-HOY', expiresOn: day(0), quantity: 100 });
      await receive(b, { lotCode: 'X-30', expiresOn: day(30), quantity: 100 });
      await receive(b, { lotCode: 'X-31', expiresOn: day(31), quantity: 100 });
      await receive(b, { lotCode: 'X-VACIO', expiresOn: day(5), quantity: 100 });
      await w.handle.db
        .update(stockLots)
        .set({ qtyRemaining: 0 })
        .where(eq(stockLots.lotCode, 'X-VACIO'));

      const res = await app.inject({ url: '/v1/admin/inventory/expiring?days=30', headers: staff });
      expect(res.statusCode).toBe(200);
      const mine = json(res).filter((l: { lotCode: string }) => l.lotCode.startsWith('X-'));
      expect(
        mine.map((l: { lotCode: string; daysLeft: number; status: string }) => [
          l.lotCode,
          l.daysLeft,
          l.status,
        ]),
      ).toEqual([
        ['X-VENCIDO', -4, 'expired'],
        ['X-HOY', 0, 'expiring'],
        ['X-30', 30, 'ok'],
      ]);
      // el listado completo viene ordenado por vencimiento
      const dates = json(res).map((l: { expiresOn: string }) => l.expiresOn);
      expect(dates).toEqual([...dates].sort());

      // por defecto, 30 días
      const dflt = json(await app.inject({ url: '/v1/admin/inventory/expiring', headers: staff }));
      expect(dflt.some((l: { lotCode: string }) => l.lotCode === 'X-31')).toBe(false);
      const wide = json(
        await app.inject({ url: '/v1/admin/inventory/expiring?days=60', headers: staff }),
      );
      expect(wide.some((l: { lotCode: string }) => l.lotCode === 'X-31')).toBe(true);
    });

    it('valida los parámetros y protege los listados', async () => {
      for (const q of ['days=-1', 'days=400', 'days=abc']) {
        const res = await app.inject({ url: `/v1/admin/inventory/expiring?${q}`, headers: staff });
        expect(res.statusCode, q).toBe(400);
      }
      const badVariant = await app.inject({
        url: '/v1/admin/inventory/lots?variantId=no-es-uuid',
        headers: staff,
      });
      expect(badVariant.statusCode).toBe(400);
      for (const url of ['/v1/admin/inventory/lots', '/v1/admin/inventory/expiring']) {
        expect((await app.inject({ url, headers: customer })).statusCode, url).toBe(403);
        expect((await app.inject({ url, headers: driver })).statusCode, url).toBe(403);
        expect((await app.inject({ url })).statusCode, url).toBe(401);
      }
    });
  });
});

describe('lotes: resumen del panel', () => {
  let w: World;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  beforeAll(async () => {
    w = await makeWorld();
    app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: new MemoryOtpSender(),
      now: w.ctx.now,
    });
    admin = { authorization: `Bearer ${app.jwt.sign({ sub: w.adminId, role: 'admin' })}` };
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  const summary = async () =>
    json(await app.inject({ url: '/v1/admin/summary', headers: admin })) as {
      expiringSoon: number;
      expired: number;
    };

  it('cuenta lotes que vencen en ≤ 7 días y vencidos, solo si tienen saldo', async () => {
    expect(await summary()).toMatchObject({ expiringSoon: 0, expired: 0 });

    const pol = await w.variant('POL-1');
    const cam = await w.variant('CAM-1');
    const lot = (variantId: string, lotCode: string, expiresOn: string, quantity = 100) =>
      app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/lots',
        headers: admin,
        payload: { variantId, lotCode, expiresOn, quantity },
      });
    for (const [v, code, exp] of [
      [pol.id, 'HOY', day(0)], // por vencer
      [pol.id, 'EN7', day(7)], // por vencer (límite)
      [pol.id, 'EN8', day(8)], // aún no
      [cam.id, 'AYER', day(-1)], // vencido
      [cam.id, 'HACE9', day(-9)], // vencido
      [cam.id, 'VACIO', day(-2)], // vencido pero sin saldo: no cuenta
    ] as const) {
      expect((await lot(v, code, exp)).statusCode, code).toBe(201);
    }
    await w.handle.db
      .update(stockLots)
      .set({ qtyRemaining: 0 })
      .where(eq(stockLots.lotCode, 'VACIO'));

    expect(await summary()).toMatchObject({ expiringSoon: 2, expired: 2 });
  });

  it('el resumen sigue siendo solo para el personal', async () => {
    const customer = {
      authorization: `Bearer ${app.jwt.sign({ sub: w.customerId, role: 'customer' })}`,
    };
    expect((await app.inject({ url: '/v1/admin/summary', headers: customer })).statusCode).toBe(
      403,
    );
  });
});
