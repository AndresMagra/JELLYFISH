import { Writable } from 'node:stream';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { auditLog, users } from '../src/db/schema';
import { MemoryOtpSender } from '../src/services/auth';
import {
  MAX_PAYLOAD_BYTES,
  buildSummary,
  describeRoute,
  isSecretKey,
  normalizePath,
  sanitizePayload,
} from '../src/services/audit';
import { ADDRESS, NOW, type World, makeWorld } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const UUID = '3f2b8c1e-9d4a-4e6b-8a7c-1d2e3f4a5b6c';

describe('bitácora: saneamiento del cuerpo', () => {
  it('quita las claves secretas, sin importar mayúsculas, anidamiento ni arreglos', () => {
    const out = sanitizePayload({
      note: 'ok',
      code: '123456',
      OTP: '654321',
      Pin: '1234',
      token: 'abc',
      password: 'p',
      secret: 's',
      Authorization: 'Bearer x',
      nested: { deep: { PIN: '9999', keep: 1 } },
      list: [{ token: 't1', name: 'a' }, 'texto'],
      pushToken: 'ExponentPushToken[xyz]',
      deliveryPin: '0420',
      client_secret: 'zzz',
      otpCode: '111111',
    });
    expect(out).toEqual({
      note: 'ok',
      nested: { deep: { keep: 1 } },
      list: [{ name: 'a' }, 'texto'],
    });
    const text = JSON.stringify(out);
    for (const leaked of ['123456', '654321', '1234', '9999', 'xyz', '0420', '111111']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('conserva datos útiles que solo se parecen a un secreto', () => {
    const out = sanitizePayload({
      lotCode: 'POL-2610',
      couponCode: 'VERANO10',
      pinOverrideReason: 'El cliente no tiene teléfono',
      shipping: 'x',
    });
    expect(out).toEqual({
      lotCode: 'POL-2610',
      couponCode: 'VERANO10',
      pinOverrideReason: 'El cliente no tiene teléfono',
      shipping: 'x',
    });
    expect(isSecretKey('code')).toBe(true);
    expect(isSecretKey('lotCode')).toBe(false);
  });

  it('keepKeys conserva solo las claves pedidas; el resto de secretos y la consulta siguen limpios', () => {
    const body = {
      code: 'VERANO10',
      otp: '654321',
      pin: '1234',
      nested: { code: 'X', token: 't' },
    };
    expect(sanitizePayload(body, { code: '999' })).toEqual({ nested: {} });
    expect(sanitizePayload(body, { code: '999' }, undefined, ['code'])).toEqual({
      code: 'VERANO10',
      nested: { code: 'X' },
    });
    // la lista de claves no abre otras claves ni se confunde con mayúsculas o guiones
    expect(
      sanitizePayload({ Code: 'a', otp: 'b', otpCode: 'c' }, undefined, undefined, ['CODE']),
    ).toEqual({ Code: 'a' });
    expect(sanitizePayload({ code: '1' }, undefined, undefined, [])).toEqual({});
    // la consulta nunca conserva claves secretas, ni siquiera con keepKeys
    expect(sanitizePayload(null, { code: '999', page: '2' }, undefined, ['code'])).toEqual({
      _query: { page: '2' },
    });
  });

  it('recorta textos largos a 200 caracteres y marca el corte', () => {
    const out = sanitizePayload({ note: 'a'.repeat(500), short: 'b'.repeat(200) })!;
    expect(out.note).toBe(`${'a'.repeat(200)}…`);
    expect(out.short).toBe('b'.repeat(200));
  });

  it('enmascara teléfonos y reemplaza tokens que aparecen como valor', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma';
    const out = sanitizePayload({
      phone: '+18095551234',
      contactPhone: '+18295559876',
      note: jwt,
      header: 'Bearer abcdef',
    })!;
    expect(out.phone).toBe('+1809*****34');
    expect(out.contactPhone).toBe('+1829*****76');
    expect(out.note).toBe('[token]');
    expect(out.header).toBe('[token]');
    expect(JSON.stringify(out)).not.toContain('5551234');
  });

  it('acota profundidad, arreglos y número de claves; ignora claves peligrosas', () => {
    const deep = { a: { b: { c: { d: { e: 'fondo' } } } } };
    expect(sanitizePayload(deep)).toEqual({ a: { b: { c: { d: '[…]' } } } });

    const big = sanitizePayload({ items: Array.from({ length: 50 }, (_, i) => i) })!;
    const items = big.items as unknown[];
    expect(items).toHaveLength(21);
    expect(items[20]).toBe('…(30 más)');

    const many = sanitizePayload(
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i])),
    )!;
    expect(Object.keys(many).length).toBeLessThanOrEqual(31);
    expect(many._more).toBe('…');

    const evil = sanitizePayload(JSON.parse('{"__proto__":{"admin":true},"ok":1}'))!;
    expect(evil).toEqual({ ok: 1 });
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it('limita el tamaño total: lo enorme se reemplaza por un resumen', () => {
    const body = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`campo${i}`, 'x'.repeat(190)]),
    );
    const out = sanitizePayload(body)!;
    expect(out._truncated).toBe(true);
    expect(out._bytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it('un cuerpo de texto (CSV) no se guarda, solo su tamaño; el query sí, saneado', () => {
    const csv = 'sku,precio\nPOL-1,174.95\n';
    expect(sanitizePayload(csv, { dryRun: '0', token: 'x' }, 'text/csv')).toEqual({
      _text: true,
      _chars: csv.length,
      _contentType: 'text/csv',
      _query: { dryRun: '0' },
    });
    expect(sanitizePayload(undefined, {})).toBeNull();
    expect(sanitizePayload(undefined, undefined)).toBeNull();
    expect(sanitizePayload([1, 2])).toEqual({ _items: [1, 2] });
  });
});

describe('bitácora: rutas y acciones', () => {
  it('reemplaza los ids por :id en una URL cruda', () => {
    expect(normalizePath(`/v1/admin/orders/${UUID}/transition?x=1`)).toBe(
      '/v1/admin/orders/:id/transition',
    );
    expect(normalizePath('/v1/admin/payments/12345/mark-paid')).toBe(
      '/v1/admin/payments/:id/mark-paid',
    );
    expect(normalizePath('/v1/admin/zones')).toBe('/v1/admin/zones');
  });

  it('nombra las acciones conocidas y arma nombres para rutas nuevas', () => {
    expect(describeRoute('PATCH', '/v1/admin/variants/:id')).toMatchObject({
      action: 'catalog.patch_variant',
      entity: 'variant',
    });
    expect(describeRoute('POST', '/v1/admin/orders/:id/transition').action).toBe(
      'orders.transition',
    );
    expect(describeRoute('POST', '/v1/admin/coupons')).toMatchObject({
      action: 'coupons.create',
      entity: 'coupon',
      label: 'Cupón creado',
    });
    expect(describeRoute('PATCH', '/v1/admin/coupons/:id')).toMatchObject({
      action: 'coupons.update',
      entity: 'coupon',
      label: 'Cupón modificado',
    });
    // rutas que aún no están en la tabla
    expect(describeRoute('DELETE', '/v1/admin/coupons/:id').action).toBe('coupons.delete');
    expect(describeRoute('POST', '/v1/admin/coupons/:id/pause').action).toBe('coupons.pause');
    expect(describeRoute('POST', '/v1/driver/foo-bar/:id/do-it').action).toBe(
      'driver.foo_bar.do_it',
    );
  });

  it('el resumen es legible y marca los rechazos', () => {
    const desc = describeRoute('POST', '/v1/admin/orders/:id/transition');
    expect(buildSummary(desc, { body: { to: 'packed' }, query: {} }, 200)).toBe(
      'Cambio de estado del pedido: a «packed»',
    );
    expect(buildSummary(desc, { body: { to: 'packed' }, query: {} }, 409, 'weights_missing')).toBe(
      'Cambio de estado del pedido: a «packed» — rechazado (weights_missing)',
    );
    expect(buildSummary(desc, { body: {}, query: {} }, 403)).toContain('rechazado (403)');
  });

  it('el resumen de un cupón dice cuál: crear, pausar, reactivar, editar y rechazos', () => {
    const create = describeRoute('POST', '/v1/admin/coupons');
    const patch = describeRoute('PATCH', '/v1/admin/coupons/:id');
    const sum = (
      d: typeof create,
      body: Record<string, unknown>,
      result?: Record<string, unknown>,
      status = 200,
      error?: string,
    ) => buildSummary(d, { body, query: {}, result }, status, error);

    // al crear manda el código normalizado de la respuesta, no lo que se tecleó
    expect(sum(create, { code: 'verano10 ' }, { code: 'VERANO10' }, 201)).toBe(
      'Cupón creado: VERANO10',
    );
    expect(sum(patch, { active: false }, { code: 'VERANO10' })).toBe(
      'Cupón modificado: VERANO10 (pausado)',
    );
    expect(sum(patch, { active: true }, { code: 'VERANO10' })).toBe(
      'Cupón modificado: VERANO10 (reactivado)',
    );
    expect(sum(patch, { value: 1500, endsAt: null, active: false }, { code: 'VERANO10' })).toBe(
      'Cupón modificado: VERANO10 (pausado; campos: value, endsAt)',
    );
    expect(sum(patch, { value: 1500 }, { code: 'VERANO10' })).toBe(
      'Cupón modificado: VERANO10 (campos: value)',
    );
    // un rechazo no trae respuesta: crear usa lo tecleado; editar solo puede decir qué se intentó
    expect(sum(create, { code: 'verano10' }, undefined, 403, 'forbidden')).toBe(
      'Cupón creado: verano10 — rechazado (forbidden)',
    );
    expect(sum(patch, { active: false }, undefined, 404, 'not_found')).toBe(
      'Cupón modificado: pausado — rechazado (not_found)',
    );
    expect(sum(patch, {}, undefined, 400, 'validation')).toBe(
      'Cupón modificado — rechazado (validation)',
    );
  });

  it('ninguna ruta de escritura del panel ni del repartidor cae en el resumen genérico', () => {
    const writes: [string, string][] = [
      ['POST', '/v1/admin/orders/:id/transition'],
      ['POST', '/v1/admin/orders/:id/weights'],
      ['POST', '/v1/admin/orders/:id/assign-driver'],
      ['POST', '/v1/admin/orders/:id/collect-cash'],
      ['PATCH', '/v1/admin/variants/:id'],
      ['POST', '/v1/admin/catalog/import'],
      ['POST', '/v1/admin/inventory/adjust'],
      ['POST', '/v1/admin/inventory/lots'],
      ['POST', '/v1/admin/zones'],
      ['PATCH', '/v1/admin/zones/:id'],
      ['POST', '/v1/admin/users'],
      ['POST', '/v1/admin/users/:id/role'],
      ['POST', '/v1/admin/coupons'],
      ['PATCH', '/v1/admin/coupons/:id'],
      ['POST', '/v1/admin/payments/:id/mark-paid'],
      ['POST', '/v1/admin/payments/:id/mark-refunded'],
      ['POST', '/v1/admin/cash/settle'],
      ['POST', '/v1/driver/orders/:id/transition'],
      ['POST', '/v1/driver/orders/:id/collect'],
    ];
    for (const [method, pattern] of writes) {
      const { label } = describeRoute(method, pattern);
      expect(label, `${method} ${pattern}`).not.toBe(`${method} ${pattern}`);
    }
  });
});

describe('bitácora de auditoría', () => {
  let w: World;
  let app: FastifyInstance;
  let sender: MemoryOtpSender;
  // Cada lectura del reloj avanza 1 ms: las filas quedan en orden estricto. `frozen` detiene el
  // reloj para probar el desempate cuando varias filas comparten la misma hora.
  let clock = NOW;
  let frozen: Date | null = null;
  const nextTime = () => frozen ?? (clock = new Date(clock.getTime() + 1));
  let admin: Record<string, string>;
  let staff: Record<string, string>;
  let customer: Record<string, string>;
  let driver: Record<string, string>;
  let staffId: string;
  const logLines: string[] = [];

  const sign = (id: string, role: 'customer' | 'admin' | 'staff' | 'driver') => ({
    authorization: `Bearer ${app.jwt.sign({ sub: id, role })}`,
  });
  /** Cede un turno para que corra onResponse y espera las escrituras de auditoría. */
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await app.audit.idle();
  };
  const rows = () => w.handle.db.select().from(auditLog).orderBy(asc(auditLog.createdAt));
  const rowCount = async () => (await rows()).length;

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
    sender = new MemoryOtpSender();
    app = await buildApp({
      db: w.handle.db,
      config: w.config,
      otpSender: sender,
      now: nextTime,
      logger: {
        stream: new Writable({
          write(chunk, _enc, done) {
            logLines.push(String(chunk));
            done();
          },
        }),
      },
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
    await w.close();
  });

  const createZone = async (name: string, headers = admin) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/zones',
      headers,
      payload: { name, areas: ['Naco'], feeCentavos: 10_000 },
    });
    await settle();
    return res;
  };

  describe('qué se registra', () => {
    it('una acción del panel deja actor, ruta normalizada, acción, entidad, estado, resumen e IP', async () => {
      const created = await createZone('Zona Auditada');
      expect(created.statusCode, created.body).toBe(201);
      const zoneId = json(created).id as string;

      const [row] = (await rows()).filter((r) => r.entityId === zoneId);
      expect(row).toMatchObject({
        actorId: w.adminId,
        actorRole: 'admin',
        method: 'POST',
        path: '/v1/admin/zones',
        action: 'zones.create',
        entity: 'zone',
        entityId: zoneId, // el id sale de la respuesta: la ruta no lo trae
        status: 201,
        summary: 'Zona de entrega creada: Zona Auditada',
        ip: '127.0.0.1',
      });
      expect(row!.payload).toEqual({ name: 'Zona Auditada', areas: ['Naco'], feeCentavos: 10_000 });
      expect(row!.createdAt.getTime()).toBeGreaterThan(NOW.getTime());

      // modificar usa el id de la ruta, y la ruta guardada no lleva ids
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/zones/${zoneId}`,
        headers: staff, // el personal no puede: queda registrado el intento
        payload: { feeCentavos: 5000 },
      });
      await settle();
      expect(patched.statusCode).toBe(403);
      const denied = (await rows()).find(
        (r) => r.action === 'zones.update' && r.entityId === zoneId,
      );
      expect(denied).toMatchObject({
        actorId: staffId,
        actorRole: 'staff',
        path: '/v1/admin/zones/:id',
        status: 403,
      });
      expect(denied!.summary).toContain('rechazado (forbidden)');
      expect(denied!.path).not.toContain(zoneId);
    });

    it('una transición de pedido registra el estado destino y el pedido', async () => {
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
      const before = await rowCount();
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to: 'picking', note: 'Empezamos' },
      });
      await settle();
      expect(res.statusCode).toBe(200);
      const all = await rows();
      expect(all).toHaveLength(before + 1); // crear el pedido (cliente) no se audita
      expect(all.at(-1)).toMatchObject({
        action: 'orders.transition',
        entity: 'order',
        entityId: created.id,
        status: 200,
        summary: 'Cambio de estado del pedido: a «picking»',
        payload: { to: 'picking', note: 'Empezamos' },
      });
    });

    it('registra también el motivo cuando la operación se rechaza', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to: 'picking' },
      });
      // empacar sin pesar: la regla de negocio lo rechaza
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to: 'packed' },
      });
      await settle();
      expect(res.statusCode).toBe(409);
      const last = (await rows()).at(-1)!;
      expect(last).toMatchObject({ action: 'orders.transition', status: 409 });
      expect(last.summary).toBe(
        'Cambio de estado del pedido: a «packed» — rechazado (weights_missing)',
      );
    });

    it('un cupón creado, pausado y editado deja su código en el resumen y en el payload', async () => {
      const post = (headers = admin) =>
        app.inject({
          method: 'POST',
          url: '/v1/admin/coupons',
          headers,
          payload: { code: ' verano10 ', description: 'Verano', kind: 'percent', value: 1000 },
        });
      const created = await post();
      await settle();
      expect(created.statusCode, created.body).toBe(201);
      const coupon = json(created) as { id: string; code: string };
      expect(coupon.code).toBe('VERANO10'); // la respuesta lo trae normalizado
      const createRow = (await rows()).at(-1)!;
      expect(createRow).toMatchObject({
        action: 'coupons.create',
        entity: 'coupon',
        entityId: coupon.id,
        status: 201,
        summary: 'Cupón creado: VERANO10',
      });
      // el código es público (los clientes lo escriben): se conserva; el resto se sanea igual
      expect(createRow.payload).toEqual({
        code: ' verano10 ',
        description: 'Verano',
        kind: 'percent',
        value: 1000,
      });

      const patch = async (payload: object, id = coupon.id) => {
        const res = await app.inject({
          method: 'PATCH',
          url: `/v1/admin/coupons/${id}`,
          headers: admin,
          payload,
        });
        await settle();
        return { res, row: (await rows()).at(-1)! };
      };
      const paused = await patch({ active: false });
      expect(paused.res.statusCode, paused.res.body).toBe(200);
      expect(paused.row).toMatchObject({
        action: 'coupons.update',
        entity: 'coupon',
        entityId: coupon.id,
        path: '/v1/admin/coupons/:id',
        summary: 'Cupón modificado: VERANO10 (pausado)',
        payload: { active: false },
      });
      expect((await patch({ active: true })).row.summary).toBe(
        'Cupón modificado: VERANO10 (reactivado)',
      );
      expect((await patch({ maxRedemptions: 50 })).row.summary).toBe(
        'Cupón modificado: VERANO10 (campos: maxRedemptions)',
      );

      // si la edición se rechaza no hay código en la respuesta: queda el id de la fila
      const missing = await patch({ active: false }, UUID);
      expect(missing.res.statusCode).toBe(404);
      expect(missing.row).toMatchObject({
        entityId: UUID,
        status: 404,
        summary: 'Cupón modificado: pausado — rechazado (not_found)',
      });
      // el personal no puede crear cupones: el intento queda con el código tecleado
      const denied = await post(staff);
      await settle();
      expect(denied.statusCode).toBe(403);
      expect((await rows()).at(-1)).toMatchObject({
        action: 'coupons.create',
        status: 403,
        summary: 'Cupón creado: verano10 — rechazado (forbidden)',
      });
    });

    it('en las demás rutas el campo code sigue fuera de la bitácora', async () => {
      const wanted = 'verano10';
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        headers: admin,
        payload: { name: 'Zona Code', areas: ['Naco'], feeCentavos: 10_000, code: wanted },
      });
      await settle();
      expect(res.statusCode, res.body).toBe(201);
      const row = (await rows()).at(-1)!;
      expect(row.action).toBe('zones.create');
      expect(JSON.stringify(row)).not.toContain(wanted);
      expect(row.payload).toEqual({ name: 'Zona Code', areas: ['Naco'], feeCentavos: 10_000 });
    });

    it('la app del repartidor también se audita, sin el PIN', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/driver/orders/${UUID}/transition`,
        headers: driver,
        payload: { to: 'delivered', pin: '4821', note: 'Entregado en portería' },
      });
      await settle();
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const row = (await rows()).at(-1)!;
      expect(row).toMatchObject({
        actorId: w.driverId,
        actorRole: 'driver',
        path: '/v1/driver/orders/:id/transition',
        action: 'driver.transition',
        entityId: UUID,
        status: res.statusCode,
      });
      expect(row.payload).toEqual({ to: 'delivered', note: 'Entregado en portería' });
      expect(JSON.stringify(row)).not.toContain('4821');
    });

    it('la posición del repartidor (cada pocos segundos) NO se audita', async () => {
      const before = await rowCount();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/driver/location',
        headers: driver,
        payload: { latitude: 18.4861, longitude: -69.9312 },
      });
      await settle();
      expect(res.statusCode).toBe(200);
      expect(await rowCount()).toBe(before);
    });

    it('no registra lecturas: GET en el panel, incluida la propia bitácora', async () => {
      const before = await rowCount();
      for (const url of [
        '/v1/admin/summary',
        '/v1/admin/orders',
        '/v1/admin/catalog',
        '/v1/admin/users',
        '/v1/admin/audit',
        '/v1/admin/inventory/low',
      ]) {
        const res = await app.inject({ url, headers: admin });
        expect(res.statusCode, url).toBe(200);
      }
      await settle();
      expect(await rowCount()).toBe(before);
    });

    it('no registra lo que no pasa por el panel ni rutas inexistentes', async () => {
      const before = await rowCount();
      await app.inject({
        method: 'POST',
        url: '/v1/me/addresses',
        headers: customer,
        payload: { line1: 'Calle 1 #2', sector: 'Naco', city: 'Santo Domingo' },
      });
      await app.inject({ method: 'POST', url: '/v1/admin/no-existe', headers: admin, payload: {} });
      await settle();
      expect(await rowCount()).toBe(before);
    });

    it('un intento sin sesión o con el rol equivocado queda registrado como tal', async () => {
      const anon = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        payload: { name: 'Sin sesión', areas: ['Naco'], feeCentavos: 1 },
      });
      const cust = await createZone('Cliente curioso', customer);
      expect(anon.statusCode).toBe(401);
      expect(cust.statusCode).toBe(403);
      await settle();
      const all = await rows();
      const anonRow = all.find((r) => r.status === 401 && r.path === '/v1/admin/zones');
      expect(anonRow).toMatchObject({ actorId: null, actorRole: '' });
      const custRow = all.find((r) => r.status === 403 && r.actorId === w.customerId);
      expect(custRow).toMatchObject({ actorRole: 'customer', action: 'zones.create' });
    });
  });

  describe('qué NO se guarda', () => {
    it('el payload no lleva códigos, PIN, tokens ni contraseñas, aunque la ruta los ignore', async () => {
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
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: {
          to: 'picking',
          code: '777888',
          otp: '555444',
          pin: '3141',
          token: 'tok-super-secreto',
          extra: { password: 'clave-123', authorization: 'Bearer zzz', ok: true },
        },
      });
      await settle();
      expect(res.statusCode).toBe(200);
      const row = (await rows()).at(-1)!;
      expect(row.payload).toEqual({ to: 'picking', extra: { ok: true } });
      const text = JSON.stringify(row);
      for (const secret of ['777888', '555444', '3141', 'tok-super-secreto', 'clave-123', 'zzz']) {
        expect(text, secret).not.toContain(secret);
      }
    });

    it('el teléfono de una persona invitada se guarda enmascarado', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/users',
        headers: admin,
        payload: { phone: '809-555-9999', name: 'Nuevo Motorista', role: 'driver' },
      });
      await settle();
      expect(res.statusCode, res.body).toBe(201);
      const row = (await rows()).at(-1)!;
      expect(row).toMatchObject({
        action: 'users.invite',
        entityId: json(res).id,
        summary: 'Persona invitada al equipo: rol «driver»',
      });
      expect((row.payload as { phone: string }).phone).toBe('809-5*****99');
      expect(JSON.stringify(row)).not.toContain('5559999');
    });

    it('un texto largo se recorta a 200 caracteres', async () => {
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
      await app.inject({
        method: 'POST',
        url: `/v1/admin/orders/${created.id}/transition`,
        headers: admin,
        payload: { to: 'cancelled', note: 'motivo '.repeat(40) },
      });
      await settle();
      const row = (await rows()).at(-1)!;
      expect((row.payload as { note: string }).note).toHaveLength(201);
      expect((row.payload as { note: string }).note.endsWith('…')).toBe(true);
    });
  });

  describe('intentos de acceso fallidos', () => {
    const verify = (phone: string, code: string) =>
      app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code } });

    it('el código incorrecto de un administrador o de personal queda registrado, sin el código', async () => {
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+18095550002' },
      });
      const real = sender.last('+18095550002')!;
      const wrong = real === '000000' ? '111111' : '000000';
      const before = await rowCount();
      const res = await verify('+18095550002', wrong);
      await settle();
      expect(res.statusCode).toBe(400);
      const all = await rows();
      expect(all).toHaveLength(before + 1);
      const row = all.at(-1)!;
      expect(row).toMatchObject({
        actorId: w.adminId,
        actorRole: 'admin',
        method: 'POST',
        path: '/v1/auth/otp/verify',
        action: 'auth.login_failed',
        entity: 'user',
        entityId: w.adminId,
        status: 400,
        ip: '127.0.0.1',
      });
      expect(row.payload).toEqual({ phone: '+1809*****02', reason: 'validation' });
      const text = JSON.stringify(row);
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(real);
      expect(text).not.toContain('8095550002');

      // el personal también
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '809 555 0004' },
      });
      await verify('809 555 0004', '999999');
      await settle();
      expect((await rows()).at(-1)).toMatchObject({
        action: 'auth.login_failed',
        actorId: staffId,
        actorRole: 'staff',
      });
    });

    it('no se registran fallos de clientes, de números desconocidos ni accesos que funcionan', async () => {
      const before = await rowCount();
      // cliente con código malo
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+18095550001' },
      });
      await verify('+18095550001', '000001');
      // número que no existe
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+18295550099' },
      });
      await verify('+18295550099', '000002');
      // número inválido
      await verify('123', '000003');
      // acceso correcto de un administrador
      await app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+18095550002' },
      });
      const ok = await verify('+18095550002', sender.last('+18095550002')!);
      expect(ok.statusCode).toBe(200);
      await settle();
      expect(await rowCount()).toBe(before);
    });
  });

  describe('un fallo de la bitácora nunca rompe la respuesta', () => {
    it('si no se puede escribir, la acción responde igual y el error queda en el log', async () => {
      const { db } = w.handle;
      await db.execute(sql`ALTER TABLE audit_log RENAME TO audit_log_roto`);
      try {
        const res = await createZone('Zona con bitácora rota');
        expect(res.statusCode, res.body).toBe(201);
        expect(json(res).name).toBe('Zona con bitácora rota');
      } finally {
        await db.execute(sql`ALTER TABLE audit_log_roto RENAME TO audit_log`);
      }
      const logged = logLines.join('');
      expect(logged).toContain('No se pudo escribir en la bitácora de auditoría');
      expect(logged).toContain('zones.create');
      // El texto de la base (podría traer valores de la fila) no se vuelca al log.
      expect(logged).not.toContain('Zona con bitácora rota');
      // y la zona sí se guardó
      const zones = await db.execute(
        sql`SELECT count(*)::int AS n FROM delivery_zones WHERE name = 'Zona con bitácora rota'`,
      );
      expect((zones.rows as { n: number }[])[0]!.n).toBe(1);

      // al repararse, vuelve a escribir
      const ok = await createZone('Zona con bitácora sana');
      expect(ok.statusCode).toBe(201);
      expect((await rows()).at(-1)).toMatchObject({ action: 'zones.create', status: 201 });
    });
  });

  describe('límite de peticiones', () => {
    it('lo que el límite rechaza (429) no se audita: no amplifica el abuso', async () => {
      // App propia: el contador de peticiones es por instancia y otras pruebas ya usaron esta ruta.
      const limited = await buildApp({
        db: w.handle.db,
        config: w.config,
        otpSender: new MemoryOtpSender(),
        now: nextTime,
      });
      try {
        const before = await rowCount();
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
          const res = await limited.inject({
            method: 'POST',
            url: `/v1/driver/orders/${UUID}/transition`,
            payload: { to: 'delivered' },
          });
          statuses.push(res.statusCode);
        }
        await new Promise((resolve) => setImmediate(resolve));
        await limited.audit.idle();
        expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
        expect(statuses[30]).toBe(429);
        // las 30 que pasaron quedan; la rechazada por el límite, no
        expect(await rowCount()).toBe(before + 30);
      } finally {
        await limited.close();
      }
    });
  });

  describe('GET /v1/admin/audit', () => {
    it('solo el administrador la ve', async () => {
      for (const headers of [staff, customer, driver]) {
        expect((await app.inject({ url: '/v1/admin/audit', headers })).statusCode).toBe(403);
      }
      expect((await app.inject({ url: '/v1/admin/audit' })).statusCode).toBe(401);
      const ok = await app.inject({ url: '/v1/admin/audit?limit=200', headers: admin });
      expect(ok.statusCode).toBe(200);
      expect(json(ok)).toEqual({ items: expect.any(Array), nextCursor: null });
    });

    it('trae lo más reciente primero, con el nombre de quien actuó', async () => {
      await createZone('Más reciente');
      const page = json(await app.inject({ url: '/v1/admin/audit?limit=2', headers: admin }));
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({
        action: 'zones.create',
        actorName: 'Admin',
        actorRole: 'admin',
        summary: 'Zona de entrega creada: Más reciente',
      });
      expect(new Date(page.items[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(page.items[1].createdAt).getTime(),
      );
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('pagina con cursor sin repetir ni saltar filas, aunque varias compartan la misma hora', async () => {
      // 7 acciones en el MISMO instante: el desempate por id debe bastar para no perder ninguna.
      frozen = new Date(clock.getTime() + 10);
      const instant = frozen.toISOString();
      try {
        for (let i = 0; i < 7; i++) {
          const res = await app.inject({
            method: 'PATCH',
            url: `/v1/admin/zones/${w.zoneId}`,
            headers: admin,
            payload: { feeCentavos: 20_000 + i },
          });
          expect(res.statusCode).toBe(200);
        }
        await settle();
      } finally {
        clock = new Date(instant); // el reloj sigue desde ahí: las filas nuevas quedan después
        frozen = null;
      }
      const total = await rowCount();

      const seen: { id: string; createdAt: string }[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/v1/admin/audit?limit=4${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
        const page = json(await app.inject({ url, headers: admin }));
        seen.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < 50);

      expect(seen).toHaveLength(total);
      expect(new Set(seen.map((i) => i.id)).size).toBe(total);
      // más reciente primero; dentro de una misma hora, por id descendente
      for (let i = 1; i < seen.length; i++) {
        const a = seen[i - 1]!;
        const b = seen[i]!;
        expect(a.createdAt >= b.createdAt, `${a.createdAt} vs ${b.createdAt}`).toBe(true);
        if (a.createdAt === b.createdAt) expect(a.id > b.id).toBe(true);
      }
      // las 7 simultáneas están todas (las páginas de 4 las cortan por la mitad)
      expect(seen.filter((i) => i.createdAt === instant)).toHaveLength(7);
    });

    it('el servicio nunca entrega más de 200 filas por página, aunque se lo pidan', async () => {
      const base = nextTime().getTime();
      await w.handle.db.insert(auditLog).values(
        Array.from({ length: 205 }, (_, i) => ({
          method: 'POST',
          path: '/v1/admin/relleno',
          action: 'relleno.create',
          status: 200,
          createdAt: new Date(base + i),
        })),
      );
      try {
        const page = await app.audit.list({ limit: 1000, action: 'relleno.create' });
        expect(page.items).toHaveLength(200);
        expect(page.nextCursor).toEqual(expect.any(String));
        const rest = await app.audit.list({ before: page.nextCursor!, action: 'relleno.create' });
        expect(rest.items).toHaveLength(5);
        expect(rest.nextCursor).toBeNull();
        expect((await app.audit.list({ limit: 0, action: 'relleno.create' })).items).toHaveLength(
          1,
        );
      } finally {
        // no deja filas "del futuro" que alteren el orden de las demás pruebas
        await w.handle.db.delete(auditLog).where(eq(auditLog.action, 'relleno.create'));
      }
    });

    it('filtra por persona y por acción (exacta o por prefijo)', async () => {
      const byStaff = json(
        await app.inject({ url: `/v1/admin/audit?actorId=${staffId}&limit=200`, headers: admin }),
      );
      expect(byStaff.items.length).toBeGreaterThan(0);
      expect(byStaff.items.every((i: { actorId: string }) => i.actorId === staffId)).toBe(true);

      const exact = json(
        await app.inject({
          url: '/v1/admin/audit?action=orders.transition&limit=200',
          headers: admin,
        }),
      );
      expect(exact.items.length).toBeGreaterThan(0);
      expect(exact.items.every((i: { action: string }) => i.action === 'orders.transition')).toBe(
        true,
      );

      const prefix = json(
        await app.inject({ url: '/v1/admin/audit?action=zones.*&limit=200', headers: admin }),
      );
      const actions = new Set(prefix.items.map((i: { action: string }) => i.action));
      expect([...actions].every((a) => (a as string).startsWith('zones.'))).toBe(true);
      expect(actions.has('zones.create') && actions.has('zones.update')).toBe(true);

      const none = json(
        await app.inject({ url: '/v1/admin/audit?action=no.existe', headers: admin }),
      );
      expect(none).toEqual({ items: [], nextCursor: null });
    });

    it('un cursor puede ser también una fecha ISO; lo inválido da 400', async () => {
      const all = await rows();
      const mid = all[Math.floor(all.length / 2)]!.createdAt;
      const page = json(
        await app.inject({
          url: `/v1/admin/audit?before=${encodeURIComponent(mid.toISOString())}&limit=200`,
          headers: admin,
        }),
      );
      const expected = all.filter((r) => r.createdAt < mid).map((r) => r.id);
      expect(expected.length).toBeGreaterThan(0);
      expect(page.items.map((i: { id: string }) => i.id).sort()).toEqual([...expected].sort());

      for (const q of [
        'before=ayer',
        `before=${NOW.toISOString()}|no-uuid`,
        'limit=0',
        'limit=201',
        'actorId=x',
        'action=a%20b',
      ]) {
        const res = await app.inject({ url: `/v1/admin/audit?${q}`, headers: admin });
        expect(res.statusCode, q).toBe(400);
      }
    });
  });

  describe('IP real detrás de un balanceador', () => {
    it('con TRUST_PROXY la bitácora guarda la IP del cliente, no la del balanceador', async () => {
      const proxied = await buildApp({
        db: w.handle.db,
        config: { ...w.config, trustProxy: 1 },
        otpSender: new MemoryOtpSender(),
        now: nextTime,
      });
      try {
        const token = proxied.jwt.sign({ sub: w.adminId, role: 'admin' });
        const res = await proxied.inject({
          method: 'POST',
          url: '/v1/admin/zones',
          remoteAddress: '10.0.0.9', // el balanceador
          headers: {
            authorization: `Bearer ${token}`,
            // el cliente intenta falsificar su IP; el balanceador añade la real al final
            'x-forwarded-for': '6.6.6.6, 203.0.113.7',
          },
          payload: { name: 'Desde el balanceador', areas: ['Naco'], feeCentavos: 1 },
        });
        expect(res.statusCode, res.body).toBe(201);
        await new Promise((resolve) => setImmediate(resolve));
        await proxied.audit.idle();
        const row = (await rows()).at(-1)!;
        expect(row).toMatchObject({ action: 'zones.create', ip: '203.0.113.7' });
      } finally {
        await proxied.close();
      }
    });

    it('sin TRUST_PROXY se ignora X-Forwarded-For (no se puede falsificar)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/zones',
        remoteAddress: '198.51.100.4',
        headers: { ...admin, 'x-forwarded-for': '6.6.6.6' },
        payload: { name: 'Directo', areas: ['Naco'], feeCentavos: 1 },
      });
      expect(res.statusCode).toBe(201);
      await settle();
      expect((await rows()).at(-1)!.ip).toBe('198.51.100.4');
    });
  });

  it('la API no ofrece cómo cambiar ni borrar la bitácora', async () => {
    const before = await rowCount();
    for (const method of ['DELETE', 'POST', 'PATCH', 'PUT'] as const) {
      const res = await app.inject({ method, url: '/v1/admin/audit', headers: admin, payload: {} });
      expect(res.statusCode, method).toBe(404);
    }
    expect(await rowCount()).toBe(before);
  });
});
