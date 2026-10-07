import { parseCatalogCsv } from '@jellyfish/catalog';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { ADDRESS, type World, categoriesJson, makeApp, makeWorld } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);

describe('panel de administración: resumen, exportación y equipo', () => {
  let w: World;
  let app: FastifyInstance;
  let admin: Record<string, string>;
  let customer: Record<string, string>;
  let auth: Awaited<ReturnType<typeof makeApp>>['auth'];

  beforeAll(async () => {
    w = await makeWorld({
      windows: {
        startHour: 10,
        endHour: 20,
        windowHours: 2,
        capacityPerWindow: 100,
        leadMinutes: 90,
        daysAhead: 3,
      },
    });
    ({ app, auth } = await makeApp(w));
    admin = auth(w.adminId, 'admin');
    customer = auth(w.customerId, 'customer');
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  const order = async (method: 'cash' | 'card', sku = 'POL-1', quantity = 500) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: customer,
      payload: {
        items: [{ variantId: (await w.variant(sku)).id, quantity }],
        address: ADDRESS,
        slotStart: (await w.firstSlot()).toISOString(),
        paymentMethod: method,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return json(res);
  };

  it('el pedido incluye los datos de contacto del cliente', async () => {
    const o = await order('cash');
    expect(o.customer).toMatchObject({ id: w.customerId, name: 'Cliente', phone: '+18095550001' });
  });

  it('el resumen cuenta pedidos activos, ventas del día y pendientes de dinero', async () => {
    const before = json(await app.inject({ url: '/v1/admin/summary', headers: admin }));
    await order('cash'); // confirmado, cuenta como venta de hoy
    await order('card'); // esperando pago: NO es venta todavía
    const after = json(await app.inject({ url: '/v1/admin/summary', headers: admin }));

    expect(after.active.confirmed - before.active.confirmed).toBe(1);
    expect(after.active.pending_payment - before.active.pending_payment).toBe(1);
    expect(after.today.orders - before.today.orders).toBe(1);
    expect(after.today.sales - before.today.sales).toBe(102_475); // 5 lb × 174.95 + envío
    expect(after.catalog.variants).toBe(4);
    expect(after.catalog.blocked).toBe(1); // el artículo "estimado" del catálogo de prueba
  });

  it('el resumen refleja devoluciones pendientes y transferencias por verificar', async () => {
    const cancelled = await order('card');
    const co = json(
      await app.inject({
        method: 'POST',
        url: `/v1/orders/${cancelled.id}/pay`,
        headers: customer,
      }),
    );
    // aprobada por el simulador y luego cancelada → queda dinero por devolver
    const gw = app.paymentCtx.gateway as import('@jellyfish/payments').MockGateway;
    const num = (await w.handle.db.query.payments.findFirst({
      where: (p, { eq }) => eq(p.id, co.paymentId),
    }))!.idempotencyKey;
    const cb = gw.buildCallback('approved', { orderNumber: num, amount: String(cancelled.total) });
    await app.inject({ url: `/v1/payments/mock/approved?${new URLSearchParams(cb)}` });
    await app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${cancelled.id}/transition`,
      headers: admin,
      payload: { to: 'cancelled', note: 'prueba' },
    });
    const s = json(await app.inject({ url: '/v1/admin/summary', headers: admin }));
    expect(s.refunds.count).toBeGreaterThanOrEqual(1);
    expect(s.refunds.amount).toBeGreaterThanOrEqual(cancelled.total);
  });

  it('solo personal autorizado ve el resumen', async () => {
    expect((await app.inject({ url: '/v1/admin/summary', headers: customer })).statusCode).toBe(
      403,
    );
    expect((await app.inject({ url: '/v1/admin/summary' })).statusCode).toBe(401);
  });

  it('exportar el catálogo y volver a importarlo no pierde ni cambia nada', async () => {
    const res = await app.inject({ url: '/v1/admin/catalog/export', headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/jellyfish-catalogo-\d{4}-\d{2}-\d{2}\.csv/);

    const parsed = parseCatalogCsv(res.body, { categories: categoriesJson.map((c) => c.slug) });
    expect(parsed.errors).toEqual([]);
    expect(parsed.items.map((i) => i.sku).sort()).toEqual(['CAM-1', 'CMB-1', 'EST-1', 'POL-1']);
    const pol = parsed.items.find((i) => i.sku === 'POL-1')!;
    expect(pol).toMatchObject({
      price: 17_495,
      priceSource: 'usuario',
      itbisBps: 0,
      stepCentilb: 50,
    });

    // reimportar el export en modo prueba: nada nuevo, todo "actualizado", sin errores
    const again = json(
      await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog/import?dryRun=1',
        headers: { ...admin, 'content-type': 'text/csv' },
        payload: res.body,
      }),
    );
    expect(again).toMatchObject({
      ok: true,
      variantsCreated: 0,
      variantsUpdated: 4,
      productsCreated: 0,
    });
  });

  it('los sinónimos y descripciones sobreviven a exportar → importar', async () => {
    const csv = [
      'sku,grupo,nombre,categoria,unidad,precio,precio_fuente,itbis,sinonimos,descripcion,como_cocinar',
      'SYN-1,pierna,Pierna de cerdo,cerdo,lb,215,usuario,0,pernil;pierna asada,Para el horno,Hornear 3 h',
    ].join('\n');
    await app.inject({
      method: 'POST',
      url: '/v1/admin/catalog/import?dryRun=0',
      headers: { ...admin, 'content-type': 'text/csv' },
      payload: csv,
    });
    const exported = (await app.inject({ url: '/v1/admin/catalog/export', headers: admin })).body;
    const row = parseCatalogCsv(exported, {
      categories: categoriesJson.map((c) => c.slug),
    }).items.find((i) => i.sku === 'SYN-1')!;
    expect(row.synonyms).toEqual(['pernil', 'pierna asada']);
    expect(row.description).toBe('Para el horno');
    expect(row.cookingTip).toBe('Hornear 3 h');
    // y la búsqueda por sinónimo sigue funcionando
    const found = json(await app.inject({ url: '/v1/products?q=pernil' }));
    expect(found.items.map((p: { group: string }) => p.group)).toContain('pierna');
  });

  it('el administrador da de alta a un repartidor por su celular', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: admin,
      payload: { phone: '(849) 555-0177', name: 'Juan Motorista', role: 'driver' },
    });
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({
      phone: '+18495550177',
      name: 'Juan Motorista',
      role: 'driver',
    });
    const [row] = await w.handle.db.select().from(users).where(eq(users.phone, '+18495550177'));
    expect(row?.role).toBe('driver');

    // si ya existía, solo cambia el rol
    const promote = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: admin,
      payload: { phone: '849-555-0177', role: 'staff' },
    });
    expect(json(promote)).toMatchObject({ id: row!.id, role: 'staff', name: 'Juan Motorista' });
  });

  it('rechaza teléfonos inválidos y a quien no es admin', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: admin,
      payload: { phone: '555-1234', role: 'driver' },
    });
    expect(bad.statusCode).toBe(400);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/admin/users',
      headers: customer,
      payload: { phone: '809-555-0188', role: 'driver' },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('zonas y cobro de efectivo desde el panel', () => {
  it('el administrador edita tarifa, mínimo y cobertura de una zona', async () => {
    const w = await makeWorld();
    const { app, auth } = await makeApp(w);
    const admin = auth(w.adminId, 'admin');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/zones/${w.zoneId}`,
      headers: admin,
      payload: {
        feeCentavos: 20_000,
        minOrderCentavos: 100_000,
        freeOverCentavos: null,
        areas: ['Naco', 'Bella Vista'],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({
      feeCentavos: 20_000,
      minOrderCentavos: 100_000,
      freeOverCentavos: null,
    });
    const check = json(await app.inject({ url: '/v1/delivery/zone?sector=Bella%20Vista&city=' }));
    expect(check).toMatchObject({ covered: true, feeCentavos: 20_000 });
    const gone = json(await app.inject({ url: '/v1/delivery/zone?sector=Piantini&city=' }));
    expect(gone.covered).toBe(false); // Piantini ya no está en la lista

    const off = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/zones/${w.zoneId}`,
      headers: admin,
      payload: { active: false },
    });
    expect(json(off).active).toBe(false);
    expect(json(await app.inject({ url: '/v1/delivery/zone?sector=Naco&city=' })).covered).toBe(
      false,
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/admin/zones/00000000-0000-4000-8000-000000000000`,
          headers: admin,
          payload: { active: true },
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    await w.close();
  });

  it('el personal registra el efectivo cobrado y el pedido ya se puede entregar', async () => {
    const w = await makeWorld();
    const { app, auth } = await makeApp(w);
    const admin = auth(w.adminId, 'admin');
    const customer = auth(w.customerId, 'customer');
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: {
          items: [{ variantId: (await w.variant('POL-1')).id, quantity: 500 }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      }),
    );
    const step = (to: string, extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to, ...extra },
      });
    await step('picking');
    await app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${created.id}/weights`,
      headers: admin,
      payload: { weights: [{ itemId: created.items[0].id, finalQuantity: 500 }] },
    });
    await step('packed');
    await app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${created.id}/assign-driver`,
      headers: admin,
      payload: { driverId: w.driverId },
    });
    await step('out_for_delivery');
    expect((await step('delivered')).statusCode).toBe(409); // sin cobro registrado

    const collect = await app.inject({
      method: 'POST',
      url: `/v1/admin/orders/${created.id}/collect-cash`,
      headers: admin,
      payload: { amount: created.total },
    });
    expect(collect.statusCode, collect.body).toBe(200);
    expect(json(collect).payments[0]).toMatchObject({
      status: 'captured',
      capturedAmount: created.total,
    });
    // El dinero queda a cargo del REPARTIDOR asignado (no de quien lo registró): ese es su saldo en caja.
    const cash = json(await app.inject({ url: '/v1/admin/cash', headers: admin }));
    expect(cash.find((r: { driverId: string }) => r.driverId === w.driverId)).toMatchObject({
      collected: created.total,
      balance: created.total,
      deliveries: 1,
    });
    // Los pedidos nuevos llevan PIN: el personal entrega sin él solo con un motivo escrito.
    expect(
      (await step('delivered', { pinOverrideReason: 'Cliente sin teléfono a mano' })).statusCode,
    ).toBe(200);
    await app.close();
    await w.close();
  });
});

describe('lista de repartidores para asignar', () => {
  it('el personal la ve; un cliente no; y no expone a otros usuarios', async () => {
    const w = await makeWorld();
    const { app, auth } = await makeApp(w);
    const [staffUser] = await w.handle.db
      .insert(users)
      .values({ phone: '+18095550999', role: 'staff' })
      .returning();
    const res = await app.inject({
      url: '/v1/admin/drivers',
      headers: auth(staffUser!.id, 'staff'),
    });
    expect(res.statusCode).toBe(200);
    const list = json(res);
    expect(list.map((d: { id: string }) => d.id)).toEqual([w.driverId]);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'name', 'phone']);
    expect(
      (await app.inject({ url: '/v1/admin/drivers', headers: auth(w.customerId, 'customer') }))
        .statusCode,
    ).toBe(403);
    await app.close();
    await w.close();
  });
});
