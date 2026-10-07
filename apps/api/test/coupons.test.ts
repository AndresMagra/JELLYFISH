import { computeOrderTotals } from '@jellyfish/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { couponRedemptions, coupons, orders, users, variants } from '../src/db/schema';
import {
  type CouponRow,
  type CouponTerms,
  CouponAttemptLimiter,
  assessCoupon,
  couponDiscount,
  createCoupon,
  isUniqueViolation,
  normalizeCouponCode,
  updateCoupon,
} from '../src/services/coupons';
import {
  type OrderContext,
  createOrder,
  expireStaleOrders,
  getOrder,
  quoteOrder,
  recordWeights,
  transitionOrder,
} from '../src/services/orders';
import { findZone, listSlots } from '../src/services/zones';
import { ADDRESS, NOW, type World, makeApp, makeWorld } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const WINDOWS = {
  startHour: 10,
  endHour: 20,
  windowHours: 2,
  capacityPerWindow: 1000,
  leadMinutes: 90,
  daysAhead: 3,
};

// Carrito base: 5 lb de pechuga = RD$ 874.75 (ITBIS 0 %), envío RD$ 150 (bajo el umbral gratis).
const POL5 = [{ sku: 'POL-1', quantity: 500 }];
// Carrito mixto: 2 lb de pechuga (0 %) + 1 combo (18 %) = RD$ 2,799.90.
const MIXED = [
  { sku: 'POL-1', quantity: 200 },
  { sku: 'CMB-1', quantity: 1 },
];

let seq = 0;
let phoneSeq = 0;

const terms = (o: Partial<CouponTerms> = {}): CouponTerms => ({
  code: `CUPON${++seq}`,
  description: '',
  kind: 'percent',
  value: 1000,
  minSubtotal: 0,
  maxDiscount: null,
  startsAt: null,
  endsAt: null,
  maxRedemptions: null,
  perUserLimit: 1,
  active: true,
  ...o,
});

async function setup(): Promise<World> {
  const w = await makeWorld({ windows: WINDOWS });
  // Existencias de sobra: estas pruebas miden cupones, no inventario.
  for (const sku of ['POL-1', 'CAM-1', 'CMB-1']) {
    await w.handle.db.update(variants).set({ onHand: 1_000_000 }).where(eq(variants.sku, sku));
  }
  return w;
}

const mkCoupon = (w: World, o: Partial<CouponTerms> = {}) => createCoupon(w.handle.db, terms(o));

async function newCustomer(w: World) {
  const [u] = await w.handle.db
    .insert(users)
    .values({
      phone: `+1809556${String(++phoneSeq).padStart(4, '0')}`,
      name: `Cliente ${phoneSeq}`,
    })
    .returning({ id: users.id });
  return u!.id;
}

async function resolve(w: World, items: { sku: string; quantity: number }[]) {
  return Promise.all(
    items.map(async (i) => ({ variantId: (await w.variant(i.sku)).id, quantity: i.quantity })),
  );
}

async function place(
  w: World,
  items: { sku: string; quantity: number }[],
  extra: Partial<Parameters<typeof createOrder>[1]> = {},
  ctx: OrderContext = w.ctx,
) {
  return createOrder(ctx, {
    userId: w.customerId,
    items: await resolve(w, items),
    address: ADDRESS,
    slotStart: await w.firstSlot(),
    paymentMethod: 'cash',
    ...extra,
  });
}

async function quote(
  w: World,
  items: { sku: string; quantity: number }[],
  code: string | undefined,
  opts: { userId?: string | null; withZone?: boolean; ctx?: OrderContext } = {},
) {
  const zone =
    opts.withZone === false
      ? null
      : await findZone(w.handle.db, { sector: 'Naco', city: 'Santo Domingo' });
  return quoteOrder(opts.ctx ?? w.ctx, {
    items: await resolve(w, items),
    zone,
    coupon: code
      ? { code, userId: opts.userId === undefined ? w.customerId : opts.userId }
      : undefined,
  });
}

const redemptionsOf = (w: World, couponId: string) =>
  w.handle.db.select().from(couponRedemptions).where(eq(couponRedemptions.couponId, couponId));

const idOf = async (w: World, code: string) =>
  (await w.handle.db.select().from(coupons).where(eq(coupons.code, code)))[0]!.id;

async function expectReject(promise: Promise<unknown>, code: string, reason?: string) {
  await expect(promise).rejects.toMatchObject({
    code,
    ...(reason ? { details: expect.objectContaining({ reason }) } : {}),
  });
}

// ───────────────────────── reglas puras ─────────────────────────

describe('código del cupón', () => {
  it('queda en mayúsculas y sin espacios, incluso invisibles', () => {
    expect(normalizeCouponCode('  verano 10 ')).toBe('VERANO10');
    expect(normalizeCouponCode('ve\u00a0rano\u200b-10\ufeff')).toBe('VERANO-10');
    expect(normalizeCouponCode('ＶＥＲＡＮＯ１０')).toBe('VERANO10');
  });

  it('convierte los guiones largos del teclado del celular en guion normal', () => {
    expect(normalizeCouponCode('envio\u2013gratis')).toBe('ENVIO-GRATIS');
    expect(normalizeCouponCode('envio\u2014gratis')).toBe('ENVIO-GRATIS');
  });
});

describe('detección de índice único', () => {
  const pgError = (message: string) => Object.assign(new Error(message), { code: '23505' });
  const wrapped = (cause: unknown) =>
    Object.assign(new Error('Failed query: insert into "coupons" (...) params: ...'), { cause });

  it('encuentra el SQLSTATE 23505 aunque el driver lo envuelva (el mensaje externo es solo el SQL)', () => {
    expect(isUniqueViolation(pgError('duplicate key value violates unique constraint'))).toBe(true);
    expect(isUniqueViolation(wrapped(pgError('lo que sea')))).toBe(true);
    expect(isUniqueViolation(wrapped(wrapped(pgError('x'))))).toBe(true);
  });

  it('no confunde otros errores con un índice único', () => {
    expect(isUniqueViolation(wrapped(Object.assign(new Error('x'), { code: '23503' })))).toBe(
      false,
    );
    expect(isUniqueViolation(new Error('connection terminated'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('texto')).toBe(false);
  });
});

describe('descuento del cupón (cálculo puro)', () => {
  const pct = (value: number, maxDiscount: number | null = null) =>
    ({ kind: 'percent', value, maxDiscount }) as const;

  it('el porcentaje redondea hacia abajo: nunca a favor del cliente', () => {
    expect(couponDiscount(pct(1000), 87_475)).toBe(8_747); // 10 % de 874.75 = 87.475
    expect(couponDiscount(pct(1), 99_999)).toBe(9); // 0.01 %
    expect(couponDiscount(pct(10_000), 87_475)).toBe(87_475);
  });

  it('respeta el tope y jamás supera el subtotal', () => {
    expect(couponDiscount(pct(5000, 2_000), 87_475)).toBe(2_000);
    expect(couponDiscount({ kind: 'fixed', value: 50_000, maxDiscount: null }, 12_000)).toBe(
      12_000,
    );
    expect(couponDiscount({ kind: 'fixed', value: 50_000, maxDiscount: 30_000 }, 87_475)).toBe(
      30_000,
    );
  });

  it('el envío gratis no descuenta productos', () => {
    expect(couponDiscount({ kind: 'free_delivery', value: 0, maxDiscount: null }, 87_475)).toBe(0);
  });

  it('un subtotal de cero no da descuento', () => {
    expect(couponDiscount(pct(1000), 0)).toBe(0);
  });
});

describe('validación del cupón (reglas puras)', () => {
  const base: CouponRow = {
    id: 'c1',
    code: 'PRUEBA',
    description: '',
    kind: 'percent',
    value: 1000,
    minSubtotal: 0,
    maxDiscount: null,
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    perUserLimit: 1,
    active: true,
    createdAt: NOW,
  };
  const cart = { subtotal: 87_475, deliveryFee: 15_000 };
  const unused = { total: 0, byUser: 0 };
  const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const msg = (c: Partial<CouponRow>, usage = unused, shop = cart) => {
    const r = assessCoupon({ ...base, ...c }, shop, usage, NOW);
    return r.ok ? 'OK' : `${r.reason}: ${r.message}`;
  };

  it('acepta un cupón vigente', () => {
    expect(msg({})).toBe('OK');
  });

  it('un cupón desactivado es indistinguible de uno que no existe', () => {
    expect(msg({ active: false })).toMatch(/^not_found: No encontramos ese cupón/);
  });

  it('ventana: empieza en startsAt (inclusive) y vence en endsAt (exclusive)', () => {
    expect(msg({ startsAt: NOW })).toBe('OK');
    expect(msg({ endsAt: minutes(1) })).toBe('OK');
    expect(msg({ endsAt: NOW })).toBe('expired: Este cupón venció');
    expect(msg({ startsAt: minutes(1) })).toMatch(
      /^not_started: Este cupón estará disponible desde el /,
    );
  });

  it('la fecha de inicio se dice en hora de República Dominicana', () => {
    // 05:00 UTC del 12 de octubre ya es 12 de octubre en RD (UTC-4)
    const r = assessCoupon(
      { ...base, startsAt: new Date('2026-10-12T05:00:00Z') },
      cart,
      unused,
      NOW,
    );
    expect(r).toMatchObject({
      ok: false,
      message: 'Este cupón estará disponible desde el 12 de octubre',
    });
  });

  it('límite global: se agota al llegar a maxRedemptions', () => {
    expect(msg({ maxRedemptions: 3 }, { total: 2, byUser: 0 })).toBe('OK');
    expect(msg({ maxRedemptions: 3 }, { total: 3, byUser: 0 })).toBe(
      'exhausted: Este cupón ya se agotó',
    );
  });

  it('límite por persona, con el texto de uso único y el de varios usos', () => {
    expect(msg({}, { total: 1, byUser: 1 })).toBe('user_limit: Ya usaste este cupón');
    expect(msg({ perUserLimit: 3 }, { total: 2, byUser: 2 })).toBe('OK');
    expect(msg({ perUserLimit: 3 }, { total: 3, byUser: 3 })).toBe(
      'user_limit: Ya usaste este cupón el máximo de veces (3)',
    );
  });

  it('subtotal mínimo: dice cuánto falta, en pesos', () => {
    expect(msg({ minSubtotal: 100_000 })).toBe(
      'below_minimum: Necesitas RD$ 125.25 más para usarlo',
    );
    expect(msg({ minSubtotal: 87_475 })).toBe('OK'); // justo el mínimo sirve
  });

  it('lo que no se puede arreglar se dice antes que lo que sí (agregar productos)', () => {
    expect(msg({ minSubtotal: 1_000_000, endsAt: NOW })).toMatch(/^expired/);
    expect(msg({ minSubtotal: 1_000_000, maxRedemptions: 1 }, { total: 1, byUser: 0 })).toMatch(
      /^exhausted/,
    );
  });

  it('envío gratis: no sirve si el envío ya es gratis; sin zona se acepta', () => {
    const free = { ...base, kind: 'free_delivery' as const, value: 0 };
    const r = (c: { subtotal: number; deliveryFee: number | null }) =>
      assessCoupon(free, c, unused, NOW);
    expect(r({ subtotal: 500_000, deliveryFee: 0 })).toMatchObject({
      ok: false,
      reason: 'no_benefit',
      message: 'Tu envío ya es gratis, no necesitas este cupón',
    });
    expect(r({ subtotal: 87_475, deliveryFee: 15_000 })).toMatchObject({
      ok: true,
      deliveryWaived: 15_000,
    });
    expect(r({ subtotal: 87_475, deliveryFee: null })).toMatchObject({
      ok: true,
      deliveryWaived: 0,
    });
  });

  it('un descuento que quedaría en cero no se acepta', () => {
    expect(msg({ kind: 'percent', value: 1 }, unused, { subtotal: 5_000, deliveryFee: 0 })).toMatch(
      /^no_benefit/,
    );
  });
});

describe('freno a quien adivina códigos', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('bloquea al llegar a 10 códigos distintos y avisa cuánto falta', () => {
    const l = new CouponAttemptLimiter();
    for (let i = 0; i < 9; i++) l.recordMiss('u1', `NOEXISTE${i}`, at(i * 1000));
    expect(l.check('u1', at(10_000)).blocked).toBe(false);
    l.recordMiss('u1', 'NOEXISTE9', at(9_000));
    const gate = l.check('u1', at(10_000));
    expect(gate.blocked).toBe(true);
    // el más viejo (t=0) sale de la ventana a la hora exacta
    expect(gate.retryAfterMs).toBe(60 * 60_000 - 10_000);
  });

  it('repetir el mismo código inválido no gasta intentos', () => {
    const l = new CouponAttemptLimiter();
    for (let i = 0; i < 50; i++) l.recordMiss('u1', 'MISMO', at(i));
    expect(l.check('u1', at(100)).blocked).toBe(false);
  });

  it('pasada la hora se libera', () => {
    const l = new CouponAttemptLimiter();
    for (let i = 0; i < 10; i++) l.recordMiss('u1', `X${i}`, at(0));
    expect(l.check('u1', at(60 * 60_000 - 1)).blocked).toBe(true);
    expect(l.check('u1', at(60 * 60_000)).blocked).toBe(false);
  });

  it('cada persona tiene su propio contador', () => {
    const l = new CouponAttemptLimiter();
    for (let i = 0; i < 10; i++) l.recordMiss('u1', `X${i}`, at(0));
    expect(l.check('u1', at(1)).blocked).toBe(true);
    expect(l.check('u2', at(1)).blocked).toBe(false);
  });
});

// ───────────────────────── cotización ─────────────────────────

describe('cotización con cupón', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  it('sin cupón la cotización trae coupon: null y sin error', async () => {
    const q = await quote(w, POL5, undefined);
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBeNull();
    expect(q.discount).toBe(0);
  });

  it('porcentaje: descuenta productos, no el envío, y reparte el descuento por línea', async () => {
    const c = await mkCoupon(w, { description: '10 % para empezar' });
    const q = await quote(w, POL5, c.code);
    expect(q.coupon).toEqual({
      code: c.code,
      kind: 'percent',
      discount: 8_747,
      description: '10 % para empezar',
    });
    expect(q.couponError).toBeNull();
    expect(q.subtotal).toBe(87_475);
    expect(q.discount).toBe(8_747);
    expect(q.deliveryFee).toBe(15_000);
    expect(q.total).toBe(87_475 - 8_747 + 15_000);
    expect(q.lines[0]).toMatchObject({ gross: 87_475, discount: 8_747, net: 78_728 });
  });

  it('sin descripción propia el texto sale del tipo de cupón', async () => {
    const pct = await quote(
      w,
      POL5,
      (await mkCoupon(w, { value: 1250, maxDiscount: 50_000 })).code,
    );
    expect(pct.coupon!.description).toBe('12.5 % de descuento (hasta RD$ 500.00)');
    const fixed = await quote(w, POL5, (await mkCoupon(w, { kind: 'fixed', value: 20_000 })).code);
    expect(fixed.coupon!.description).toBe('RD$ 200.00 de descuento');
    const free = await quote(
      w,
      POL5,
      (await mkCoupon(w, { kind: 'free_delivery', value: 0 })).code,
    );
    expect(free.coupon!.description).toBe('Envío gratis');
  });

  it('normaliza lo que escribe el cliente', async () => {
    const c = await mkCoupon(w, { code: 'VERANO-10' });
    const q = await quote(w, POL5, '  verano -10 ');
    expect(q.coupon?.code).toBe(c.code);
  });

  it('monto fijo: resta lo pactado', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 20_000 });
    const q = await quote(w, POL5, c.code);
    expect(q.discount).toBe(20_000);
    expect(q.total).toBe(87_475 - 20_000 + 15_000);
    expect(q.coupon).toMatchObject({ kind: 'fixed', discount: 20_000 });
  });

  it('el descuento nunca supera el subtotal ni deja el total negativo', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 5_000_000 });
    const q = await quote(w, POL5, c.code);
    expect(q.discount).toBe(87_475);
    expect(q.total).toBe(15_000); // solo queda el envío
    expect(q.lines[0]!.net).toBe(0);
    expect(q.itbis).toBe(0);
  });

  it('el tope de descuento limita al porcentaje', async () => {
    const c = await mkCoupon(w, { value: 5000, maxDiscount: 10_000 });
    const q = await quote(w, POL5, c.code);
    expect(q.discount).toBe(10_000);
  });

  it('envío gratis: el envío queda en 0, los productos intactos y el ahorro es el envío', async () => {
    const c = await mkCoupon(w, { kind: 'free_delivery', value: 0 });
    const q = await quote(w, POL5, c.code);
    expect(q.discount).toBe(0);
    expect(q.deliveryFee).toBe(0);
    expect(q.total).toBe(87_475);
    expect(q.freeDelivery).toBe(true);
    expect(q.missingForFreeDelivery).toBeNull();
    expect(q.coupon).toMatchObject({ kind: 'free_delivery', discount: 15_000 });
  });

  it('envío gratis sin dirección todavía: se acepta y ahorra 0 hasta conocer la zona', async () => {
    const c = await mkCoupon(w, { kind: 'free_delivery', value: 0 });
    const q = await quote(w, POL5, c.code, { withZone: false });
    expect(q.couponError).toBeNull();
    expect(q.coupon).toMatchObject({ kind: 'free_delivery', discount: 0 });
  });

  it('envío gratis cuando el envío ya es gratis: avisa y no gasta el cupón', async () => {
    const c = await mkCoupon(w, { kind: 'free_delivery', value: 0 });
    const q = await quote(w, [{ sku: 'CMB-1', quantity: 2 }], c.code); // RD$ 4,900 > umbral
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBe('Tu envío ya es gratis, no necesitas este cupón');
  });

  it('el envío gratis por monto se mide sobre el subtotal ANTES del descuento', async () => {
    const c = await mkCoupon(w, { value: 5000 }); // 50 %
    const q = await quote(w, [{ sku: 'CMB-1', quantity: 2 }], c.code);
    expect(q.subtotal).toBe(490_000);
    expect(q.deliveryFee).toBe(0);
    expect(q.total).toBe(245_000);
  });

  it('código inexistente: NO falla, vuelve sin descuento y explica en español', async () => {
    const base = await quote(w, POL5, undefined);
    const q = await quote(w, POL5, 'NOEXISTE');
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBe('No encontramos ese cupón. Revisa que esté bien escrito');
    expect(q.total).toBe(base.total);
    expect(q.discount).toBe(0);
  });

  it('formato imposible (símbolos): igual responde sin fallar', async () => {
    const q = await quote(w, POL5, '¿¿??!!');
    expect(q.coupon).toBeNull();
    expect(q.couponError).toMatch(/No encontramos/);
  });

  it('cupón vencido, por empezar, agotado y ya usado: cada uno con su mensaje', async () => {
    const expired = await mkCoupon(w, { endsAt: new Date(NOW.getTime() - 60_000) });
    expect((await quote(w, POL5, expired.code)).couponError).toBe('Este cupón venció');

    const later = await mkCoupon(w, { startsAt: new Date('2026-10-12T05:00:00Z') });
    expect((await quote(w, POL5, later.code)).couponError).toBe(
      'Este cupón estará disponible desde el 12 de octubre',
    );

    const once = await mkCoupon(w, { maxRedemptions: 1 });
    await place(w, POL5, { couponCode: once.code });
    const other = await newCustomer(w);
    expect((await quote(w, POL5, once.code, { userId: other })).couponError).toBe(
      'Este cupón ya se agotó',
    );
    expect((await quote(w, POL5, once.code)).couponError).toBe('Este cupón ya se agotó');

    const mine = await mkCoupon(w);
    await place(w, POL5, { couponCode: mine.code });
    expect((await quote(w, POL5, mine.code)).couponError).toBe('Ya usaste este cupón');
  });

  it('subtotal mínimo: "Necesitas RD$ X más para usarlo"', async () => {
    const c = await mkCoupon(w, { minSubtotal: 200_000 });
    const q = await quote(w, POL5, c.code);
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBe('Necesitas RD$ 1,125.25 más para usarlo');
  });

  it('un cupón desactivado se ve igual que uno inexistente', async () => {
    const c = await mkCoupon(w, { active: false });
    const q = await quote(w, POL5, c.code);
    expect(q.couponError).toBe('No encontramos ese cupón. Revisa que esté bien escrito');
  });

  it('sin sesión no se valida: pide iniciar sesión (y no consulta la base)', async () => {
    const c = await mkCoupon(w);
    const q = await quote(w, POL5, c.code, { userId: null });
    expect(q.coupon).toBeNull();
    expect(q.couponError).toBe('Inicia sesión para usar un cupón');
  });

  it('un cupón del 100 % no puede dejar el pedido en RD$ 0 cuando la zona ya se conoce', async () => {
    const c = await mkCoupon(w, { value: 10_000 });
    // envío gratis por monto: el 100 % dejaría el total en cero
    const free = await quote(w, [{ sku: 'CMB-1', quantity: 2 }], c.code);
    expect(free.coupon).toBeNull();
    expect(free.couponError).toBe(
      'Este cupón cubre todo el pedido. Agrega más productos para poder pagar',
    );
    expect(free.total).toBe(490_000);
    // con envío de pago el total es el envío
    const paid = await quote(w, POL5, c.code);
    expect(paid.coupon).not.toBeNull();
    expect(paid.total).toBe(15_000);
  });

  it('la pre-autorización cubre el peso variable sobre el monto bruto, no sobre el neto', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 20_000 });
    const q = await quote(w, POL5, c.code);
    // 10 % de los 874.75 brutos (no de los 674.75 netos)
    expect(q.authorizedAmount).toBe(q.total + Math.ceil(87_475 * 0.1));
    const sin = await quote(w, POL5, undefined);
    expect(sin.authorizedAmount).toBe(sin.total + Math.ceil(87_475 * 0.1));
  });
});

// ───────────────────────── descuento e ITBIS ─────────────────────────

describe('descuento con ITBIS mixto (0 % y 18 %)', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  it('sin cupón: el ITBIS solo está en el combo', async () => {
    const q = await quote(w, MIXED, undefined);
    expect(q.subtotal).toBe(279_990);
    expect(q.itbis).toBe(37_373);
  });

  it('10 %: reparte proporcional y el ITBIS baja solo en la línea gravada', async () => {
    const c = await mkCoupon(w);
    const q = await quote(w, MIXED, c.code);
    const [pol, cmb] = [
      q.lines.find((l) => l.sku === 'POL-1')!,
      q.lines.find((l) => l.sku === 'CMB-1')!,
    ];
    expect(q.discount).toBe(27_999);
    expect([pol.discount, cmb.discount]).toEqual([3_499, 24_500]);
    expect([pol.net, cmb.net]).toEqual([31_491, 220_500]);
    expect([pol.itbis, cmb.itbis]).toEqual([0, 33_636]); // 220,500 × 18 / 118
    expect(q.itbis).toBe(33_636);
    expect(q.total).toBe(279_990 - 27_999 + 15_000); // RD$ 2,799.90 sigue bajo el umbral de envío gratis
  });

  it('un monto que no divide parejo suma EXACTO gracias al mayor resto', async () => {
    // RD$ 100.01 sobre 34,990 y 245,000: 1,249.8 y 8,751.2 → el centavo sobrante va a la línea con mayor resto
    const c = await mkCoupon(w, { kind: 'fixed', value: 10_001 });
    const q = await quote(w, MIXED, c.code);
    const discounts = q.lines.map((l) => l.discount);
    expect(discounts.reduce((a, b) => a + b, 0)).toBe(10_001);
    expect(discounts).toEqual(q.lines.map((l) => (l.sku === 'POL-1' ? 1_250 : 8_751)));
    expect(q.itbis).toBe(36_038);
    expect(q.total).toBe(279_990 - 10_001 + 15_000);
  });

  it('propiedad: para muchos descuentos la suma es exacta y ninguna línea queda negativa', async () => {
    const lines = [
      {
        id: 'a',
        pricingUnit: 'lb' as const,
        unitPrice: 17_495,
        itbisBps: 0,
        quantity: 350,
        variableWeight: true,
      },
      {
        id: 'b',
        pricingUnit: 'unit' as const,
        unitPrice: 245_000,
        itbisBps: 1800,
        quantity: 3,
        variableWeight: false,
      },
      {
        id: 'c',
        pricingUnit: 'lb' as const,
        unitPrice: 87_995,
        itbisBps: 1800,
        quantity: 150,
        variableWeight: true,
      },
    ];
    const subtotal = computeOrderTotals(lines).subtotal;
    for (let d = 0; d <= subtotal; d += Math.max(1, Math.floor(subtotal / 997))) {
      const t = computeOrderTotals(lines, { discount: d, deliveryFee: 15_000 });
      expect(t.discount).toBe(d);
      expect(t.lines.reduce((a, l) => a + l.discount, 0)).toBe(d);
      expect(t.lines.every((l) => l.net >= 0 && l.discount <= l.gross)).toBe(true);
      expect(t.total).toBe(subtotal - d + 15_000);
      expect(t.total).toBeGreaterThanOrEqual(0);
    }
    // más que el subtotal: se limita, no se vuelve negativo
    const over = computeOrderTotals(lines, { discount: subtotal * 3, deliveryFee: 0 });
    expect(over.discount).toBe(subtotal);
    expect(over.total).toBe(0);
  });
});

// ───────────────────────── crear pedido ─────────────────────────

describe('crear pedido con cupón', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  it('guarda cupón y descuento, y registra la redención', async () => {
    const c = await mkCoupon(w);
    const order = await place(w, POL5, { couponCode: ` ${c.code.toLowerCase()} ` });
    expect(order.couponCode).toBe(c.code);
    expect(order.subtotal).toBe(87_475);
    expect(order.discount).toBe(8_747);
    expect(order.total).toBe(87_475 - 8_747 + 15_000);
    expect(order.items[0]!.lineTotal).toBe(78_728); // neto de descuento

    const rows = await redemptionsOf(w, c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: w.customerId,
      orderId: order.id,
      amount: 8_747,
    });
  });

  it('el pedido de la lista y el detalle traen el cupón', async () => {
    const c = await mkCoupon(w);
    const order = await place(w, POL5, { couponCode: c.code });
    expect((await getOrder(w.ctx, order.id, { userId: w.customerId })).couponCode).toBe(c.code);
  });

  it('un pedido sin cupón queda con couponCode null', async () => {
    const order = await place(w, POL5);
    expect(order.couponCode).toBeNull();
    expect(order.discount).toBe(0);
  });

  it('envío gratis: el pedido no cobra envío, discount queda en 0 y la redención guarda el envío perdonado', async () => {
    const c = await mkCoupon(w, { kind: 'free_delivery', value: 0 });
    const order = await place(w, POL5, { couponCode: c.code });
    expect(order.deliveryFee).toBe(0);
    expect(order.discount).toBe(0);
    expect(order.total).toBe(87_475);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(15_000);
  });

  it('con ITBIS mixto, el ITBIS guardado ya refleja el descuento', async () => {
    const c = await mkCoupon(w);
    const order = await place(w, MIXED, { couponCode: c.code });
    expect(order.itbis).toBe(33_636);
    expect(order.total).toBe(279_990 - 27_999 + 15_000);
  });

  it('un cupón inválido RECHAZA el pedido (no se crea sin avisar) y no deja nada a medias', async () => {
    const before = await w.handle.db.select().from(orders);
    const reservedBefore = (await w.variant('POL-1')).reserved;
    await expectReject(place(w, POL5, { couponCode: 'NOEXISTE' }), 'coupon_invalid', 'not_found');
    const expired = await mkCoupon(w, { endsAt: new Date(NOW.getTime() - 1) });
    await expectReject(place(w, POL5, { couponCode: expired.code }), 'coupon_invalid', 'expired');
    const min = await mkCoupon(w, { minSubtotal: 500_000 });
    await expect(place(w, POL5, { couponCode: min.code })).rejects.toThrow(
      'Necesitas RD$ 4,125.25 más para usarlo',
    );
    expect(await w.handle.db.select().from(orders)).toHaveLength(before.length);
    expect((await w.variant('POL-1')).reserved).toBe(reservedBefore);
    expect(await redemptionsOf(w, expired.id)).toHaveLength(0);
  });

  it('el rechazo trae estado 409 y el motivo para que la app lo muestre', async () => {
    const c = await mkCoupon(w, { endsAt: new Date(NOW.getTime() - 1) });
    await expect(place(w, POL5, { couponCode: c.code })).rejects.toMatchObject({
      status: 409,
      message: 'Este cupón venció',
      details: { reason: 'expired' },
    });
  });

  it('un cupón del 100 % que dejaría el pedido en cero se rechaza', async () => {
    const c = await mkCoupon(w, { value: 10_000 });
    await expectReject(
      place(w, [{ sku: 'CMB-1', quantity: 2 }], { couponCode: c.code }),
      'coupon_invalid',
      'covers_all',
    );
    // con envío de pago sí: el cliente paga el envío
    const ok = await place(w, POL5, { couponCode: c.code });
    expect(ok.total).toBe(15_000);
    expect(ok.discount).toBe(87_475);
  });

  it('límite por persona: el segundo pedido con el mismo cupón se rechaza', async () => {
    const c = await mkCoupon(w);
    await place(w, POL5, { couponCode: c.code });
    await expect(place(w, POL5, { couponCode: c.code })).rejects.toMatchObject({
      code: 'coupon_invalid',
      message: 'Ya usaste este cupón',
    });
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('perUserLimit = 2 deja usarlo dos veces y no tres', async () => {
    const c = await mkCoupon(w, { perUserLimit: 2 });
    await place(w, POL5, { couponCode: c.code });
    await place(w, POL5, { couponCode: c.code });
    await expectReject(place(w, POL5, { couponCode: c.code }), 'coupon_invalid', 'user_limit');
  });

  it('límite global: lo usan personas distintas hasta agotarlo', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 2 });
    const [a, b, d] = [await newCustomer(w), await newCustomer(w), await newCustomer(w)];
    await place(w, POL5, { userId: a, couponCode: c.code });
    await place(w, POL5, { userId: b, couponCode: c.code });
    await expectReject(
      place(w, POL5, { userId: d, couponCode: c.code }),
      'coupon_invalid',
      'exhausted',
    );
    expect(await redemptionsOf(w, c.id)).toHaveLength(2);
  });

  it('un cupón de otra persona no cuenta en mi límite', async () => {
    const c = await mkCoupon(w);
    await place(w, POL5, { userId: await newCustomer(w), couponCode: c.code });
    const mine = await place(w, POL5, { couponCode: c.code });
    expect(mine.couponCode).toBe(c.code);
  });

  it('reintento con la misma Idempotency-Key no gasta el cupón dos veces', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 1 });
    const key = 'reintento-cupon-0001';
    const first = await place(w, POL5, { couponCode: c.code, idempotencyKey: key });
    const again = await place(w, POL5, { couponCode: c.code, idempotencyKey: key });
    expect(again.id).toBe(first.id);
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('las ventanas son exactas: startsAt = ahora sirve; endsAt = ahora ya venció', async () => {
    const starting = await mkCoupon(w, { startsAt: NOW });
    expect((await place(w, POL5, { couponCode: starting.code })).couponCode).toBe(starting.code);
    const ending = await mkCoupon(w, { endsAt: NOW });
    await expectReject(place(w, POL5, { couponCode: ending.code }), 'coupon_invalid', 'expired');
  });

  it('el pedido mínimo de la zona sigue midiéndose antes del cupón', async () => {
    const c = await mkCoupon(w, { value: 5000 });
    // 5 lb = 874.75 pasa el mínimo de RD$ 800 aunque el 50 % lo deje en 437.38
    const order = await place(w, POL5, { couponCode: c.code });
    expect(order.subtotal).toBe(87_475);
  });
});

// ───────────────────────── anti-abuso ─────────────────────────

describe('máximo 10 cupones inexistentes por persona y hora', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  const withLimiter = (now: () => Date = () => NOW): OrderContext => ({
    ...w.ctx,
    now,
    couponLimiter: new CouponAttemptLimiter(),
  });

  it('al décimo primero la cotización avisa y ni un cupón válido se prueba', async () => {
    const ctx = withLimiter();
    const user = await newCustomer(w);
    const good = await mkCoupon(w);
    for (let i = 0; i < 10; i++) {
      const q = await quote(w, POL5, `ADIVINO${i}`, { userId: user, ctx });
      expect(q.couponError).toMatch(/No encontramos/);
    }
    const blocked = await quote(w, POL5, `ADIVINO10`, { userId: user, ctx });
    expect(blocked.coupon).toBeNull();
    expect(blocked.couponError).toBe(
      'Probaste demasiados cupones que no existen. Intenta de nuevo en 60 minutos',
    );
    // bloqueado es bloqueado: tampoco deja probar el cupón bueno (si no, seguirían adivinando)
    expect((await quote(w, POL5, good.code, { userId: user, ctx })).couponError).toMatch(
      /demasiados/,
    );
    // otra persona no se ve afectada
    expect((await quote(w, POL5, good.code, { userId: w.customerId, ctx })).coupon).not.toBeNull();
  });

  it('al crear el pedido el bloqueo es un 429', async () => {
    const ctx = withLimiter();
    const user = await newCustomer(w);
    for (let i = 0; i < 10; i++) {
      await quote(w, POL5, `ADIVINO${i}`, { userId: user, ctx });
    }
    await expect(
      place(w, POL5, { userId: user, couponCode: 'ADIVINO99' }, ctx),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      status: 429,
    });
  });

  it('se libera pasada la hora', async () => {
    let t = NOW.getTime();
    const ctx = withLimiter(() => new Date(t));
    const user = await newCustomer(w);
    const good = await mkCoupon(w);
    for (let i = 0; i < 10; i++) await quote(w, POL5, `ADIVINO${i}`, { userId: user, ctx });
    expect((await quote(w, POL5, good.code, { userId: user, ctx })).couponError).toMatch(
      /demasiados/,
    );
    t += 61 * 60_000;
    expect((await quote(w, POL5, good.code, { userId: user, ctx })).coupon).not.toBeNull();
  });

  it('probar cupones desactivados también cuenta: para la persona no existen', async () => {
    const ctx = withLimiter();
    const user = await newCustomer(w);
    for (let i = 0; i < 10; i++) {
      const off = await mkCoupon(w, { active: false });
      const q = await quote(w, POL5, off.code, { userId: user, ctx });
      expect(q.couponError).toMatch(/No encontramos/);
    }
    const good = await mkCoupon(w);
    const q = await quote(w, POL5, good.code, { userId: user, ctx });
    expect(q.couponError).toMatch(/demasiados cupones/);
  });

  it('un cupón vencido o con mínimo sin cumplir NO cuenta como adivinar', async () => {
    const ctx = withLimiter();
    const user = await newCustomer(w);
    const expired = await mkCoupon(w, { endsAt: new Date(NOW.getTime() - 1) });
    const min = await mkCoupon(w, { minSubtotal: 9_000_000 });
    for (let i = 0; i < 25; i++) {
      await quote(w, POL5, expired.code, { userId: user, ctx });
      await quote(w, POL5, min.code, { userId: user, ctx });
    }
    const good = await mkCoupon(w);
    expect((await quote(w, POL5, good.code, { userId: user, ctx })).coupon).not.toBeNull();
  });
});

// ───────────────────────── liberar al cancelar o vencer ─────────────────────────

describe('la redención se libera cuando el pedido no se concreta', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  const customer = (id: string) => ({ id, role: 'customer' as const });
  const admin = (w: World) => ({ id: w.adminId, role: 'admin' as const });

  it('cancelar libera el uso por persona y el global', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 1 });
    const order = await place(w, POL5, { couponCode: c.code });
    await expectReject(place(w, POL5, { couponCode: c.code }), 'coupon_invalid', 'exhausted');

    const cancelled = await transitionOrder(
      w.ctx,
      order.id,
      'cancelled',
      customer(w.customerId),
      'Me equivoqué',
    );
    expect(cancelled.status).toBe('cancelled');
    expect(await redemptionsOf(w, c.id)).toHaveLength(0);
    // el pedido cancelado conserva el cupón como historia
    expect(cancelled.couponCode).toBe(c.code);
    expect(cancelled.discount).toBe(8_747);

    // y el cupón vuelve a servir, a la misma persona
    const again = await place(w, POL5, { couponCode: c.code });
    expect(again.couponCode).toBe(c.code);
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('un pedido de tarjeta que vence sin pagar también libera el uso', async () => {
    const c = await mkCoupon(w);
    const order = await place(w, POL5, { couponCode: c.code, paymentMethod: 'card' });
    expect(order.status).toBe('pending_payment');
    // mientras espera el pago, el uso está tomado
    await expectReject(place(w, POL5, { couponCode: c.code }), 'coupon_invalid', 'user_limit');

    const later = { ...w.ctx, now: () => new Date(NOW.getTime() + 16 * 60_000) };
    expect(await expireStaleOrders(later)).toBeGreaterThanOrEqual(1);
    expect((await getOrder(w.ctx, order.id)).status).toBe('cancelled');
    expect(await redemptionsOf(w, c.id)).toHaveLength(0);
    expect((await place(w, POL5, { couponCode: c.code })).couponCode).toBe(c.code);
  });

  it('cancelar un pedido ya empacado (con peso real) también libera el uso', async () => {
    const c = await mkCoupon(w);
    let order = await place(w, POL5, { couponCode: c.code });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    order = await recordWeights(w.ctx, order.id, [
      { itemId: order.items[0]!.id, finalQuantity: 510 },
    ]);
    await transitionOrder(w.ctx, order.id, 'packed', admin(w));
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
    await transitionOrder(w.ctx, order.id, 'cancelled', admin(w), 'Cliente no contesta');
    expect(await redemptionsOf(w, c.id)).toHaveLength(0);
  });

  it('un pedido que sigue su curso conserva la redención hasta la entrega', async () => {
    const c = await mkCoupon(w);
    const order = await place(w, POL5, { couponCode: c.code });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('cancelar un pedido sin cupón no toca las redenciones de otros', async () => {
    const c = await mkCoupon(w);
    await place(w, POL5, { couponCode: c.code });
    const plain = await place(w, POL5, { userId: await newCustomer(w) });
    await transitionOrder(w.ctx, plain.id, 'cancelled', admin(w));
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });
});

// ───────────────────────── concurrencia ─────────────────────────

describe('concurrencia: los límites se respetan con pedidos simultáneos', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  // La pausa dentro de la transacción ensancha la ventana de la carrera: sin el bloqueo de la fila
  // del cupón, con un Postgres real ambos pedidos leerían "0 usos" y los dos ganarían.
  const racing = (): OrderContext => ({
    ...w.ctx,
    hooks: {
      afterCreate: async () => {
        await sleep(60);
      },
    },
  });

  const outcome = (settled: PromiseSettledResult<unknown>[]) => ({
    won: settled.filter((s) => s.status === 'fulfilled').length,
    reasons: settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map(
        (s) =>
          (s.reason as { details?: { reason?: string }; code?: string }).details?.reason ??
          s.reason,
      ),
  });

  // Cada pedido va a una franja DISTINTA: el pedido ya serializa por franja (advisory lock) y con
  // la misma franja no se estaría probando el bloqueo del cupón sino ese otro.
  let slots: Date[];
  beforeAll(async () => {
    slots = (await listSlots(w.handle.db, w.config, NOW)).map((s) => s.start);
  });

  const placeAt = (i: number, userId: string, code: string | undefined) =>
    place(w, POL5, { userId, couponCode: code, slotStart: slots[i]! }, racing());

  it('1 solo uso y dos pedidos a la vez de personas distintas: gana exactamente uno', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 1 });
    const [a, b] = [await newCustomer(w), await newCustomer(w)];
    const settled = await Promise.allSettled([placeAt(0, a, c.code), placeAt(1, b, c.code)]);
    const r = outcome(settled);
    expect(r.won).toBe(1);
    expect(r.reasons).toEqual(['exhausted']);
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
    // el que perdió no dejó pedido a medias
    const created = await w.handle.db
      .select()
      .from(orders)
      .where(inArray(orders.userId, [a, b]));
    expect(created).toHaveLength(1);
  });

  it('perUserLimit 1 y la misma persona lanza dos pedidos a la vez: gana exactamente uno', async () => {
    const c = await mkCoupon(w);
    const user = await newCustomer(w);
    const settled = await Promise.allSettled([placeAt(0, user, c.code), placeAt(1, user, c.code)]);
    const r = outcome(settled);
    expect(r.won).toBe(1);
    expect(r.reasons).toEqual(['user_limit']);
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('seis pedidos a la vez y 2 usos: exactamente dos ganan', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 2 });
    const users6 = await Promise.all(Array.from({ length: 6 }, () => newCustomer(w)));
    const settled = await Promise.allSettled(users6.map((u, i) => placeAt(i, u, c.code)));
    const r = outcome(settled);
    expect(r.won).toBe(2);
    expect(r.reasons).toEqual(['exhausted', 'exhausted', 'exhausted', 'exhausted']);
    expect(await redemptionsOf(w, c.id)).toHaveLength(2);
  });

  it('un pedido sin cupón no hace cola con los del cupón', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 1 });
    const settled = await Promise.allSettled([
      placeAt(0, await newCustomer(w), c.code),
      placeAt(1, await newCustomer(w), undefined),
    ]);
    expect(outcome(settled).won).toBe(2);
  });

  it('dos reintentos simultáneos con la misma Idempotency-Key y cupón devuelven el MISMO pedido', async () => {
    const c = await mkCoupon(w);
    const user = await newCustomer(w);
    const retry = () =>
      place(
        w,
        POL5,
        { userId: user, couponCode: c.code, idempotencyKey: `reintento-doble-${c.code}` },
        racing(),
      );
    const [a, b] = await Promise.all([retry(), retry()]);
    expect(b.id).toBe(a.id);
    expect(await redemptionsOf(w, c.id)).toHaveLength(1);
  });

  it('dos reintentos simultáneos con la misma Idempotency-Key SIN cupón también devuelven el mismo pedido', async () => {
    const user = await newCustomer(w);
    const retry = () =>
      place(w, POL5, { userId: user, idempotencyKey: `reintento-sin-cupon-${seq}` }, racing());
    const [a, b] = await Promise.all([retry(), retry()]);
    expect(b.id).toBe(a.id);
  });

  it('editar el cupón mientras se crea un pedido espera al pedido: no cambia el valor ya cobrado', async () => {
    const c = await mkCoupon(w); // 10 %
    let enterWindow!: () => void;
    const inWindow = new Promise<void>((r) => (enterWindow = r));
    // el pedido ya tiene el cupón bloqueado y la redención insertada, pero aún no confirma
    const slowOrder = place(
      w,
      POL5,
      { couponCode: c.code, slotStart: slots[0]! },
      {
        ...w.ctx,
        hooks: {
          afterCreate: async () => {
            enterWindow();
            await sleep(200);
          },
        },
      },
    );
    const edit = inWindow.then(() => updateCoupon(w.handle.db, c.id, { value: 2000 }));
    const [order, patch] = await Promise.allSettled([slowOrder, edit]);

    expect(order.status).toBe('fulfilled');
    // el pedido se cobró al 10 %; por eso la edición ya no puede cambiar el valor
    expect((order as PromiseFulfilledResult<{ discount: number }>).value.discount).toBe(8_747);
    expect(patch.status).toBe('rejected');
    expect((patch as PromiseRejectedResult).reason).toMatchObject({ code: 'coupon_locked' });
    const [row] = await w.handle.db.select().from(coupons).where(eq(coupons.id, c.id));
    expect(row!.value).toBe(1000);
  });

  it('cancelar y pedir a la vez no se pasa del límite: el cupón liberado lo toma un solo pedido', async () => {
    const c = await mkCoupon(w, { maxRedemptions: 1 });
    const first = await place(w, POL5, { couponCode: c.code });
    const [a, b] = [await newCustomer(w), await newCustomer(w)];
    const settled = await Promise.allSettled([
      transitionOrder(w.ctx, first.id, 'cancelled', { id: w.customerId, role: 'customer' }),
      placeAt(0, a, c.code),
      placeAt(1, b, c.code),
    ]);
    // la cancelación siempre gana; de los dos pedidos nuevos, a lo sumo uno se queda con el cupón
    expect(settled[0]!.status).toBe('fulfilled');
    expect((await redemptionsOf(w, c.id)).length).toBeLessThanOrEqual(1);
  });
});

// ───────────────────────── peso real ─────────────────────────

describe('pesar y empacar con cupón', () => {
  let w: World;
  beforeAll(async () => (w = await setup()));
  afterAll(() => w.close());

  const admin = (w: World) => ({ id: w.adminId, role: 'admin' as const });

  async function pack(code: string, centilb: number) {
    let order = await place(w, POL5, { couponCode: code });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    order = await recordWeights(w.ctx, order.id, [
      { itemId: order.items[0]!.id, finalQuantity: centilb },
    ]);
    order = await transitionOrder(w.ctx, order.id, 'packed', admin(w));
    return order;
  }

  it('porcentaje: se recalcula sobre el monto real', async () => {
    const c = await mkCoupon(w); // 10 %
    const order = await pack(c.code, 523); // 5.23 lb → 91,499
    expect(order.total).toBe(87_475 - 8_747 + 15_000); // lo estimado se conserva
    expect(order.discount).toBe(8_747);
    // 10 % de 91,499 = 9,149 (abajo)
    expect(order.finalTotal).toBe(91_499 - 9_149 + 15_000);
    expect(order.items[0]!.finalLineTotal).toBe(91_499 - 9_149);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(9_149);
  });

  it('porcentaje con tope: el tope sigue mandando con el peso real', async () => {
    const c = await mkCoupon(w, { value: 5000, maxDiscount: 10_000 });
    const order = await pack(c.code, 523);
    expect(order.finalTotal).toBe(91_499 - 10_000 + 15_000);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(10_000);
  });

  it('monto fijo: se mantiene lo pactado aunque el peso cambie', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 10_000 });
    const lighter = await pack(c.code, 450); // 4.5 lb → 78,728
    expect(lighter.finalTotal).toBe(78_728 - 10_000 + 15_000);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(10_000);
  });

  it('monto fijo y el peso sube 10 %: el colchón de pre-autorización alcanza', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 10_000 });
    // 5.5 lb = 96,223 brutos → 101,223 con envío = exactamente lo autorizado (92,475 + 8,748)
    const order = await pack(c.code, 550);
    expect(order.authorizedAmount).toBe(101_223);
    expect(order.finalTotal).toBe(101_223);
    expect(order.status).toBe('packed');
  });

  it('monto fijo mayor que el monto real: el descuento se limita al monto, nunca negativo', async () => {
    const c = await mkCoupon(w, { kind: 'fixed', value: 87_000 });
    // pedido: 87,475 - 87,000 = 475 + 15,000; pesado a 2.5 lb = 43,738 brutos < 87,000
    const order = await pack(c.code, 250);
    expect(order.finalTotal).toBe(15_000);
    expect(order.finalTotal!).toBeGreaterThanOrEqual(0);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(43_738);
  });

  it('envío gratis: al pesar el envío sigue en 0 y no hay descuento de productos', async () => {
    const c = await mkCoupon(w, { kind: 'free_delivery', value: 0 });
    const order = await pack(c.code, 523);
    expect(order.deliveryFee).toBe(0);
    expect(order.finalTotal).toBe(91_499);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(15_000); // el envío perdonado, intacto
  });

  it('con ITBIS mixto el ITBIS final refleja el descuento recalculado', async () => {
    const c = await mkCoupon(w);
    let order = await place(w, MIXED, { couponCode: c.code });
    await transitionOrder(w.ctx, order.id, 'picking', admin(w));
    const pol = order.items.find((i) => i.sku === 'POL-1')!;
    order = await recordWeights(w.ctx, order.id, [{ itemId: pol.id, finalQuantity: 210 }]); // 2.1 lb
    order = await transitionOrder(w.ctx, order.id, 'packed', admin(w));
    // bruto real: 2.1 lb × 174.95 = 367.40 + combo 2,450.00 = 2,817.40; el 10 % es 281.74
    // reparto: 36.74 en la pechuga (0 %) y 245.00 menos 24.50 = 2,205.00 en el combo (18 %)
    expect(order.discount).toBe(27_999); // lo pactado al pedir no se reescribe
    expect(order.finalItbis).toBe(33_636); // 220,500 × 18 / 118
    expect(order.finalTotal).toBe(281_740 - 28_174 + 15_000);
    expect((await redemptionsOf(w, c.id))[0]!.amount).toBe(28_174);
  });
});

// ───────────────────────── HTTP ─────────────────────────

describe('API HTTP de cupones', () => {
  let w: World;
  let app: FastifyInstance;
  let auth: Awaited<ReturnType<typeof makeApp>>['auth'];
  let customer: Record<string, string>;
  let admin: Record<string, string>;
  let staff: Record<string, string>;
  let driver: Record<string, string>;
  let staffId: string;

  beforeAll(async () => {
    w = await setup();
    ({ app, auth } = await makeApp(w));
    customer = auth(w.customerId, 'customer');
    admin = auth(w.adminId, 'admin');
    driver = auth(w.driverId, 'driver');
    const [s] = await w.handle.db
      .insert(users)
      .values({ phone: '+18095559999', name: 'Personal', role: 'staff' })
      .returning({ id: users.id });
    staffId = s!.id;
    staff = auth(staffId, 'staff');
  });
  afterAll(async () => {
    await app.close();
    await w.close();
  });

  const create = (payload: Record<string, unknown>, headers = admin) =>
    app.inject({ method: 'POST', url: '/v1/admin/coupons', headers, payload });
  const codeOf = () => `HTTP${++seq}`;

  async function quoteHttp(code: string | undefined, headers: Record<string, string> = customer) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quote',
      headers,
      payload: {
        items: await resolve(w, POL5),
        address: { sector: 'Naco', city: 'Santo Domingo' },
        couponCode: code,
      },
    });
    return res;
  }

  async function orderHttp(code: string | undefined, headers = customer, method = 'cash') {
    return app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers,
      payload: {
        items: await resolve(w, POL5),
        address: ADDRESS,
        slotStart: (await w.firstSlot()).toISOString(),
        paymentMethod: method,
        couponCode: code,
      },
    });
  }

  describe('cotizar y pedir', () => {
    it('cotizar con cupón inválido responde 200, coupon null y couponError', async () => {
      const res = await quoteHttp('NOEXISTE');
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({
        coupon: null,
        couponError: 'No encontramos ese cupón. Revisa que esté bien escrito',
        discount: 0,
        total: 102_475,
      });
    });

    it('cotizar con cupón válido trae el descuento y el DTO del cupón', async () => {
      const code = codeOf();
      expect(
        (await create({ code, kind: 'percent', value: 1000, description: '10 % off' })).statusCode,
      ).toBe(201);
      const res = await quoteHttp(` ${code.toLowerCase()}`);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({
        coupon: { code, kind: 'percent', discount: 8_747, description: '10 % off' },
        couponError: null,
        discount: 8_747,
        total: 93_728,
      });
    });

    it('cotizar sin cupón trae coupon: null', async () => {
      const res = await quoteHttp(undefined, {});
      expect(json(res).coupon).toBeNull();
      expect(json(res).couponError ?? null).toBeNull();
    });

    it('sin sesión (o con token roto) el cupón pide iniciar sesión, sin fallar', async () => {
      const code = codeOf();
      await create({ code, kind: 'percent', value: 1000 });
      for (const headers of [{}, { authorization: 'Bearer token-roto' }] as Record<
        string,
        string
      >[]) {
        const res = await quoteHttp(code, headers);
        expect(res.statusCode).toBe(200);
        expect(json(res)).toMatchObject({
          coupon: null,
          couponError: 'Inicia sesión para usar un cupón',
        });
      }
    });

    it('un código vacío o de solo espacios se trata como "sin cupón"', async () => {
      for (const couponCode of ['', '   ', null]) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/quote',
          headers: customer,
          payload: { items: await resolve(w, POL5), couponCode },
        });
        expect(res.statusCode).toBe(200);
        expect(json(res).couponError ?? null).toBeNull();
      }
    });

    it('crear el pedido con cupón: 201, couponCode, descuento y cobro con el descuento', async () => {
      const code = codeOf();
      await create({ code, kind: 'fixed', value: 20_000 });
      const res = await orderHttp(code);
      expect(res.statusCode, res.body).toBe(201);
      const order = json(res);
      expect(order).toMatchObject({
        couponCode: code,
        discount: 20_000,
        total: 82_475,
        status: 'confirmed',
      });
      // el cobro en efectivo que espera el repartidor ya trae el descuento
      expect(order.payments[0].amount).toBe(82_475);
    });

    it('el pedido con tarjeta cobra el total con descuento', async () => {
      const code = codeOf();
      await create({ code, kind: 'percent', value: 1000 });
      const order = json(await orderHttp(code, customer, 'card'));
      expect(order.total).toBe(93_728);
      const pay = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/pay`,
        headers: customer,
      });
      expect(pay.statusCode, pay.body).toBe(200);
      expect(json(pay).amount).toBe(93_728);
    });

    it('crear el pedido con cupón inválido: 409 coupon_invalid y NO se crea el pedido', async () => {
      const before = (await w.handle.db.select().from(orders)).length;
      const res = await orderHttp('NOEXISTE');
      expect(res.statusCode).toBe(409);
      expect(json(res).error).toMatchObject({
        code: 'coupon_invalid',
        message: 'No encontramos ese cupón. Revisa que esté bien escrito',
        details: { reason: 'not_found' },
      });
      expect((await w.handle.db.select().from(orders)).length).toBe(before);
    });

    it('cupón ya usado: 409 con el motivo', async () => {
      const code = codeOf();
      await create({ code, kind: 'percent', value: 1000 });
      expect((await orderHttp(code)).statusCode).toBe(201);
      const res = await orderHttp(code);
      expect(res.statusCode).toBe(409);
      expect(json(res).error).toMatchObject({
        message: 'Ya usaste este cupón',
        details: { reason: 'user_limit' },
      });
    });

    it('cancelar desde la app libera el cupón y se puede volver a usar', async () => {
      const code = codeOf();
      await create({ code, kind: 'percent', value: 1000 });
      const order = json(await orderHttp(code));
      const cancel = await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/cancel`,
        headers: customer,
        payload: { reason: 'Cambié de opinión' },
      });
      expect(cancel.statusCode).toBe(200);
      expect(json(cancel)).toMatchObject({ status: 'cancelled', couponCode: code });
      expect((await orderHttp(code)).statusCode).toBe(201);
    });

    it('diez códigos inexistentes y el siguiente intento recibe el aviso (cotizar) o 429 (pedir)', async () => {
      const [probador] = await w.handle.db
        .insert(users)
        .values({ phone: '+18095558888', name: 'Probador' })
        .returning({ id: users.id });
      const tester = auth(probador!.id, 'customer');
      for (let i = 0; i < 10; i++) {
        const r = await quoteHttp(`ADIVINO${i}`, tester);
        expect(json(r).couponError).toMatch(/No encontramos/);
      }
      const q = await quoteHttp('ADIVINO10', tester);
      expect(q.statusCode).toBe(200);
      expect(json(q).couponError).toMatch(/demasiados cupones/);
      const o = await orderHttp('ADIVINO11', tester);
      expect(o.statusCode).toBe(429);
      expect(json(o).error).toMatchObject({ code: 'rate_limited' });
    });
  });

  describe('permisos', () => {
    it('sin sesión: 401', async () => {
      expect((await app.inject({ url: '/v1/admin/coupons' })).statusCode).toBe(401);
      expect((await create({ code: 'ABC', kind: 'free_delivery' }, {})).statusCode).toBe(401);
    });

    it('cliente y repartidor: 403 en todo', async () => {
      const code = codeOf();
      const created = json(await create({ code, kind: 'percent', value: 1000 }));
      for (const who of [customer, driver]) {
        expect((await app.inject({ url: '/v1/admin/coupons', headers: who })).statusCode).toBe(403);
        expect((await create({ code: codeOf(), kind: 'free_delivery' }, who)).statusCode).toBe(403);
        expect(
          (
            await app.inject({
              method: 'PATCH',
              url: `/v1/admin/coupons/${created.id}`,
              headers: who,
              payload: { active: false },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (await app.inject({ url: `/v1/admin/coupons/${created.id}/redemptions`, headers: who }))
            .statusCode,
        ).toBe(403);
      }
    });

    it('personal (staff): puede leer, no puede crear ni editar', async () => {
      const code = codeOf();
      const created = json(await create({ code, kind: 'percent', value: 1000 }));
      const list = await app.inject({ url: '/v1/admin/coupons', headers: staff });
      expect(list.statusCode).toBe(200);
      expect(json(list).some((c: { code: string }) => c.code === code)).toBe(true);
      expect(
        (await app.inject({ url: `/v1/admin/coupons/${created.id}/redemptions`, headers: staff }))
          .statusCode,
      ).toBe(200);

      expect((await create({ code: codeOf(), kind: 'free_delivery' }, staff)).statusCode).toBe(403);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/coupons/${created.id}`,
        headers: staff,
        payload: { active: false },
      });
      expect(patch.statusCode).toBe(403);
      // no se tocó
      const after = json(await app.inject({ url: '/v1/admin/coupons', headers: admin })).find(
        (c: { id: string }) => c.id === created.id,
      );
      expect(after.active).toBe(true);
    });

    it('el admin crea y edita', async () => {
      const res = await create({ code: codeOf(), kind: 'free_delivery' });
      expect(res.statusCode).toBe(201);
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/coupons/${json(res).id}`,
        headers: admin,
        payload: { active: false },
      });
      expect(patch.statusCode).toBe(200);
      expect(json(patch).active).toBe(false);
    });
  });

  describe('validación estricta al crear', () => {
    const bad = async (payload: Record<string, unknown>, expected: RegExp) => {
      const res = await create({ code: codeOf(), kind: 'percent', value: 1000, ...payload });
      expect(res.statusCode, res.body).toBe(400);
      expect(json(res).error.code).toBe('validation');
      expect(json(res).error.message).toMatch(expected);
    };

    it('porcentaje: de 1 a 10000 puntos básicos', async () => {
      await bad({ value: 0 }, /value/);
      await bad({ value: 10_001 }, /value/);
      await bad({ value: -5 }, /value/);
      await bad({ value: 12.5 }, /entero/);
      const max = await create({ code: codeOf(), kind: 'percent', value: 10_000 });
      expect(max.statusCode).toBe(201);
      const min = await create({ code: codeOf(), kind: 'percent', value: 1 });
      expect(min.statusCode).toBe(201);
    });

    it('monto fijo: mayor que cero', async () => {
      await bad({ kind: 'fixed', value: 0 }, /value/);
      await bad({ kind: 'fixed', value: -100 }, /value/);
      await bad({ kind: 'fixed', value: undefined }, /value/); // sin valor
      expect((await create({ code: codeOf(), kind: 'fixed', value: 1 })).statusCode).toBe(201);
    });

    it('envío gratis: sin valor ni tope', async () => {
      await bad({ kind: 'free_delivery', value: 500 }, /value/);
      await bad({ kind: 'free_delivery', value: 0, maxDiscount: 1000 }, /maxDiscount/);
      expect((await create({ code: codeOf(), kind: 'free_delivery' })).statusCode).toBe(201);
    });

    it('código: de 3 a 20 caracteres A-Z, 0-9 y guion (se normaliza antes de validar)', async () => {
      await bad({ code: 'AB' }, /code/);
      await bad({ code: 'A'.repeat(21) }, /code/);
      await bad({ code: 'VERANO_2026' }, /code/);
      await bad({ code: 'ÑANDÚ10' }, /code/);
      await bad({ code: 'con!' }, /code/);
      const ok = await create({ code: ' super verano-10 ', kind: 'percent', value: 1000 });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(json(ok).code).toBe('SUPERVERANO-10');
      expect(
        (await create({ code: 'A'.repeat(20), kind: 'percent', value: 1000 })).statusCode,
      ).toBe(201);
      expect((await create({ code: 'ABC', kind: 'percent', value: 1000 })).statusCode).toBe(201);
    });

    it('rechaza campos desconocidos, tipos equivocados y fechas mal formadas', async () => {
      await bad({ maxRedemption: 3 }, /Campo desconocido: maxRedemption/);
      await bad({ value: '10' }, /value/);
      await bad({ active: 'si' }, /active/);
      await bad({ kind: 'bogo' }, /tipo/);
      await bad({ startsAt: 'mañana' }, /startsAt/);
      await bad({ startsAt: '2026-10-15' }, /startsAt/); // sin hora ni zona
      await bad({ perUserLimit: 0 }, /perUserLimit/);
      await bad({ perUserLimit: 1001 }, /perUserLimit/);
      await bad({ kind: 'fixed', value: 3_000_000_000 }, /value/); // no cabe en la columna
      await bad({ maxRedemptions: 0 }, /maxRedemptions/);
      await bad({ minSubtotal: -1 }, /minSubtotal/);
      await bad({ maxDiscount: 0 }, /maxDiscount/);
      await bad({ description: 'x'.repeat(141) }, /descripción/);
    });

    it('la fecha de fin debe ser posterior a la de inicio', async () => {
      await bad({ startsAt: '2026-10-15T04:00:00Z', endsAt: '2026-10-15T04:00:00Z' }, /endsAt/);
      await bad({ startsAt: '2026-10-15T04:00:00Z', endsAt: '2026-10-14T04:00:00Z' }, /endsAt/);
      const ok = await create({
        code: codeOf(),
        kind: 'percent',
        value: 1000,
        startsAt: '2026-10-15T04:00:00Z',
        endsAt: '2026-10-31T03:59:59-04:00',
      });
      expect(ok.statusCode).toBe(201);
      expect(json(ok)).toMatchObject({
        startsAt: '2026-10-15T04:00:00.000Z',
        endsAt: '2026-10-31T07:59:59.000Z',
      });
    });

    it('un código repetido es 409, también si cambian mayúsculas o espacios', async () => {
      const code = codeOf();
      expect((await create({ code, kind: 'percent', value: 1000 })).statusCode).toBe(201);
      for (const dup of [code, code.toLowerCase(), ` ${code} `]) {
        const res = await create({ code: dup, kind: 'fixed', value: 500 });
        expect(res.statusCode).toBe(409);
        expect(json(res).error.code).toBe('coupon_exists');
      }
    });

    it('ocho altas simultáneas del mismo código: una gana y las demás reciben 409 (nunca 500)', async () => {
      const code = codeOf();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => create({ code, kind: 'percent', value: 1000 + i })),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([
        201, 409, 409, 409, 409, 409, 409, 409,
      ]);
    });

    it('trae los valores por defecto', async () => {
      const res = await create({ code: codeOf(), kind: 'percent', value: 1500 });
      expect(json(res)).toMatchObject({
        description: '',
        minSubtotal: 0,
        maxDiscount: null,
        startsAt: null,
        endsAt: null,
        maxRedemptions: null,
        perUserLimit: 1,
        active: true,
        redemptions: 0,
        discountTotal: 0,
        status: 'active',
        termsLocked: false,
      });
    });
  });

  describe('editar', () => {
    const patch = (id: string, payload: Record<string, unknown>, headers = admin) =>
      app.inject({ method: 'PATCH', url: `/v1/admin/coupons/${id}`, headers, payload });

    it('desactivar y reactivar: un cupón pausado no se puede usar', async () => {
      const code = codeOf();
      const { id } = json(await create({ code, kind: 'percent', value: 1000 }));
      expect(json(await patch(id, { active: false })).status).toBe('paused');
      expect(json(await quoteHttp(code)).couponError).toMatch(/No encontramos/);
      expect((await orderHttp(code)).statusCode).toBe(409);
      expect(json(await patch(id, { active: true })).status).toBe('active');
      expect(json(await quoteHttp(code)).coupon.code).toBe(code);
    });

    it('cambiar fechas y límites, y poner null para quitarlos', async () => {
      const { id } = json(
        await create({
          code: codeOf(),
          kind: 'percent',
          value: 1000,
          endsAt: '2026-12-31T00:00:00Z',
          maxRedemptions: 5,
        }),
      );
      const r = await patch(id, {
        endsAt: null,
        maxRedemptions: null,
        perUserLimit: 3,
        minSubtotal: 50_000,
        startsAt: '2026-10-01T00:00:00Z',
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toMatchObject({
        endsAt: null,
        maxRedemptions: null,
        perUserLimit: 3,
        minSubtotal: 50_000,
        startsAt: '2026-10-01T00:00:00.000Z',
      });
    });

    it('el estado refleja fechas y usos: scheduled, expired y exhausted', async () => {
      const future = json(
        await create({
          code: codeOf(),
          kind: 'percent',
          value: 1000,
          startsAt: '2026-11-01T00:00:00Z',
        }),
      );
      expect(future.status).toBe('scheduled');
      const past = json(
        await create({
          code: codeOf(),
          kind: 'percent',
          value: 1000,
          endsAt: '2026-10-01T00:00:00Z',
        }),
      );
      expect(past.status).toBe('expired');
      const code = codeOf();
      const one = json(await create({ code, kind: 'percent', value: 1000, maxRedemptions: 1 }));
      await orderHttp(code);
      const list = json(await app.inject({ url: '/v1/admin/coupons', headers: admin }));
      expect(list.find((c: { id: string }) => c.id === one.id).status).toBe('exhausted');
    });

    it('la edición se valida contra el estado final (fin antes del inicio, tipo vs valor)', async () => {
      const { id } = json(
        await create({
          code: codeOf(),
          kind: 'percent',
          value: 1000,
          startsAt: '2026-10-10T00:00:00Z',
        }),
      );
      expect((await patch(id, { endsAt: '2026-10-09T00:00:00Z' })).statusCode).toBe(400);
      expect((await patch(id, { value: 20_000 })).statusCode).toBe(400);
      expect((await patch(id, { kind: 'free_delivery' })).statusCode).toBe(400); // value 1000 no va con envío gratis
      const ok = await patch(id, { kind: 'free_delivery', value: 0 });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it('sin usos se puede cambiar tipo, valor y tope', async () => {
      const { id } = json(await create({ code: codeOf(), kind: 'percent', value: 1000 }));
      const r = await patch(id, { kind: 'fixed', value: 25_000, maxDiscount: 25_000 });
      expect(r.statusCode, r.body).toBe(200);
      expect(json(r)).toMatchObject({ kind: 'fixed', value: 25_000, maxDiscount: 25_000 });
    });

    it('con usos, tipo, valor y tope quedan congelados (409), pero fechas y límites no', async () => {
      const code = codeOf();
      const { id } = json(await create({ code, kind: 'percent', value: 1000, perUserLimit: 2 }));
      expect((await orderHttp(code)).statusCode).toBe(201);

      for (const body of [{ kind: 'fixed', value: 100 }, { value: 2000 }, { maxDiscount: 500 }]) {
        const res = await patch(id, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(409);
        expect(json(res).error.code).toBe('coupon_locked');
      }
      // mandar el mismo valor no es un cambio
      expect((await patch(id, { kind: 'percent', value: 1000 })).statusCode).toBe(200);
      // fechas, límites, descripción y estado siguen editables
      const ok = await patch(id, {
        endsAt: '2027-01-01T00:00:00Z',
        maxRedemptions: 10,
        perUserLimit: 5,
        minSubtotal: 1000,
        description: 'Nueva',
        active: false,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(json(ok)).toMatchObject({
        termsLocked: true,
        redemptions: 1,
        maxRedemptions: 10,
        perUserLimit: 5,
        description: 'Nueva',
        active: false,
      });
    });

    it('si el único pedido se cancela, los términos se vuelven a poder cambiar', async () => {
      const code = codeOf();
      const { id } = json(await create({ code, kind: 'percent', value: 1000 }));
      const order = json(await orderHttp(code));
      expect((await patch(id, { value: 2000 })).statusCode).toBe(409);
      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/cancel`,
        headers: customer,
        payload: {},
      });
      expect((await patch(id, { value: 2000 })).statusCode).toBe(200);
    });

    it('rechaza cuerpo vacío, el código y campos desconocidos; 404 si no existe', async () => {
      const { id } = json(await create({ code: codeOf(), kind: 'percent', value: 1000 }));
      expect((await patch(id, {})).statusCode).toBe(400);
      expect((await patch(id, { code: 'OTRO' })).statusCode).toBe(400); // el código no se edita
      expect((await patch(id, { colorFavorito: 'azul' })).statusCode).toBe(400);
      expect(
        (await patch('00000000-0000-4000-8000-000000000000', { active: false })).statusCode,
      ).toBe(404);
      expect((await patch('no-es-uuid', { active: false })).statusCode).toBe(400);
    });
  });

  describe('lista y redenciones', () => {
    it('la lista cuenta usos y suma lo descontado; las redenciones dicen quién y en qué pedido', async () => {
      const code = codeOf();
      const created = json(await create({ code, kind: 'fixed', value: 20_000, perUserLimit: 2 }));
      const o1 = json(await orderHttp(code));
      const o2 = json(await orderHttp(code));
      const list = json(await app.inject({ url: '/v1/admin/coupons', headers: staff }));
      const row = list.find((c: { id: string }) => c.id === created.id);
      expect(row).toMatchObject({ redemptions: 2, discountTotal: 40_000, termsLocked: true });

      const res = await app.inject({
        url: `/v1/admin/coupons/${created.id}/redemptions`,
        headers: staff,
      });
      expect(res.statusCode).toBe(200);
      const rows = json(res);
      expect(rows).toHaveLength(2);
      expect(rows.map((r: { orderId: string }) => r.orderId).sort()).toEqual([o1.id, o2.id].sort());
      expect(rows[0]).toMatchObject({
        userId: w.customerId,
        customerName: 'Cliente',
        amount: 20_000,
        orderStatus: 'confirmed',
      });
      expect(rows[0].orderCode).toMatch(/^JF-\d{6}$/);
      // no expone el teléfono del cliente
      expect(JSON.stringify(rows)).not.toContain('+1809');
    });

    it('un cupón cancelado deja de contar en la lista y en las redenciones', async () => {
      const code = codeOf();
      const created = json(await create({ code, kind: 'percent', value: 1000 }));
      const order = json(await orderHttp(code));
      await app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/cancel`,
        headers: customer,
        payload: {},
      });
      const row = json(await app.inject({ url: '/v1/admin/coupons', headers: admin })).find(
        (c: { id: string }) => c.id === created.id,
      );
      expect(row).toMatchObject({ redemptions: 0, discountTotal: 0, termsLocked: false });
      expect(
        json(
          await app.inject({ url: `/v1/admin/coupons/${created.id}/redemptions`, headers: admin }),
        ),
      ).toEqual([]);
    });

    it('redenciones de un cupón que no existe: 404', async () => {
      const res = await app.inject({
        url: '/v1/admin/coupons/00000000-0000-4000-8000-000000000000/redemptions',
        headers: admin,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
