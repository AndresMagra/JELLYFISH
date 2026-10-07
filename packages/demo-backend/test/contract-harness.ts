/**
 * Banco de pruebas de contrato: arranca el API REAL (buildApp + PGlite, por un puerto) y el servidor
 * de demostración detrás de la misma interfaz `Api`, y define los escenarios que corren IGUAL en
 * los dos. Lo usan `contract.test.ts` (compara) y `contract-mutation.test.ts` (prueba que comparar
 * detecta desviaciones).
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../apps/api/src/app';
import { testConfig } from '../../../apps/api/src/config';
import { type DbHandle } from '../../../apps/api/src/db/client';
import { orders, users, variants } from '../../../apps/api/src/db/schema';
import { MemoryOtpSender } from '../../../apps/api/src/services/auth';
import {
  importCatalog,
  seedDemoStock,
  syncCategories,
} from '../../../apps/api/src/services/catalog';
import { createCoupon } from '../../../apps/api/src/services/coupons';
import { createZone } from '../../../apps/api/src/services/zones';
import { createTestDb } from '../../../apps/api/test/test-db';
import { DEFAULT_ZONE, installDemoBackend } from '../src/index';
import { DEFAULT_COUPONS } from '../src/coupons';
import { type Rec, compareRec, sameValues } from './contract-lib';
import { BASE, CATEGORIES, PHOTOS, SEED_CSV, T0, fakeClock } from './helpers';

// ───────────────────────── los dos servidores, detrás de la misma interfaz ─────────────────────────

export interface Api {
  name: 'real' | 'demo';
  call(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; body: unknown; headers: Record<string, string> }>;
  /** El código que "llegó por SMS" (el API real lo guarda en memoria; la demo siempre muestra 123456). */
  otp(phone: string): Promise<string>;
  /** Deja un artículo con esas existencias. */
  setStock(sku: string, onHand: number): Promise<void>;
  /** Lleva un pedido a `out_for_delivery` o `delivered` (el API real lo hace el personal; la demo, el reloj). */
  progress(orderId: string, to: 'out_for_delivery' | 'delivered'): Promise<void>;
  close(): Promise<void>;
}

export const realClock = fakeClock(T0);

async function httpCall(
  base: string,
  fetchFn: typeof fetch,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
) {
  const res = await fetchFn(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, body: text ? JSON.parse(text) : null, headers };
}

export async function startReal(): Promise<Api & { app: FastifyInstance }> {
  const handle: DbHandle = await createTestDb();
  const { db } = handle;
  const config = testConfig({ demo: true });
  await syncCategories(db, CATEGORIES);
  const imported = await importCatalog(db, SEED_CSV);
  if (!imported.ok) throw new Error(`CSV inválido: ${JSON.stringify(imported.errors[0])}`);
  await seedDemoStock(db); // 200 lb / 50 unidades, como el modo demo del API
  await createZone(db, { ...DEFAULT_ZONE });
  for (const c of DEFAULT_COUPONS) {
    await createCoupon(db, {
      code: c.code,
      description: c.description,
      kind: c.kind,
      value: c.value,
      minSubtotal: c.minSubtotal,
      maxDiscount: c.maxDiscount,
      startsAt: null,
      endsAt: null,
      maxRedemptions: null,
      perUserLimit: c.perUserLimit,
      active: true,
    });
  }
  const [admin, driver] = await db
    .insert(users)
    .values([
      { phone: '+18095559901', name: 'Admin', role: 'admin' },
      { phone: '+18095559902', name: 'Motorista', role: 'driver' },
    ])
    .returning({ id: users.id });

  const outForDelivery = new Set<string>();
  const sender = new MemoryOtpSender();
  const app = await buildApp({
    db,
    config,
    otpSender: sender,
    now: () => new Date(realClock.now()),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const adminToken = app.jwt.sign({ sub: admin!.id, role: 'admin' });
  const driverToken = app.jwt.sign({ sub: driver!.id, role: 'driver' });

  const call: Api['call'] = (m, p, o) => httpCall(base, fetch, m, p, o);
  const must = async (res: Promise<{ status: number; body: unknown }>, what: string) => {
    const r = await res;
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };

  return {
    name: 'real',
    app,
    call,
    otp: async (phone) => {
      const e164 = `+1${phone.replace(/\D/g, '').slice(-10)}`;
      const code = sender.last(e164);
      if (!code) throw new Error(`No llegó el código de ${e164}`);
      return code;
    },
    async setStock(sku, onHand) {
      await db.update(variants).set({ onHand, reserved: 0 }).where(eq(variants.sku, sku));
    },
    async progress(orderId, to) {
      const out = outForDelivery.has(orderId);
      const step = (toStatus: string, extra: object = {}) =>
        must(
          call('POST', `/v1/admin/orders/${orderId}/transition`, {
            token: adminToken,
            body: { to: toStatus, ...extra },
          }),
          `a ${toStatus}`,
        );
      const order = (
        await must(call('GET', `/v1/admin/orders/${orderId}`, { token: adminToken }), 'detalle')
      ).body as {
        items: { id: string; quantity: number }[];
        finalTotal: number | null;
        total: number;
        paymentMethod: string;
      };
      if (!out) await step('picking');
      if (!out)
        await must(
          call('POST', `/v1/admin/orders/${orderId}/weights`, {
            token: adminToken,
            body: {
              weights: order.items.map((i) => ({ itemId: i.id, finalQuantity: i.quantity })),
            },
          }),
          'pesos',
        );
      if (!out) {
        await step('packed');
        await must(
          call('POST', `/v1/admin/orders/${orderId}/assign-driver`, {
            token: adminToken,
            body: { driverId: driver!.id },
          }),
          'asignar repartidor',
        );
        await step('out_for_delivery');
        await must(
          call('POST', '/v1/driver/location', {
            token: driverToken,
            body: { latitude: 18.4861, longitude: -69.9312, orderId },
          }),
          'ubicación',
        );
        outForDelivery.add(orderId);
      }
      if (to === 'out_for_delivery') return;
      const row = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
      const detail = (
        await must(call('GET', `/v1/admin/orders/${orderId}`, { token: adminToken }), 'detalle')
      ).body as {
        finalTotal: number | null;
        total: number;
      };
      await must(
        call('POST', `/v1/driver/orders/${orderId}/collect`, {
          token: driverToken,
          body: { amount: detail.finalTotal ?? detail.total },
        }),
        'cobro',
      );
      await must(
        call('POST', `/v1/driver/orders/${orderId}/transition`, {
          token: driverToken,
          body: { to: 'delivered', pin: row.deliveryPin },
        }),
        'entrega',
      );
    },
    async close() {
      await app.close();
      await handle.close();
    },
  };
}

export async function startDemo(
  tamper?: (
    res: { status: number; headers: Record<string, string>; body: string },
    req: { method: string; url: string },
  ) => void,
): Promise<Api> {
  const demoClock = fakeClock(T0);
  const target = { fetch: (() => Promise.reject(new Error('sin red'))) as unknown as typeof fetch };
  const handle = installDemoBackend({
    baseUrl: BASE,
    catalogCsv: SEED_CSV,
    categories: CATEGORIES,
    photos: PHOTOS,
    // Mismas existencias que `seedDemoStock` del API real.
    stock: { lbCentilb: 20_000, units: 50 },
    storage: null,
    latencyMs: 0,
    seed: 11,
    now: demoClock.now,
    target,
  });
  const { server } = handle;
  const placedAt = new Map<string, number>();
  return {
    name: 'demo',
    async call(m, p, o) {
      const r = await httpCall(BASE, target.fetch, m, p, o);
      if (!tamper) return r;
      // Solo para la prueba de mutación: "rompe" la respuesta como si el simulador se hubiera desviado.
      const res = {
        status: r.status,
        headers: { ...r.headers },
        body: r.body === null ? '' : JSON.stringify(r.body),
      };
      tamper(res, { method: m, url: p });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body ? JSON.parse(res.body) : null,
      };
    },
    otp: async () => '123456',
    async setStock(sku, onHand) {
      const v = [...server.catalog.variantsById.values()].find((x) => x.sku === sku)!;
      server.ctx.state.stock[v.id] = { onHand, reserved: 0 };
    },
    async progress(orderId, to) {
      const order = server.ctx.state.orders.find((o) => o.id === orderId)!;
      if (!placedAt.has(orderId)) placedAt.set(orderId, order.stageEnteredAt);
      // confirmed (25 s) + preparando (20) + empacado (20) = 65 s; luego 30 s en camino.
      demoClock.set(placedAt.get(orderId)! + (to === 'out_for_delivery' ? 70_000 : 100_000));
      server.advance();
    },
    async close() {
      handle.uninstall();
    },
  };
}

// ───────────────────────── los escenarios (idénticos para los dos) ─────────────────────────

export interface Run {
  recs: Rec[];
}

export async function scenario(api: Api): Promise<Run> {
  const recs: Rec[] = [];
  const step = async (
    label: string,
    method: string,
    path: string,
    opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
  ) => {
    const r = await api.call(method, path, opts);
    recs.push({ label, status: r.status, body: r.body, headers: r.headers });
    return r as { status: number; body: any; headers: Record<string, string> };
  };

  // ── catálogo ──
  await step('salud', 'GET', '/health');
  await step('categorías', 'GET', '/v1/categories');
  const list = await step('productos (todos)', 'GET', '/v1/products?limit=100');
  await step('productos: página 2 de 5', 'GET', '/v1/products?limit=5&offset=5');
  await step('productos: categoría mariscos', 'GET', '/v1/products?category=mariscos');
  await step('búsqueda sin acento', 'GET', '/v1/products?q=camaron');
  await step('búsqueda por sinónimo', 'GET', '/v1/products?q=gambas');
  await step('búsqueda con varias palabras', 'GET', '/v1/products?q=anillas%20calamar');
  await step('búsqueda solo símbolos', 'GET', '/v1/products?q=%25');
  await step('búsqueda sin resultados', 'GET', '/v1/products?q=zzzz');
  await step('productos: límite inválido', 'GET', '/v1/products?limit=500');
  await step('producto con variantes', 'GET', '/v1/products/camaron');
  await step('producto inexistente', 'GET', '/v1/products/nada');

  const sku = (s: string): { id: string; price: number } => {
    for (const p of list.body.items as {
      variants: { sku: string; id: string; price: number }[];
    }[]) {
      const v = p.variants.find((x) => x.sku === s);
      if (v) return v;
    }
    throw new Error(`sin ${s}`);
  };
  const shrimp = sku('JF-MAR-004'); // camarón 16/20, por libra
  const calamar = sku('JF-MAR-001');
  const combo = list.body.items
    .flatMap((p: { variants: { sku: string; id: string; pricingUnit: string }[] }) => p.variants)
    .find((v: { pricingUnit: string }) => v.pricingUnit === 'unit') as
    { sku: string; id: string } | undefined;

  // ── entrega ──
  await step('zona cubierta', 'GET', '/v1/delivery/zone?sector=Piantini&city=Santo%20Domingo');
  await step('zona no cubierta', 'GET', '/v1/delivery/zone?sector=Los%20Alcarrizos&city=Santiago');
  await step('zona sin datos', 'GET', '/v1/delivery/zone');
  const slots = await step('franjas', 'GET', '/v1/delivery/slots');
  await step('métodos de pago', 'GET', '/v1/payments/methods');
  await step('transferencia sin sesión', 'GET', '/v1/payments/transfer-info');

  // ── cotización ──
  const addrOk = { sector: 'Naco', city: 'Santo Domingo' };
  await step('cotización con dirección', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 350 }], address: addrOk },
  });
  await step('cotización sin dirección', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 400 }] },
  });
  await step('cotización fuera de zona', 'POST', '/v1/quote', {
    body: {
      items: [{ variantId: shrimp.id, quantity: 400 }],
      address: { sector: 'Los Alcarrizos', city: 'Santiago' },
    },
  });
  await step('cotización con envío gratis', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 1700 }], address: addrOk },
  });
  await step('cotización con dos líneas', 'POST', '/v1/quote', {
    body: {
      items: [
        { variantId: shrimp.id, quantity: 400 },
        { variantId: calamar.id, quantity: 250 },
        ...(combo ? [{ variantId: combo.id, quantity: 2 }] : []),
      ],
      address: addrOk,
    },
  });
  await step('cotización: carrito vacío', 'POST', '/v1/quote', { body: { items: [] } });
  await step('cotización: variante inválida', 'POST', '/v1/quote', {
    body: { items: [{ variantId: 'x', quantity: 1 }] },
  });
  await step('cotización: variante inexistente', 'POST', '/v1/quote', {
    body: { items: [{ variantId: '00000000-0000-4000-8000-000000000000', quantity: 100 }] },
  });
  await step('cotización: bajo el mínimo del artículo', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 50 }] },
  });
  await step('cotización: no es múltiplo del paso', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 125 }] },
  });
  await step('cotización: sobre el máximo', 'POST', '/v1/quote', {
    body: { items: [{ variantId: shrimp.id, quantity: 10_100 }] },
  });
  if (combo) {
    await step('cotización: demasiadas unidades', 'POST', '/v1/quote', {
      body: { items: [{ variantId: combo.id, quantity: 21 }] },
    });
  }

  // ── error de stock ──
  const tight = sku('JF-MAR-003');
  await api.setStock('JF-MAR-003', 300);
  await step('cotización: solo quedan 3 lb', 'POST', '/v1/quote', {
    body: { items: [{ variantId: tight.id, quantity: 500 }] },
  });
  await api.setStock('JF-MAR-003', 0);
  await step('cotización: agotado', 'POST', '/v1/quote', {
    body: { items: [{ variantId: tight.id, quantity: 100 }] },
  });
  await step('producto agotado en la lista', 'GET', '/v1/products/camaron');

  // ── cuenta ──
  const phone = '809-555-0111';
  await step('código: teléfono inválido', 'POST', '/v1/auth/otp/request', {
    body: { phone: '305-555-0101' },
  });
  await step('código: pedir', 'POST', '/v1/auth/otp/request', { body: { phone } });
  await step('código: formato inválido', 'POST', '/v1/auth/otp/verify', {
    body: { phone, code: '12' },
  });
  const verified = await step('código: verificar', 'POST', '/v1/auth/otp/verify', {
    body: { phone, code: await api.otp(phone) },
  });
  const token = verified.body.token as string;
  await step('yo (sin sesión)', 'GET', '/v1/me');
  await step('yo', 'GET', '/v1/me', { token });
  await step('yo: cambiar nombre y correo', 'PATCH', '/v1/me', {
    token,
    body: { name: '  Andrés Prueba ', email: 'andres@ejemplo.do' },
  });
  await step('yo: correo inválido', 'PATCH', '/v1/me', { token, body: { email: 'no-es-correo' } });
  await step('yo: sin cambios', 'PATCH', '/v1/me', { token, body: {} });

  // ── direcciones ──
  const addrBody = {
    label: 'Casa',
    line1: 'Calle Max Henríquez Ureña 10',
    reference: 'Al lado del colmado Don Pepe, portón negro',
    sector: 'Naco',
    city: 'Santo Domingo',
    latitude: 18.4861,
    longitude: -69.9312,
  };
  const a1 = await step('dirección: crear la primera', 'POST', '/v1/me/addresses', {
    token,
    body: addrBody,
  });
  const a2 = await step('dirección: crear otra predeterminada', 'POST', '/v1/me/addresses', {
    token,
    body: { ...addrBody, label: 'Trabajo', sector: 'Piantini', isDefault: true },
  });
  await step('dirección: lista', 'GET', '/v1/me/addresses', { token });
  await step('dirección: editar', 'PUT', `/v1/me/addresses/${a1.body.id}`, {
    token,
    body: { ...addrBody, line1: 'Otra calle 5', isDefault: true },
  });
  await step('dirección: datos inválidos', 'POST', '/v1/me/addresses', {
    token,
    body: { ...addrBody, line1: 'x', latitude: 40.7 },
  });
  await step(
    'dirección: borrar inexistente',
    'DELETE',
    '/v1/me/addresses/00000000-0000-4000-8000-000000000000',
    { token },
  );
  await step('dirección: borrar', 'DELETE', `/v1/me/addresses/${a2.body.id}`, { token });
  await step('dirección: sin sesión', 'GET', '/v1/me/addresses');

  // ── pedido en efectivo ──
  const slot = (i: number) => slots.body[i].start as string;
  const cashBody = (over: object = {}) => ({
    items: [{ variantId: shrimp.id, quantity: 400 }],
    addressId: a1.body.id,
    slotStart: slot(0),
    paymentMethod: 'cash',
    ...over,
  });
  const idem = (k: string) => ({ 'Idempotency-Key': k });
  const cash = await step('pedido efectivo: crear', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-cash-01'),
    body: cashBody({ notes: 'Sin hielo seco', substitutionPolicy: 'refund' }),
  });
  const again = await step('pedido efectivo: reintento con la misma clave', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-cash-01'),
    body: cashBody({ notes: 'Sin hielo seco', substitutionPolicy: 'refund' }),
  });
  recs.push({
    label: 'pedido efectivo: el reintento devuelve el mismo pedido',
    status: again.body.id === cash.body.id ? 200 : 500,
    body: null,
  });
  await step('pedido efectivo: detalle', 'GET', `/v1/orders/${cash.body.id}`, { token });
  await step('pedidos: lista', 'GET', '/v1/orders', { token });
  await step('pedido: id inválido', 'GET', '/v1/orders/abc', { token });
  await step('pedido: inexistente', 'GET', '/v1/orders/00000000-0000-4000-8000-000000000000', {
    token,
  });
  await step('pedido: sin sesión', 'GET', `/v1/orders/${cash.body.id}`);
  await step('pedir de nuevo', 'GET', `/v1/orders/${cash.body.id}/reorder`, { token });
  await step('seguimiento antes de salir', 'GET', `/v1/orders/${cash.body.id}/tracking`, { token });
  await step('pedido: no es de tarjeta', 'POST', `/v1/orders/${cash.body.id}/pay`, { token });
  await step(
    'pedido: no es de transferencia',
    'POST',
    `/v1/orders/${cash.body.id}/transfer-proof`,
    { token, body: { reference: 'abc123' } },
  );
  const cancelled = await step(
    'cancelar (confirmado)',
    'POST',
    `/v1/orders/${cash.body.id}/cancel`,
    { token, body: { reason: 'Cambié de idea' } },
  );
  await step('cancelar otra vez', 'POST', `/v1/orders/${cash.body.id}/cancel`, { token, body: {} });
  recs.push({
    label: 'cancelar: el stock vuelve',
    status: cancelled.body.status === 'cancelled' ? 200 : 500,
    body: null,
  });
  await step('el stock vuelve tras cancelar', 'GET', '/v1/products/camaron');

  // ── errores al crear un pedido ──
  await step('pedido: sin dirección', 'POST', '/v1/orders', {
    token,
    body: cashBody({ addressId: undefined }),
  });
  await step('pedido: clave de idempotencia corta', 'POST', '/v1/orders', {
    token,
    headers: idem('corta'),
    body: cashBody(),
  });
  await step('pedido: dirección inexistente', 'POST', '/v1/orders', {
    token,
    body: cashBody({ addressId: '00000000-0000-4000-8000-000000000000' }),
  });
  await step('pedido: fuera de zona', 'POST', '/v1/orders', {
    token,
    body: cashBody({
      addressId: undefined,
      address: { ...addrBody, sector: 'Los Alcarrizos', city: 'Santiago' },
    }),
  });
  await step('pedido: bajo el mínimo de la zona', 'POST', '/v1/orders', {
    token,
    body: cashBody({ items: [{ variantId: shrimp.id, quantity: 100 }] }),
  });
  await step('pedido: franja que no existe', 'POST', '/v1/orders', {
    token,
    body: cashBody({ slotStart: '2026-10-07T05:00:00.000Z' }),
  });
  await step('pedido: método inválido', 'POST', '/v1/orders', {
    token,
    body: cashBody({ paymentMethod: 'bitcoin' }),
  });
  await step('pedido: sin stock', 'POST', '/v1/orders', {
    token,
    body: cashBody({ items: [{ variantId: tight.id, quantity: 100 }] }),
  });

  // ── tarjeta ──
  const card = await step('pedido tarjeta: crear', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-card-01'),
    body: cashBody({ paymentMethod: 'card', slotStart: slot(1) }),
  });
  const pay = await step(
    'pedido tarjeta: iniciar el pago',
    'POST',
    `/v1/orders/${card.body.id}/pay`,
    { token },
  );
  recs.push({
    label: 'pedido tarjeta: la dirección de pago es una URL',
    status: /^https?:\/\//.test(pay.body.redirectUrl) ? 200 : 500,
    body: null,
  });
  await step(
    'pedido tarjeta: detalle con el intento pendiente',
    'GET',
    `/v1/orders/${card.body.id}`,
    { token },
  );
  await step('pedido tarjeta: otro pago de otra persona', 'POST', `/v1/orders/${card.body.id}/pay`);

  // ── transferencia ──
  const transfer = await step('pedido transferencia: crear', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-transfer-1'),
    body: cashBody({ paymentMethod: 'transfer', slotStart: slot(2) }),
  });
  await step('transferencia: datos bancarios', 'GET', '/v1/payments/transfer-info', { token });
  await step(
    'transferencia: referencia inválida',
    'POST',
    `/v1/orders/${transfer.body.id}/transfer-proof`,
    { token, body: { reference: 'x' } },
  );
  await step(
    'transferencia: enviar la referencia',
    'POST',
    `/v1/orders/${transfer.body.id}/transfer-proof`,
    { token, body: { reference: '889900123', note: 'Banco Popular' } },
  );

  // El tiempo solo corre en la demostración (en el API real lo mueve el personal), así que antes de
  // avanzar el reloj se cancelan los pedidos que esperan pago: los dos lados llegan al mismo estado.
  await step(
    'cancelar el pedido de tarjeta que esperaba pago',
    'POST',
    `/v1/orders/${card.body.id}/cancel`,
    { token, body: {} },
  );
  await step(
    'cancelar el pedido de transferencia que esperaba pago',
    'POST',
    `/v1/orders/${transfer.body.id}/cancel`,
    { token, body: { reason: 'Prueba' } },
  );

  // ── ciclo de vida: en camino y entregado ──
  const ride = await step('pedido para entregar: crear', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-ride-001'),
    body: cashBody({ slotStart: slot(3) }),
  });
  await api.progress(ride.body.id, 'out_for_delivery');
  await step('en camino: detalle (PIN visible)', 'GET', `/v1/orders/${ride.body.id}`, { token });
  await step('en camino: seguimiento', 'GET', `/v1/orders/${ride.body.id}/tracking`, { token });
  await step('en camino: ya no se puede cancelar', 'POST', `/v1/orders/${ride.body.id}/cancel`, {
    token,
    body: {},
  });
  await api.progress(ride.body.id, 'delivered');
  await step('entregado: detalle', 'GET', `/v1/orders/${ride.body.id}`, { token });
  await step('entregado: seguimiento', 'GET', `/v1/orders/${ride.body.id}/tracking`, { token });
  await step('entregado: pedir de nuevo', 'GET', `/v1/orders/${ride.body.id}/reorder`, { token });
  await step('pedidos: lista final', 'GET', '/v1/orders', { token });

  // ── cupones ──
  const q = (couponCode: string, tk: string | null = token, quantity = 800) =>
    step(`cupón ${couponCode}${tk ? '' : ' sin sesión'}`, 'POST', '/v1/quote', {
      token: tk,
      body: { items: [{ variantId: shrimp.id, quantity }], address: addrOk, couponCode },
    });
  await q('BIENVENIDO10');
  await q('bienvenido10', null);
  await q('NOEXISTE');
  await q('ENVIOGRATIS');
  await q('AHORRA200');
  await q('BIENVENIDO10', token, 350);
  await step('cupón: pedido con cupón', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-cupon-01'),
    body: cashBody({
      items: [{ variantId: shrimp.id, quantity: 800 }],
      couponCode: 'BIENVENIDO10',
      slotStart: slot(4),
    }),
  });
  await step('cupón: pedido con cupón inválido', 'POST', '/v1/orders', {
    token,
    headers: idem('contrato-cupon-02'),
    body: cashBody({
      items: [{ variantId: shrimp.id, quantity: 800 }],
      couponCode: 'NOEXISTE',
      slotStart: slot(4),
    }),
  });

  // ── dispositivos (push) ──
  const device = 'ExponentPushToken[abcdefghijklmnop]';
  await step('dispositivo: registrar', 'POST', '/v1/me/devices', {
    token,
    body: { token: device, platform: 'ios' },
  });
  await step('dispositivo: token inválido', 'POST', '/v1/me/devices', {
    token,
    body: { token: 'malo', platform: 'ios' },
  });
  await step('dispositivo: plataforma inválida', 'POST', '/v1/me/devices', {
    token,
    body: { token: device, platform: 'palm' },
  });
  await step('dispositivo: dar de baja', 'DELETE', `/v1/me/devices/${encodeURIComponent(device)}`, {
    token,
  });
  await step(
    'dispositivo: dar de baja otra vez',
    'DELETE',
    `/v1/me/devices/${encodeURIComponent(device)}`,
    { token },
  );

  // ── ruta que no existe y borrar la cuenta ──
  await step('ruta inexistente', 'GET', '/v1/no-existe');
  await step('cuenta: borrar', 'DELETE', '/v1/me', { token });
  await step('cuenta: la sesión ya no vale', 'GET', '/v1/me', { token });
  return { recs };
}

/** Valores que deben ser idénticos en ambos (mismo código de dinero, mismas franjas, mismos textos). */
export const SAME_VALUES: Record<string, string[]> = {
  franjas: ['0.start', '0.end', '0.remaining', '1.start'],
  'zona cubierta': ['covered', 'feeCentavos', 'minOrderCentavos', 'freeOverCentavos', 'zone.name'],
  'cotización con dirección': [
    'subtotal',
    'itbis',
    'deliveryFee',
    'total',
    'authorizedAmount',
    'missingForMinimum',
    'coverage',
    'demo',
  ],
  'cotización sin dirección': [
    'subtotal',
    'itbis',
    'deliveryFee',
    'total',
    'authorizedAmount',
    'coverage',
  ],
  'cotización con envío gratis': [
    'subtotal',
    'deliveryFee',
    'freeDelivery',
    'total',
    'missingForFreeDelivery',
  ],
  'cotización con dos líneas': [
    'subtotal',
    'itbis',
    'total',
    'lines.0.net',
    'lines.1.net',
    'lines.0.itbis',
  ],
  'cupón BIENVENIDO10': [
    'subtotal',
    'discount',
    'deliveryFee',
    'total',
    'coupon.code',
    'coupon.discount',
    'coupon.description',
    'couponError',
  ],
  'cupón ENVIOGRATIS': ['deliveryFee', 'freeDelivery', 'coupon.discount', 'coupon.description'],
  'cupón AHORRA200': ['subtotal', 'discount', 'total', 'coupon.description', 'couponError'],
  'cupón bienvenido10 sin sesión': ['couponError'],
  'cupón NOEXISTE': ['couponError'],
  'pedido efectivo: crear': [
    'subtotal',
    'itbis',
    'deliveryFee',
    'total',
    'authorizedAmount',
    'status',
    'code',
    'items.0.lineTotal',
    'items.0.unitPrice',
  ],
  'pedido tarjeta: crear': ['status', 'total', 'deliveryPin'],
  'cupón: pedido con cupón': ['discount', 'couponCode', 'total'],
};

/** Todas las diferencias entre las dos corridas (forma + valores obligatorios). Vacío = el contrato se cumple. */
export function compareRuns(real: Run, demo: Run, opts: { values?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (real.recs.length !== demo.recs.length) {
    problems.push(`corridas de distinto largo: real ${real.recs.length}, demo ${demo.recs.length}`);
  }
  real.recs.forEach((r, i) => {
    const d = demo.recs[i];
    if (!d) return;
    const diffs = compareRec(r, d);
    if (diffs.length) problems.push(`── ${r.label}\n   ${diffs.join('\n   ')}`);
  });
  if (opts.values !== false) {
    for (const [label, paths] of Object.entries(SAME_VALUES)) {
      const i = real.recs.findIndex((r) => r.label === label);
      if (i < 0 || !demo.recs[i]) {
        problems.push(`── ${label}: falta el escenario`);
        continue;
      }
      const diffs = sameValues(real.recs[i]!, demo.recs[i]!, paths);
      if (diffs.length) problems.push(`── ${label}: ${diffs.join('; ')}`);
    }
  }
  return problems;
}
