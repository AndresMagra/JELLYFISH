import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { users, variants } from '../src/db/schema';
import { ADDRESS, type World, makeApp, makeWorld } from './helpers';

type Auth = ReturnType<Awaited<ReturnType<typeof makeApp>>['auth']>;

describe('API HTTP', () => {
  let w: World;
  let app: FastifyInstance;
  let sender: Awaited<ReturnType<typeof makeApp>>['sender'];
  let auth: Awaited<ReturnType<typeof makeApp>>['auth'];
  let customer: Auth;
  let admin: Auth;
  let driver: Auth;

  beforeAll(async () => {
    w = await makeWorld();
    ({ app, sender, auth } = await makeApp(w));
    customer = auth(w.customerId, 'customer');
    admin = auth(w.adminId, 'admin');
    driver = auth(w.driverId, 'driver');
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  const json = (res: { body: string }) => JSON.parse(res.body);

  describe('sesión por teléfono', () => {
    it('responde el health check', async () => {
      const res = await app.inject({ url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({ status: 'ok', demo: false });
    });

    it('pide un código, lo verifica y entrega un token usable', async () => {
      const phone = '(829) 555-7001';
      const req = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone },
      });
      expect(req.statusCode).toBe(200);
      expect(json(req).phone).toBe('+18295557001');

      const code = sender.last('+18295557001')!;
      const ver = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { phone, code },
      });
      expect(ver.statusCode).toBe(200);
      const { token, user } = json(ver);
      expect(user).toMatchObject({ phone: '+18295557001', role: 'customer' });

      const me = await app.inject({ url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
      expect(json(me).phone).toBe('+18295557001');
    });

    it('rechaza teléfonos que no son dominicanos', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '212-555-0100' },
      });
      expect(res.statusCode).toBe(400);
      expect(json(res).error.message).toMatch(/dominicano/);
    });

    it('un código solo sirve una vez', async () => {
      const phone = '849-555-7002';
      await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
      const code = sender.last('+18495557002')!;
      const first = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { phone, code },
      });
      expect(first.statusCode).toBe(200);
      const again = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { phone, code },
      });
      expect(again.statusCode).toBe(400);
    });

    it('bloquea tras 5 intentos fallidos, incluso si luego acierta', async () => {
      const phone = '809-555-7003';
      await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } });
      const good = sender.last('+18095557003')!;
      const bad = good === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/v1/auth/otp/verify',
          payload: { phone, code: bad },
        });
        expect(r.statusCode).toBe(400);
      }
      const late = await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { phone, code: good },
      });
      expect(late.statusCode).toBe(429);
    });

    it('limita a 3 códigos por teléfono en 10 minutos', async () => {
      const phone = '809-555-7004';
      const codes = [];
      for (let i = 0; i < 4; i++) {
        codes.push(
          (await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone } }))
            .statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 200, 429]);
    });

    it('exige token y rechaza el vencido/alterado', async () => {
      expect((await app.inject({ url: '/v1/me' })).statusCode).toBe(401);
      expect(
        (await app.inject({ url: '/v1/me', headers: { authorization: 'Bearer abc.def.ghi' } }))
          .statusCode,
      ).toBe(401);
    });

    it('al eliminar la cuenta anonimiza datos y el token deja de servir', async () => {
      const [u] = await w.handle.db
        .insert(users)
        .values({ phone: '+18095557005', name: 'Para borrar', email: 'x@y.do' })
        .returning();
      const h = auth(u!.id, 'customer');
      await app.inject({
        method: 'POST',
        url: '/v1/me/addresses',
        headers: h,
        payload: { ...ADDRESS },
      });
      expect((await app.inject({ method: 'DELETE', url: '/v1/me', headers: h })).statusCode).toBe(
        204,
      );

      const [after] = await w.handle.db.select().from(users).where(eq(users.id, u!.id));
      expect(after).toMatchObject({ name: '', email: null, phone: `deleted:${u!.id}` });
      expect(after!.deletedAt).not.toBeNull();
      expect((await app.inject({ url: '/v1/me', headers: h })).statusCode).toBe(401);
    });
  });

  describe('catálogo', () => {
    it('lista solo lo publicable (excluye precios estimados)', async () => {
      const res = await app.inject({ url: '/v1/products' });
      const body = json(res);
      const groups = body.items.map((p: { group: string }) => p.group);
      expect(groups).toEqual(expect.arrayContaining(['pechuga', 'camaron', 'combo']));
      expect(groups).not.toContain('estimado');
      expect(body.total).toBe(3);
      expect(JSON.stringify(body)).not.toMatch(/"cost"|priceSource|onHand/);
    });

    it('busca sin importar acentos ni mayúsculas', async () => {
      const a = json(await app.inject({ url: '/v1/products?q=CAMARON' }));
      expect(a.items.map((p: { group: string }) => p.group)).toEqual(['camaron']);
      const b = json(await app.inject({ url: '/v1/products?q=pechuga%20pollo' }));
      expect(b.items).toHaveLength(1);
      const none = json(await app.inject({ url: '/v1/products?q=langosta' }));
      expect(none.items).toHaveLength(0);
    });

    it('filtra por categoría y devuelve el detalle con variantes', async () => {
      const list = json(await app.inject({ url: '/v1/products?category=mariscos' }));
      expect(list.items).toHaveLength(1);
      const detail = json(await app.inject({ url: '/v1/products/camaron' }));
      expect(detail.product.variants[0]).toMatchObject({
        sku: 'CAM-1',
        price: 87_995,
        pricingUnit: 'lb',
        minCentilb: 100,
        inStock: true,
      });
    });

    it('un producto no publicable responde 404', async () => {
      expect((await app.inject({ url: '/v1/products/estimado' })).statusCode).toBe(404);
      expect((await app.inject({ url: '/v1/products/no-existe' })).statusCode).toBe(404);
    });

    it('lista categorías', async () => {
      const cats = json(await app.inject({ url: '/v1/categories' }));
      expect(cats.map((c: { slug: string }) => c.slug)).toContain('mariscos');
    });
  });

  describe('entrega y cotización', () => {
    it('dice si cubrimos un sector y cuánto cuesta', async () => {
      const yes = json(
        await app.inject({ url: '/v1/delivery/zone?sector=Piantini&city=Santo%20Domingo' }),
      );
      expect(yes).toMatchObject({ covered: true, feeCentavos: 15_000, minOrderCentavos: 80_000 });
      const no = json(await app.inject({ url: '/v1/delivery/zone?sector=Higüey&city=Higüey' }));
      expect(no).toEqual({ covered: false });
    });

    it('ofrece franjas con cupos', async () => {
      const slots = json(await app.inject({ url: '/v1/delivery/slots' }));
      expect(slots.length).toBeGreaterThan(5);
      expect(slots[0]).toMatchObject({ remaining: 8, available: true });
    });

    it('cotiza en el servidor y reporta cobertura', async () => {
      const v = await w.variant('POL-1');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quote',
        payload: {
          items: [{ variantId: v.id, quantity: 500 }],
          address: { sector: 'Naco', city: 'Santo Domingo' },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({
        subtotal: 87_475,
        deliveryFee: 15_000,
        total: 102_475,
        coverage: 'covered',
      });
    });

    it('rechaza cantidades mal formadas con mensaje en español', async () => {
      const v = await w.variant('POL-1');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quote',
        payload: { items: [{ variantId: v.id, quantity: 125 }] },
      });
      expect(res.statusCode).toBe(400);
      expect(json(res).error.message).toMatch(/múltiplos de 0.5 lb/);
    });
  });

  describe('pedidos del cliente', () => {
    const orderBody = async (extra: Record<string, unknown> = {}) => {
      const v = await w.variant('POL-1');
      return {
        items: [{ variantId: v.id, quantity: 500 }],
        address: ADDRESS,
        slotStart: (await w.firstSlot()).toISOString(),
        paymentMethod: 'card',
        ...extra,
      };
    };

    it('exige sesión', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        payload: await orderBody(),
      });
      expect(res.statusCode).toBe(401);
    });

    it('crea el pedido y el cliente lo ve en su historial', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: await orderBody(),
      });
      expect(res.statusCode).toBe(201);
      const order = json(res);
      expect(order).toMatchObject({ status: 'pending_payment', total: 102_475 });

      const list = json(await app.inject({ url: '/v1/orders', headers: customer }));
      expect(list.map((o: { id: string }) => o.id)).toContain(order.id);
      const one = await app.inject({ url: `/v1/orders/${order.id}`, headers: customer });
      expect(one.statusCode).toBe(200);
    });

    it('con la misma Idempotency-Key devuelve el mismo pedido y reserva una sola vez', async () => {
      const before = await w.variant('POL-1');
      const headers = { ...customer, 'idempotency-key': 'reintento-red-0001' };
      const payload = await orderBody();
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/v1/orders', headers, payload }),
        app.inject({ method: 'POST', url: '/v1/orders', headers, payload }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(json(a).id).toBe(json(b).id);
      const again = await app.inject({ method: 'POST', url: '/v1/orders', headers, payload });
      expect(json(again).id).toBe(json(a).id);
      const after = await w.variant('POL-1');
      expect(after.reserved - before.reserved).toBe(500);
    });

    it('un cliente no ve pedidos de otro', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: await orderBody(),
      });
      const other = auth(w.driverId, 'customer');
      expect(
        (await app.inject({ url: `/v1/orders/${json(res).id}`, headers: other })).statusCode,
      ).toBe(404);
    });

    it('usa una dirección guardada', async () => {
      const addr = json(
        await app.inject({
          method: 'POST',
          url: '/v1/me/addresses',
          headers: customer,
          payload: { ...ADDRESS },
        }),
      );
      expect(addr.isDefault).toBe(true);
      const body = await orderBody({ address: undefined, addressId: addr.id });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: body,
      });
      expect(res.statusCode).toBe(201);
      expect(json(res).address).toMatchObject({ sector: 'Naco', reference: ADDRESS.reference });
    });

    it('el cliente cancela un pedido sin pagar y se libera el stock', async () => {
      const before = await w.variant('POL-1');
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: await orderBody(),
      });
      const id = json(res).id;
      const cancel = await app.inject({
        method: 'POST',
        url: `/v1/orders/${id}/cancel`,
        headers: customer,
        payload: { reason: 'Cambié de opinión' },
      });
      expect(json(cancel)).toMatchObject({
        status: 'cancelled',
        cancelReason: 'Cambié de opinión',
      });
      expect((await w.variant('POL-1')).reserved).toBe(before.reserved);
    });
  });

  describe('permisos por rol', () => {
    it('el cliente no entra al panel admin ni a rutas de repartidor', async () => {
      expect((await app.inject({ url: '/v1/admin/orders', headers: customer })).statusCode).toBe(
        403,
      );
      expect((await app.inject({ url: '/v1/driver/orders', headers: customer })).statusCode).toBe(
        403,
      );
      expect((await app.inject({ url: '/v1/admin/orders' })).statusCode).toBe(401);
    });

    it('el rol se lee de la base de datos, no del token', async () => {
      // token firmado como admin para alguien que en la base es cliente
      const forged = auth(w.customerId, 'admin');
      expect((await app.inject({ url: '/v1/admin/orders', headers: forged })).statusCode).toBe(403);
    });

    it('el personal ve pedidos, pero solo el admin cambia precios', async () => {
      const [staffUser] = await w.handle.db
        .insert(users)
        .values({ phone: '+18095557100', role: 'staff' })
        .returning();
      const staff = auth(staffUser!.id, 'staff');
      expect((await app.inject({ url: '/v1/admin/orders', headers: staff })).statusCode).toBe(200);
      const v = await w.variant('POL-1');
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: staff,
        payload: { price: 19_000 },
      });
      expect(patch.statusCode).toBe(403);
    });

    it('un admin no puede quitarse su propio rol', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/users/${w.adminId}/role`,
        headers: admin,
        payload: { role: 'customer' },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('administración', () => {
    it('importa un CSV: el modo prueba no guarda, y confirma precios estimados', async () => {
      const csv = [
        'sku,grupo,nombre,categoria,unidad,paso_lb,minimo_lb,precio,precio_fuente,itbis,stock',
        'NEW-1,pavo,Pavo entero,aves,lb,1,8,145,usuario,0,50',
        'EST-1,estimado,Corte estimado,res,lb,0.5,1,310,usuario,0,50',
      ].join('\n');

      const dry = json(
        await app.inject({
          method: 'POST',
          url: '/v1/admin/catalog/import?dryRun=1',
          headers: { ...admin, 'content-type': 'text/csv' },
          payload: csv,
        }),
      );
      expect(dry).toMatchObject({ ok: true, dryRun: true, variantsCreated: 1, variantsUpdated: 1 });
      expect((await app.inject({ url: '/v1/products/pavo' })).statusCode).toBe(404);

      const real = json(
        await app.inject({
          method: 'POST',
          url: '/v1/admin/catalog/import?dryRun=0',
          headers: { ...admin, 'content-type': 'text/csv' },
          payload: csv,
        }),
      );
      expect(real.dryRun).toBe(false);
      expect((await app.inject({ url: '/v1/products/pavo' })).statusCode).toBe(200);
      // el estimado pasó a "usuario" con ITBIS confirmado → ya es publicable
      expect((await app.inject({ url: '/v1/products/estimado' })).statusCode).toBe(200);
    });

    it('un CSV con errores no escribe nada y explica cada fila', async () => {
      const bad = 'sku,nombre,categoria,unidad,precio\nX-1,Algo,frutas,lb,10\n';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog/import?dryRun=0',
        headers: admin,
        payload: { csv: bad },
      });
      const body = json(res);
      expect(body.ok).toBe(false);
      expect(body.errors[0]).toMatchObject({ line: 2, sku: 'X-1', field: 'categoria' });
    });

    it('reimportar la semilla no pisa un precio ya confirmado por el dueño', async () => {
      const v = await w.variant('POL-1');
      const seedLike =
        'sku,grupo,nombre,categoria,unidad,precio,precio_fuente\nPOL-1,pechuga,Pechuga de pollo,aves,lb,100,estimado\n';
      const res = json(
        await app.inject({
          method: 'POST',
          url: '/v1/admin/catalog/import?dryRun=0',
          headers: admin,
          payload: { csv: seedLike },
        }),
      );
      expect(res.keptConfirmedPrices).toEqual(['POL-1']);
      expect((await w.variant('POL-1')).price).toBe(v.price);
    });

    it('al cambiar un precio sin indicar fuente queda como confirmado', async () => {
      const v = await w.variant('POL-1');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: admin,
        payload: { price: 18_000 },
      });
      expect(json(res)).toMatchObject({ price: 18_000, priceSource: 'usuario' });
      const bad = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: admin,
        payload: { price: -5 },
      });
      expect(bad.statusCode).toBe(400);
    });

    it('lista lo bloqueado para publicar y por qué', async () => {
      await w.handle.db.update(variants).set({ itbisBps: null }).where(eq(variants.sku, 'CAM-1'));
      const blocked = json(
        await app.inject({ url: '/v1/admin/catalog?blockedOnly=1', headers: admin }),
      );
      const cam = blocked.find((r: { sku: string }) => r.sku === 'CAM-1');
      expect(cam.blockers).toEqual(['ITBIS por confirmar con el contador']);
      await w.handle.db.update(variants).set({ itbisBps: 0 }).where(eq(variants.sku, 'CAM-1'));
    });

    it('recibir mercancía suma al stock', async () => {
      const v = await w.variant('CMB-1');
      const recv = await app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/adjust',
        headers: admin,
        payload: { variantId: v.id, type: 'receive', delta: 10, note: 'Llegó mercancía' },
      });
      expect(json(recv).onHand).toBe(v.onHand + 10);
    });

    it('no deja bajar el inventario por debajo de lo reservado en pedidos activos', async () => {
      const v = await w.variant('CMB-1');
      const order = await app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: customer,
        payload: {
          items: [{ variantId: v.id, quantity: 2 }],
          address: ADDRESS,
          slotStart: (await w.firstSlot()).toISOString(),
          paymentMethod: 'cash',
        },
      });
      expect(order.statusCode).toBe(201);
      const now = await w.variant('CMB-1');
      expect(now.reserved).toBeGreaterThanOrEqual(2);

      // Dejar 1 unidad cuando hay 2+ prometidas debe fallar...
      const tooLow = await app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/adjust',
        headers: admin,
        payload: { variantId: v.id, type: 'waste', delta: -(now.onHand - 1) },
      });
      expect(tooLow.statusCode).toBe(409);
      expect(json(tooLow).error.code).toBe('stock_below_reserved');
      // ...pero bajar justo hasta lo reservado es válido.
      const ok = await app.inject({
        method: 'POST',
        url: '/v1/admin/inventory/adjust',
        headers: admin,
        payload: {
          variantId: v.id,
          type: 'waste',
          delta: -(now.onHand - now.reserved),
          note: 'Merma',
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(json(ok).onHand).toBe(now.reserved);
    });

    it('crea y lista zonas de entrega', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        headers: admin,
        payload: {
          name: 'Santiago Centro',
          areas: ['Santiago', 'Los Jardines'],
          feeCentavos: 20_000,
        },
      });
      expect(res.statusCode).toBe(201);
      const covered = json(
        await app.inject({ url: '/v1/delivery/zone?sector=Los%20Jardines&city=Santiago' }),
      );
      expect(covered).toMatchObject({ covered: true, feeCentavos: 20_000 });
    });
  });

  describe('repartidor', () => {
    it('solo ve y mueve sus pedidos asignados', async () => {
      const v = await w.variant('POL-1');
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/v1/orders',
          headers: customer,
          payload: {
            items: [{ variantId: v.id, quantity: 500 }],
            address: ADDRESS,
            slotStart: (await w.firstSlot()).toISOString(),
            paymentMethod: 'cash',
          },
        }),
      );
      const step = (to: string) =>
        app.inject({
          method: 'POST',
          url: `/v1/admin/orders/${created.id}/transition`,
          headers: admin,
          payload: { to },
        });
      expect((await step('picking')).statusCode).toBe(200);
      const item = created.items[0];
      const weigh = await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/weights`,
        headers: admin,
        payload: { weights: [{ itemId: item.id, finalQuantity: 512 }] },
      });
      expect(weigh.statusCode).toBe(200);
      expect((await step('packed')).statusCode).toBe(200);

      // sin asignar, el repartidor no lo ve ni lo puede mover
      expect(json(await app.inject({ url: '/v1/driver/orders', headers: driver }))).toEqual([]);
      const denied = await app.inject({
        method: 'POST',
        url: `/v1/driver/orders/${created.id}/transition`,
        headers: driver,
        payload: { to: 'out_for_delivery' },
      });
      expect(denied.statusCode).toBe(403);

      const assign = await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/assign-driver`,
        headers: admin,
        payload: { driverId: w.driverId },
      });
      expect(assign.statusCode).toBe(200);

      const mine = json(await app.inject({ url: '/v1/driver/orders', headers: driver }));
      expect(mine).toHaveLength(1);
      expect(mine[0].items[0].finalQuantity).toBe(512);

      const go = await app.inject({
        method: 'POST',
        url: `/v1/driver/orders/${created.id}/transition`,
        headers: driver,
        payload: { to: 'out_for_delivery' },
      });
      expect(json(go).status).toBe('out_for_delivery');
      // En efectivo no se puede marcar entregado sin haber cobrado el monto exacto.
      const deliver = () =>
        app.inject({
          method: 'POST',
          url: `/v1/driver/orders/${created.id}/transition`,
          headers: driver,
          payload: { to: 'delivered' },
        });
      const early = await deliver();
      expect(early.statusCode).toBe(409);
      expect(json(early).error.code).toBe('cash_not_collected');

      const due = json(await app.inject({ url: '/v1/driver/orders', headers: driver }))[0]
        .finalTotal;
      const collect = (amount: number) =>
        app.inject({
          method: 'POST',
          url: `/v1/driver/orders/${created.id}/collect`,
          headers: driver,
          payload: { amount },
        });
      expect((await collect(due - 100)).statusCode).toBe(409);
      expect((await collect(due)).statusCode).toBe(200);

      const done = await deliver();
      expect(json(done).status).toBe('delivered');
      // entregado: ya no aparece entre las entregas activas
      expect(json(await app.inject({ url: '/v1/driver/orders', headers: driver }))).toEqual([]);
    });

    it('un repartidor no puede cancelar ni confirmar pedidos', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/driver/orders/00000000-0000-4000-8000-000000000000/transition`,
        headers: driver,
        payload: { to: 'cancelled' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});

describe('CORS (panel admin web)', () => {
  it('permite PATCH/PUT/DELETE y las cabeceras que usan las apps', async () => {
    const w = await makeWorld();
    const { app } = await makeApp(w);
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/v1/me',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization,content-type,idempotency-key',
      },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-methods']).toMatch(/PATCH/);
    expect(pre.headers['access-control-allow-methods']).toMatch(/DELETE/);
    expect(pre.headers['access-control-allow-headers']).toMatch(/Idempotency-Key/i);
    await app.close();
    await w.close();
  });

  it('con orígenes configurados, un sitio ajeno no recibe permiso', async () => {
    const w = await makeWorld({ corsOrigins: ['https://admin.jellyfish.do'] });
    const { app } = await makeApp(w);
    const ask = (origin: string) =>
      app.inject({ method: 'GET', url: '/health', headers: { origin } });
    expect((await ask('https://admin.jellyfish.do')).headers['access-control-allow-origin']).toBe(
      'https://admin.jellyfish.do',
    );
    expect(
      (await ask('https://sitio-malicioso.example')).headers['access-control-allow-origin'],
    ).toBeUndefined();
    await app.close();
    await w.close();
  });
});
