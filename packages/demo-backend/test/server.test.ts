import { parseCatalogCsv, groupProducts } from '@jellyfish/catalog';
import { computeOrderTotals, formatDOP, normalizeDominicanPhone } from '@jellyfish/shared';
import { describe, expect, it, vi } from 'vitest';
import { installDemoBackend } from '../src/index';
import {
  ADDRESS,
  BASE,
  CATEGORIES,
  SEED_CSV,
  allProducts,
  categories,
  clientFor,
  fakeClock,
  makeServer,
  placeOrder,
  variantBySku,
} from './helpers';

function fresh() {
  const clock = fakeClock();
  const { server } = makeServer({}, clock);
  return { clock, server, c: clientFor(server) };
}

describe('catálogo (mismo CSV y mismo código que el API)', () => {
  const parsed = parseCatalogCsv(SEED_CSV, { categories: CATEGORIES.map((c) => c.slug) });
  const groups = groupProducts(parsed.items);

  it('publica todos los productos del CSV semilla, con variantes ordenadas por precio', () => {
    const { c } = fresh();
    const list = c.call('GET', '/v1/products?limit=100');
    expect(list.status).toBe(200);
    expect(list.body.demo).toBe(true);
    expect(list.body.total).toBe(groups.length);
    expect(list.body.items).toHaveLength(groups.length);
    for (const p of list.body.items) {
      const prices = p.variants.map((v: { price: number }) => v.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      expect(p.fromPrice).toBe(prices[0]);
    }
  });

  it('las categorías vacías no se muestran y van en el orden del menú', () => {
    const { c } = fresh();
    const cats = categories(c);
    const used = new Set(parsed.items.map((i) => i.category));
    expect(cats.map((x) => x.slug)).toEqual(
      CATEGORIES.filter((x) => used.has(x.slug))
        .sort((a, b) => a.sort - b.sort)
        .map((x) => x.slug),
    );
    expect(Object.keys(cats[0]!).sort()).toEqual(['name', 'slug', 'sort', 'tagline']);
  });

  it('usa la foto liviana (minUrl) del manifiesto y rotula la imagen como ilustrativa', () => {
    const { c } = fresh();
    for (const p of allProducts(c)) {
      for (const v of p.variants) {
        expect(v.photo, v.sku).toMatch(/^https:\/\/d8j0ntlcm91z4\.cloudfront\.net\/.+_min\.webp$/);
        expect(v.photoIllustrative, v.sku).toBe(true);
      }
    }
  });

  it('existencias de demostración holgadas: 100–400 lb por artículo', () => {
    const { c } = fresh();
    for (const p of allProducts(c)) {
      for (const v of p.variants) {
        if (v.pricingUnit === 'lb') {
          expect(v.available).toBeGreaterThanOrEqual(10_000);
          expect(v.available).toBeLessThanOrEqual(40_000);
        } else {
          expect(v.available).toBeGreaterThanOrEqual(30);
        }
        expect(v.inStock).toBe(true);
      }
    }
  });

  it('los ids son estables entre cargas (el carrito guardado sigue valiendo)', () => {
    const a = clientFor(makeServer().server);
    const b = clientFor(makeServer({ seed: 999 }).server);
    expect(variantBySku(a, 'JF-MAR-002').id).toBe(variantBySku(b, 'JF-MAR-002').id);
  });

  it('la búsqueda ignora acentos y mayúsculas, busca en sinónimos y exige todas las palabras', () => {
    const { c } = fresh();
    const names = (q: string) =>
      (c.call('GET', `/v1/products?q=${encodeURIComponent(q)}`).body.items as { name: string }[]).map(
        (p) => p.name,
      );
    expect(names('camaron')).toContain('Camarón');
    expect(names('CAMARÓN')).toContain('Camarón');
    expect(names('gambas')).toContain('Camarón'); // sinónimo
    expect(names('calamar anillas')).toContain('Anillas de calamar');
    expect(names('camaron zzzz')).toEqual([]);
    expect(names('%')).toEqual([]); // solo símbolos = sin resultados
    expect(names('').length).toBe(groups.length);
  });

  it('filtra por categoría, pagina y valida los límites igual que el API', () => {
    const { c } = fresh();
    const mar = c.call('GET', '/v1/products?category=mariscos').body;
    expect(mar.items.every((p: { category: string }) => p.category === 'mariscos')).toBe(true);
    const p1 = c.call('GET', '/v1/products?limit=2&offset=0').body;
    const p2 = c.call('GET', '/v1/products?limit=2&offset=2').body;
    expect(p1.items).toHaveLength(2);
    expect(p1.total).toBe(groups.length);
    expect(p2.items[0].group).not.toBe(p1.items[0].group);
    const bad = c.call('GET', '/v1/products?limit=500');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    expect(bad.body.error.message).toMatch(/^limit: /);
  });

  it('GET /v1/products/:group devuelve el producto o 404', () => {
    const { c } = fresh();
    const r = c.call('GET', '/v1/products/camaron');
    expect(r.status).toBe(200);
    expect(r.body.product.variants.length).toBe(4);
    expect(r.body.demo).toBe(true);
    const nf = c.call('GET', '/v1/products/no-existe');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toEqual({ code: 'not_found', message: 'Producto no encontrado' });
  });
});

describe('entrega: zona, franjas, métodos de pago', () => {
  it('zona cubierta o no, por sector o por ciudad, sin acentos', () => {
    const { c } = fresh();
    expect(c.call('GET', '/v1/delivery/zone?sector=Piantini&city=Santo%20Domingo').body).toMatchObject({
      covered: true,
      feeCentavos: 15_000,
      minOrderCentavos: 80_000,
      freeOverCentavos: 400_000,
    });
    expect(c.call('GET', '/v1/delivery/zone?sector=Paraíso').body.covered).toBe(true);
    expect(c.call('GET', '/v1/delivery/zone?sector=Los%20Alcarrizos&city=Santiago').body).toEqual({
      covered: false,
    });
    expect(c.call('GET', '/v1/delivery/zone').body.covered).toBe(false);
  });

  it('franjas de 2 horas (hora de RD), con 90 min de anticipación y 8 cupos', () => {
    const { c } = fresh(); // 10:00 a. m. en RD
    const slots = c.call('GET', '/v1/delivery/slots').body as {
      start: string;
      end: string;
      remaining: number;
      available: boolean;
    }[];
    expect(slots[0]).toEqual({
      start: '2026-10-07T16:00:00.000Z', // 12:00 RD: la primera con 90 min de anticipación
      end: '2026-10-07T18:00:00.000Z',
      remaining: 8,
      available: true,
    });
    expect(slots).toHaveLength(4 + 5 * 3); // hoy 12–20 (4) + 3 días de 5
    for (const s of slots) expect(Date.parse(s.end) - Date.parse(s.start)).toBe(2 * 3_600_000);
  });

  it('un pedido ocupa un cupo de su franja y 8 pedidos la llenan', () => {
    const { c } = fresh();
    const { token } = c.login();
    const first = placeOrder(c, token, { key: 'cupo-00001' });
    expect(first.res.status).toBe(201);
    const after = c.call('GET', '/v1/delivery/slots').body[0];
    expect(after.remaining).toBe(7);
    for (let i = 1; i < 8; i++) expect(placeOrder(c, token, { key: `cupo-0000${i + 1}` }).res.status).toBe(201);
    const full = c.call('GET', '/v1/delivery/slots').body[0];
    expect(full).toMatchObject({ remaining: 0, available: false });
    const over = placeOrder(c, token, { key: 'cupo-99999' });
    expect(over.res.status).toBe(400);
    expect(over.res.body.error.message).toBe('Esa franja de entrega ya está llena. Elige otra.');
  });

  it('métodos de pago y datos de transferencia (esta última pide sesión)', () => {
    const { c } = fresh();
    expect(c.call('GET', '/v1/payments/methods').body).toEqual({
      card: { available: true },
      cash: { available: true },
      transfer: { available: true },
    });
    expect(c.call('GET', '/v1/payments/transfer-info').status).toBe(401);
  });
});

describe('cotización (reglas de dinero compartidas)', () => {
  it('coincide con computeOrderTotals, incluido el ITBIS y el envío', () => {
    const { c } = fresh();
    const v = variantBySku(c, 'JF-MAR-004');
    const q = c.call('POST', '/v1/quote', {
      body: { items: [{ variantId: v.id, quantity: 350 }], address: { sector: 'Naco', city: 'Santo Domingo' } },
    });
    expect(q.status).toBe(200);
    const expected = computeOrderTotals(
      [{ id: v.id, pricingUnit: 'lb', unitPrice: v.price, itbisBps: v.itbisBps, quantity: 350, variableWeight: true }],
      { deliveryFee: 15_000 },
    );
    expect(q.body).toMatchObject({
      subtotal: expected.subtotal,
      itbis: expected.itbis,
      deliveryFee: 15_000,
      total: expected.total,
      coverage: 'covered',
      demo: true,
      coupon: null,
      couponError: null,
      freeDelivery: false,
    });
    // colchón de peso variable (10 %) sobre lo pedido
    expect(q.body.authorizedAmount).toBe(expected.total + Math.ceil(expected.subtotal * 0.1));
    expect(q.body.missingForMinimum).toBe(Math.max(0, 80_000 - expected.subtotal));
  });

  it('sin dirección la cobertura es "unknown"; fuera de zona, "not_covered"; envío gratis desde RD$ 4,000', () => {
    const { c } = fresh();
    const v = variantBySku(c, 'JF-MAR-004');
    const body = (address?: object, quantity = 400) => ({
      items: [{ variantId: v.id, quantity }],
      ...(address ? { address } : {}),
    });
    expect(c.call('POST', '/v1/quote', { body: body() }).body).toMatchObject({ coverage: 'unknown', deliveryFee: 0, zone: null });
    expect(c.call('POST', '/v1/quote', { body: body({ sector: 'Los Alcarrizos', city: 'Santiago' }) }).body.coverage).toBe('not_covered');
    const big = c.call('POST', '/v1/quote', { body: body({ sector: 'Naco', city: 'Santo Domingo' }, 1700) }).body;
    expect(big.subtotal).toBeGreaterThanOrEqual(400_000);
    expect(big).toMatchObject({ freeDelivery: true, deliveryFee: 0 });
  });

  it('errores de cantidad con los mismos códigos, estados y mensajes del API', () => {
    const { c } = fresh();
    const v = variantBySku(c, 'JF-MAR-004');
    const q = (quantity: number, variantId = v.id) =>
      c.call('POST', '/v1/quote', { body: { items: [{ variantId, quantity }] } });
    expect(q(50).body.error).toMatchObject({ code: 'validation', message: expect.stringContaining('El mínimo de') });
    expect(q(125).body.error.message).toMatch(/múltiplos de 0.5 lb/);
    expect(q(10_100).body.error.message).toMatch(/El máximo por pedido de .* es 100 lb/);
    expect(q(100, '00000000-0000-4000-8000-000000000000').body.error.code).toBe('invalid_item');
    expect(c.call('POST', '/v1/quote', { body: { items: [] } }).body.error.message).toBe('items: El carrito está vacío');
    expect(c.call('POST', '/v1/quote', { body: { items: [{ variantId: 'x', quantity: 1 }] } }).body.error.message).toBe(
      'items.0.variantId: Identificador inválido',
    );
  });

  it('stock insuficiente: out_of_stock 409 con lo que queda, o "está agotado"', () => {
    const { server } = makeServer({ stock: { bySku: { 'JF-MAR-004': 300, 'JF-MAR-002': 0 } } });
    const c = clientFor(server);
    const v = variantBySku(c, 'JF-MAR-004');
    const r = c.call('POST', '/v1/quote', { body: { items: [{ variantId: v.id, quantity: 500 }] } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'out_of_stock',
      message: 'Solo quedan 3 lb de Camarón 16/20',
      details: { variantId: v.id, available: 300 },
    });
    const gone = variantBySku(c, 'JF-MAR-002');
    expect(gone.inStock).toBe(false);
    const r2 = c.call('POST', '/v1/quote', { body: { items: [{ variantId: gone.id, quantity: 100 }] } });
    expect(r2.body.error.message).toBe('Camarón 8/12 está agotado');
  });
});

describe('sesión y cuenta', () => {
  it('cualquier código de 6 dígitos sirve; 123456 es el que se le muestra a la persona', () => {
    const { c } = fresh();
    expect(c.call('POST', '/v1/auth/otp/request', { body: { phone: '(809) 555-0199' } })).toMatchObject({
      status: 200,
      body: { phone: '+18095550199', expiresInSeconds: 600 },
    });
    for (const code of ['123456', '000000', '987654']) {
      const v = c.call('POST', '/v1/auth/otp/verify', { body: { phone: '809-555-0199', code } });
      expect(v.status).toBe(200);
      expect(v.body.user).toMatchObject({ phone: '+18095550199', name: '', email: null, role: 'customer' });
      expect(v.body.token).toBeTruthy();
    }
    // Misma persona en las tres entradas.
    const ids = new Set(
      [1, 2].map(() => c.call('POST', '/v1/auth/otp/verify', { body: { phone: '8095550199', code: '123456' } }).body.user.id),
    );
    expect(ids.size).toBe(1);
  });

  it('valida teléfono y código con los mismos mensajes del API', () => {
    const { c } = fresh();
    const badPhone = c.call('POST', '/v1/auth/otp/request', { body: { phone: '305-555-0101' } });
    expect(badPhone.status).toBe(400);
    expect(badPhone.body.error.message).toBe('Ingresa un número dominicano válido (809, 829 o 849)');
    const badCode = c.call('POST', '/v1/auth/otp/verify', { body: { phone: '8095550199', code: '12' } });
    expect(badCode.body.error.message).toBe('code: El código tiene 6 dígitos');
    expect(normalizeDominicanPhone('809-555-0199')).toBe('+18095550199');
  });

  it('con strictOtp pide el código antes, acepta solo 123456 y limita a 3 códigos por 10 min', () => {
    const { server } = makeServer({ strictOtp: true });
    const c = clientFor(server);
    const verify = (code: string) =>
      c.call('POST', '/v1/auth/otp/verify', { body: { phone: '8095550150', code } });
    expect(verify('123456').body.error.message).toBe('Código incorrecto o vencido'); // sin pedirlo
    for (let i = 0; i < 3; i++) c.call('POST', '/v1/auth/otp/request', { body: { phone: '8095550150' } });
    const limited = c.call('POST', '/v1/auth/otp/request', { body: { phone: '8095550150' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(verify('654321').body.error.code).toBe('validation');
    expect(verify('123456').status).toBe(200);
  });

  it('las rutas privadas piden sesión (401) y una sesión inventada tampoco sirve', () => {
    const { c } = fresh();
    for (const [m, p] of [
      ['GET', '/v1/me'],
      ['GET', '/v1/me/addresses'],
      ['GET', '/v1/orders'],
      ['POST', '/v1/orders'],
      ['GET', '/v1/orders/00000000-0000-4000-8000-000000000000/tracking'],
    ] as const) {
      const r = c.call(m, p);
      expect(r.status, p).toBe(401);
      expect(r.body.error).toEqual({ code: 'unauthorized', message: 'Inicia sesión para continuar' });
    }
    expect(c.call('GET', '/v1/me', { token: 'demo.inventado' }).status).toBe(401);
  });

  it('perfil: GET/PATCH (nombre y correo) y borrar la cuenta la anonimiza', () => {
    const { c } = fresh();
    const { token } = c.login();
    expect(c.call('GET', '/v1/me', { token }).body.name).toBe('');
    const p = c.call('PATCH', '/v1/me', { token, body: { name: '  Andrés  ', email: 'a@b.do' } });
    expect(p.body).toMatchObject({ name: 'Andrés', email: 'a@b.do' });
    expect(c.call('PATCH', '/v1/me', { token, body: { email: 'no-es-correo' } }).body.error.message).toBe(
      'email: Correo inválido',
    );
    expect(c.call('PATCH', '/v1/me', { token, body: {} }).body.name).toBe('Andrés');
    const del = c.call('DELETE', '/v1/me', { token });
    expect(del.status).toBe(204);
    expect(del.body).toBeNull();
    const after = c.call('GET', '/v1/me', { token });
    expect(after.status).toBe(401);
    expect(after.body.error.message).toBe('Tu sesión ya no es válida');
  });

  it('direcciones: crear (la primera es la predeterminada), cambiar, borrar; son privadas', () => {
    const { server, c } = fresh();
    const { token } = c.login();
    const a1 = c.call('POST', '/v1/me/addresses', { token, body: ADDRESS });
    expect(a1.status).toBe(201);
    expect(a1.body).toMatchObject({ isDefault: true, sector: 'Naco', city: 'Santo Domingo' });
    const a2 = c.call('POST', '/v1/me/addresses', { token, body: { ...ADDRESS, label: 'Trabajo', isDefault: true } });
    expect(a2.body.isDefault).toBe(true);
    const list = c.call('GET', '/v1/me/addresses', { token }).body;
    expect(list.map((a: { label: string }) => a.label)).toEqual(['Trabajo', 'Casa']);
    expect(list[1].isDefault).toBe(false);
    const put = c.call('PUT', `/v1/me/addresses/${a1.body.id}`, { token, body: { ...ADDRESS, line1: 'Otra calle 5', isDefault: true } });
    expect(put.body.line1).toBe('Otra calle 5');
    expect(c.call('GET', '/v1/me/addresses', { token }).body[0].id).toBe(a1.body.id);
    const other = clientFor(server).login('829-555-0303');
    expect(c.call('DELETE', `/v1/me/addresses/${a1.body.id}`, { token: other.token }).status).toBe(404);
    expect(c.call('DELETE', `/v1/me/addresses/${a1.body.id}`, { token }).status).toBe(204);
    const bad = c.call('POST', '/v1/me/addresses', { token, body: { ...ADDRESS, line1: 'x', latitude: 40.7 } });
    expect(bad.status).toBe(400);
  });

  it('dispositivos push: registrar y dar de baja no hacen nada, pero responden como el API', () => {
    const { c } = fresh();
    const { token } = c.login();
    const token1 = 'ExponentPushToken[abcdefghijklmnop]';
    const r = c.call('POST', '/v1/me/devices', { token, body: { token: token1, platform: 'ios' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ token: token1, platform: 'ios' });
    expect(c.call('POST', '/v1/me/devices', { token, body: { token: 'malo', platform: 'ios' } }).body.error.message).toBe(
      'token: Token de notificaciones inválido',
    );
    expect(c.call('DELETE', `/v1/me/devices/${encodeURIComponent(token1)}`, { token }).status).toBe(204);
    expect(c.call('DELETE', `/v1/me/devices/${encodeURIComponent(token1)}`, { token }).status).toBe(204);
  });
});

describe('pedidos', () => {
  it('crear con Idempotency-Key: el reintento devuelve el mismo pedido y no duplica ni reserva dos veces', () => {
    const { c } = fresh();
    const { token } = c.login();
    const v0 = variantBySku(c, 'JF-MAR-004');
    const a = placeOrder(c, token, { key: 'misma-clave-1' });
    const b = placeOrder(c, token, { key: 'misma-clave-1' });
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(b.res.body.id).toBe(a.res.body.id);
    expect(c.call('GET', '/v1/orders', { token }).body).toHaveLength(1);
    expect(variantBySku(c, 'JF-MAR-004').available).toBe(v0.available - 400);
  });

  it('Idempotency-Key inválida, falta de dirección, fuera de zona y pedido mínimo', () => {
    const { c } = fresh();
    const { token } = c.login();
    const v = variantBySku(c, 'JF-MAR-004');
    const slots = c.call('GET', '/v1/delivery/slots').body;
    const base = { items: [{ variantId: v.id, quantity: 400 }], slotStart: slots[0].start, paymentMethod: 'cash' };

    const noAddress = c.call('POST', '/v1/orders', { token, body: base });
    expect(noAddress.status).toBe(400);
    expect(noAddress.body.error.message).toBe('Indica la dirección de entrega');

    const shortKey = c.call('POST', '/v1/orders', { token, headers: { 'idempotency-key': 'corta' }, body: { ...base, address: ADDRESS } });
    expect(shortKey.body.error.message).toBe('Idempotency-Key debe tener entre 8 y 100 caracteres');

    const out = c.call('POST', '/v1/orders', { token, body: { ...base, address: { ...ADDRESS, sector: 'Los Alcarrizos', city: 'Santiago' } } });
    expect(out.status).toBe(409);
    expect(out.body.error).toEqual({
      code: 'out_of_zone',
      message: 'Aún aún no entregamos en Los Alcarrizos. Pronto llegaremos.'.replace('Aún aún', 'Aún'),
    });

    const small = c.call('POST', '/v1/orders', { token, body: { ...base, items: [{ variantId: v.id, quantity: 100 }], address: ADDRESS } });
    expect(small.status).toBe(409);
    expect(small.body.error.code).toBe('below_minimum');
    expect(small.body.error.message).toBe(
      `El pedido mínimo para Santo Domingo (demo) es ${formatDOP(80_000)}. Te faltan ${formatDOP(80_000 - 25_105)}.`,
    );
    const badSlot = c.call('POST', '/v1/orders', { token, body: { ...base, address: ADDRESS, slotStart: '2026-10-07T05:00:00.000Z' } });
    expect(badSlot.body.error.message).toBe('La franja de entrega elegida no está disponible');
    const missing = c.call('POST', '/v1/orders', { token, body: { ...base, addressId: '00000000-0000-4000-8000-000000000000' } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toBe('Dirección no encontrado');
  });

  it('pagar un pedido que no es de tarjeta, o de otra persona, falla como en el API', () => {
    const { c } = fresh();
    const { token } = c.login();
    const { res } = placeOrder(c, token);
    const pay = c.call('POST', `/v1/orders/${res.body.id}/pay`, { token });
    expect(pay.status).toBe(409);
    expect(pay.body.error).toEqual({ code: 'wrong_method', message: 'Este pedido no es de pago con tarjeta' });
    const proof = c.call('POST', `/v1/orders/${res.body.id}/transfer-proof`, { token, body: { reference: 'abc123' } });
    expect(proof.body.error).toEqual({ code: 'wrong_method', message: 'Este pedido no es de transferencia' });
    const bad = c.call('POST', `/v1/orders/${res.body.id}/transfer-proof`, { token, body: { reference: 'x' } });
    expect(bad.status).toBe(400);
  });

  it('pedir de nuevo ajusta a las existencias de hoy', () => {
    const { server, c } = fresh();
    const { token } = c.login();
    const { res } = placeOrder(c, token);
    const ok = c.call('GET', `/v1/orders/${res.body.id}/reorder`, { token }).body;
    expect(ok).toMatchObject({ orderId: res.body.id, code: 'JF-000001', demo: true });
    expect(ok.lines[0]).toMatchObject({ status: 'ok', quantity: 400, requestedQuantity: 400, previousUnitPrice: 25105 });
    // Quedan solo 2.5 lb de ese artículo: se sugiere lo que hay, en múltiplos del paso.
    const state = server.ctx.state.stock[ok.lines[0].variantId]!;
    state.onHand = state.reserved + 250;
    const reduced = c.call('GET', `/v1/orders/${res.body.id}/reorder`, { token }).body.lines[0];
    expect(reduced).toMatchObject({ status: 'reduced', quantity: 250 });
    expect(reduced.reason).toBe('Solo quedan 2.5 lb disponibles');
    state.onHand = state.reserved;
    expect(c.call('GET', `/v1/orders/${res.body.id}/reorder`, { token }).body.lines[0]).toMatchObject({
      status: 'unavailable',
      quantity: 0,
      reason: 'Agotado por ahora',
    });
  });
});

describe('cupones', () => {
  it('un cupón de porcentaje con tope, sin sesión pide iniciar sesión y un cupón inválido NO rompe la cotización', () => {
    const { c } = fresh();
    const { token } = c.login();
    const v = variantBySku(c, 'JF-MAR-004');
    const body = (couponCode: string) => ({
      items: [{ variantId: v.id, quantity: 800 }],
      address: { sector: 'Naco', city: 'Santo Domingo' },
      couponCode,
    });
    const anon = c.call('POST', '/v1/quote', { body: body('bienvenido10') });
    expect(anon.status).toBe(200);
    expect(anon.body).toMatchObject({ coupon: null, couponError: 'Inicia sesión para usar un cupón' });
    const ok = c.call('POST', '/v1/quote', { token, body: body(' Bienvenido-10 '.replace('-', '')) });
    expect(ok.body.coupon).toMatchObject({ code: 'BIENVENIDO10', kind: 'percent', description: '10 % de descuento (hasta RD$ 500.00)' });
    expect(ok.body.discount).toBe(Math.min(50_000, Math.floor(ok.body.subtotal * 0.1)));
    expect(ok.body.coupon.discount).toBe(ok.body.discount);
    expect(ok.body.total).toBe(ok.body.subtotal - ok.body.discount + ok.body.deliveryFee);
    const nope = c.call('POST', '/v1/quote', { token, body: body('NOEXISTE') });
    expect(nope.status).toBe(200);
    expect(nope.body).toMatchObject({ coupon: null, couponError: 'No encontramos ese cupón. Revisa que esté bien escrito' });
    const free = c.call('POST', '/v1/quote', { token, body: body('ENVIOGRATIS') });
    expect(free.body).toMatchObject({ freeDelivery: true, deliveryFee: 0 });
    expect(free.body.coupon).toMatchObject({ kind: 'free_delivery', discount: 15_000 });
  });

  it('al crear el pedido el cupón se aplica y se guarda; uno inválido RECHAZA el pedido (409 coupon_invalid)', () => {
    const { c } = fresh();
    const { token } = c.login();
    const good = placeOrder(c, token, { quantity: 800, couponCode: 'BIENVENIDO10', key: 'cupon-0001' });
    expect(good.res.status).toBe(201);
    expect(good.res.body.couponCode).toBe('BIENVENIDO10');
    expect(good.res.body.discount).toBeGreaterThan(0);
    const bad = placeOrder(c, token, { quantity: 800, couponCode: 'NOEXISTE', key: 'cupon-0002' });
    expect(bad.res.status).toBe(409);
    expect(bad.res.body.error).toMatchObject({ code: 'coupon_invalid', details: { reason: 'not_found' } });
    const below = placeOrder(c, token, { quantity: 350, couponCode: 'BIENVENIDO10', key: 'cupon-0003' });
    expect(below.res.status).toBe(409);
    expect(below.res.body.error.details.reason).toBe('below_minimum');
  });
});

describe('installDemoBackend: solo toca la dirección de la demostración', () => {
  it('atiende las URLs del baseUrl y deja pasar todo lo demás al fetch de verdad', async () => {
    const passthrough = vi.fn(async () => new Response('real', { status: 200 }));
    const target = { fetch: passthrough as unknown as typeof fetch };
    const handle = installDemoBackend({
      baseUrl: BASE,
      catalogCsv: SEED_CSV,
      categories: CATEGORIES,
      storage: null,
      latencyMs: 0,
      target,
    });
    const health = await target.fetch(`${BASE}/health`);
    expect(await health.json()).toEqual({ status: 'ok', demo: true });
    const q = await target.fetch(new URL(`${BASE}/v1/categories`));
    expect(q.status).toBe(200);
    expect(q.headers.get('content-type')).toContain('application/json');
    const post = await target.fetch(`${BASE}/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phone: '809-555-1234' }),
    });
    expect(post.status).toBe(200);
    const asRequest = await target.fetch(
      new Request(`${BASE}/v1/auth/otp/request`, { method: 'POST', body: JSON.stringify({ phone: '8095551234' }) }),
    );
    expect(asRequest.status).toBe(200);
    expect(passthrough).not.toHaveBeenCalled();

    await target.fetch('https://d8j0ntlcm91z4.cloudfront.net/foto.webp');
    await target.fetch(`${BASE}.evil.example/v1/me`); // parecido, pero otro dominio
    expect(passthrough).toHaveBeenCalledTimes(2);

    const del = await target.fetch(`${BASE}/v1/me`, { method: 'DELETE', headers: { Authorization: 'Bearer x' } });
    expect(del.status).toBe(401);
    const unknown = await target.fetch(`${BASE}/v1/no-existe`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: 'not_found', message: 'Ruta no encontrada' } });

    handle.uninstall();
    expect(target.fetch).toBe(passthrough);
  });

  it('un cuerpo que no es JSON es un 400 bad_request, no un error del servidor', () => {
    const { server } = fresh();
    const r = server.handleSync({ method: 'POST', url: `${BASE}/v1/quote`, body: '{no es json' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error.code).toBe('bad_request');
  });
});
