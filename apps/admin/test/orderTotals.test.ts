import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../api/src/config';
import { type DbHandle, createPgliteDb } from '../../api/src/db/client';
import type { Db } from '../../api/src/db/client';
import { users, variants } from '../../api/src/db/schema';
import { importCatalog, syncCategories } from '../../api/src/services/catalog';
import {
  type CouponRow,
  type CouponTerms as ServerTerms,
  couponDiscount as serverCouponDiscount,
  createCoupon,
  finalDiscountForOrder,
  listCoupons,
} from '../../api/src/services/coupons';
import {
  type OrderContext,
  createOrder,
  recordWeights,
  transitionOrder,
} from '../../api/src/services/orders';
import { createZone, listSlots } from '../../api/src/services/zones';
import {
  type CouponTerms,
  couponDiscount,
  finalDiscount,
  previewOrderTotals,
  settledDiscount,
} from '../src/lib/orderTotals';

// Prueba DIFERENCIAL: lo que el panel muestra al pesar tiene que ser lo que el servidor cobra al
// empacar. Aquí se importa el cálculo real del API; las cifras son inventadas.

// ───────────── Parte 1: el descuento, función contra función ─────────────

const COUPONS: [string, CouponTerms][] = [
  ['10 %', { kind: 'percent', value: 1000, maxDiscount: null }],
  ['12.5 %', { kind: 'percent', value: 1250, maxDiscount: null }],
  ['33.33 %', { kind: 'percent', value: 3333, maxDiscount: null }],
  ['0.01 %', { kind: 'percent', value: 1, maxDiscount: null }],
  ['100 %', { kind: 'percent', value: 10_000, maxDiscount: null }],
  ['20 % con tope RD$ 50', { kind: 'percent', value: 2000, maxDiscount: 5000 }],
  ['10 % con tope enorme', { kind: 'percent', value: 1000, maxDiscount: 99_999_999 }],
  ['RD$ 150 fijo', { kind: 'fixed', value: 15_000, maxDiscount: null }],
  ['RD$ 0.01 fijo', { kind: 'fixed', value: 1, maxDiscount: null }],
  ['fijo mayor que todo', { kind: 'fixed', value: 99_999_999, maxDiscount: null }],
  ['fijo con tope', { kind: 'fixed', value: 15_000, maxDiscount: 4000 }],
  ['envío gratis', { kind: 'free_delivery', value: 0, maxDiscount: null }],
];
const GROSS = [0, 1, 99, 100, 999, 1_001, 10_925, 109_250, 123_457, 1_092_500, 5_000_000];

/** Una base que solo sabe contestar "¿qué cupón tiene este código?": el resto del cálculo es el real. */
const stubDb = (row: CouponTerms | null) =>
  ({
    select: () => ({ from: () => ({ where: () => Promise.resolve(row ? [row] : []) }) }),
  }) as unknown as Db;

describe('descuento: el del panel es el del servidor', () => {
  it.each(COUPONS)('couponDiscount con %s', (_name, c) => {
    for (const gross of GROSS) {
      expect(couponDiscount(c, gross), `bruto ${gross}`).toBe(
        serverCouponDiscount(c as Pick<CouponRow, 'kind' | 'value' | 'maxDiscount'>, gross),
      );
    }
  });

  it.each(COUPONS)('descuento definitivo con %s', async (_name, c) => {
    for (const discount of [0, 1, 5000, 15_000]) {
      for (const gross of GROSS) {
        const order = { couponCode: 'PRUEBA', discount };
        expect(finalDiscount(order, c, gross), `desc ${discount} bruto ${gross}`).toBe(
          await finalDiscountForOrder(stubDb(c), order, gross),
        );
      }
    }
  });

  it('un pedido sin cupón conserva su descuento; un cupón que ya no existe cae en la regla del monto fijo', async () => {
    for (const gross of GROSS) {
      for (const order of [
        { couponCode: null, discount: 0 },
        { couponCode: null, discount: 7000 },
        { couponCode: 'PRUEBA', discount: 7000 },
        { couponCode: 'PRUEBA', discount: 0 },
      ]) {
        expect(finalDiscount(order, null, gross)).toBe(
          await finalDiscountForOrder(stubDb(null), order, gross),
        );
      }
    }
  });

  it('el porcentaje sube con el peso real; el fijo no', () => {
    const order = { couponCode: 'PRUEBA', discount: 10_925 };
    expect(finalDiscount(order, COUPONS[0]![1], 120_175)).toBe(12_017); // 10 % de RD$ 1,201.75
    expect(finalDiscount(order, COUPONS[7]![1], 120_175)).toBe(10_925);
  });
});

// ───────────── Parte 2: el total, contra el servidor de verdad (base PGlite) ─────────────

const NOW = new Date('2026-10-07T14:00:00Z'); // 10:00 en RD (UTC-4)
const CSV = [
  'sku,grupo,nombre,variante,categoria,unidad,paso_lb,minimo_lb,precio,precio_fuente,itbis,stock',
  'LB-1,pollo,Pollo de prueba,,aves,lb,0.5,1,109.25,usuario,0,100000',
  'LB-2,res,Res de prueba,,aves,lb,0.5,1,301.37,usuario,0,100000',
  'UN-1,combo,Combo de prueba,,combos,unit,,,1850,usuario,18,500',
].join('\n');
const ADDRESS = {
  label: 'Casa',
  line1: 'Calle de prueba 10',
  reference: 'Portón negro',
  sector: 'Naco',
  city: 'Santo Domingo',
  latitude: 18.4861,
  longitude: -69.9312,
  contactPhone: '+18095550001',
};

type Line = { sku: string; quantity: number; weigh?: number };
interface Case {
  name: string;
  coupon?: Partial<ServerTerms>;
  lines: Line[];
}

const CASES: Case[] = [
  { name: 'sin cupón', lines: [{ sku: 'LB-1', quantity: 1000, weigh: 1040 }] },
  {
    name: '10 % sobre 10 lb que pesan 10.5',
    coupon: { kind: 'percent', value: 1000 },
    lines: [{ sku: 'LB-1', quantity: 1000, weigh: 1050 }],
  },
  {
    name: '10 % cuando el peso real baja',
    coupon: { kind: 'percent', value: 1000 },
    lines: [{ sku: 'LB-1', quantity: 1000, weigh: 960 }],
  },
  {
    name: '12.5 % con tope de RD$ 100 sobre dos cortes',
    coupon: { kind: 'percent', value: 1250, maxDiscount: 10_000 },
    lines: [
      { sku: 'LB-1', quantity: 800, weigh: 830 },
      { sku: 'LB-2', quantity: 500, weigh: 540 },
    ],
  },
  {
    name: '1 % (redondea hacia abajo)',
    coupon: { kind: 'percent', value: 100 },
    lines: [{ sku: 'LB-1', quantity: 1000, weigh: 1000 }],
  },
  {
    name: 'monto fijo de RD$ 150',
    coupon: { kind: 'fixed', value: 15_000 },
    lines: [{ sku: 'LB-2', quantity: 800, weigh: 845 }],
  },
  {
    name: 'envío gratis',
    coupon: { kind: 'free_delivery', value: 0 },
    lines: [{ sku: 'LB-1', quantity: 800, weigh: 850 }],
  },
  {
    name: '20 % con un combo por unidad que no se pesa',
    coupon: { kind: 'percent', value: 2000 },
    lines: [
      { sku: 'UN-1', quantity: 1 },
      { sku: 'LB-1', quantity: 800, weigh: 770 },
    ],
  },
];

describe('total al pesar: el del panel es el que cobra el servidor al empacar', () => {
  it('coincide en cada tipo de cupón con peso real distinto del pedido', async () => {
    const handle: DbHandle = await createPgliteDb();
    try {
      const { db } = handle;
      const config = testConfig({
        windows: {
          startHour: 10,
          endHour: 20,
          windowHours: 2,
          capacityPerWindow: 1000,
          leadMinutes: 90,
          daysAhead: 3,
        },
      });
      const categories = JSON.parse(
        readFileSync(new URL('../../../data/catalog/categories.json', import.meta.url), 'utf8'),
      );
      await syncCategories(db, categories);
      const imported = await importCatalog(db, CSV);
      if (!imported.ok)
        throw new Error(`CSV de prueba inválido: ${JSON.stringify(imported.errors)}`);
      const [customer, admin] = await db
        .insert(users)
        .values([
          { phone: '+18095550001', name: 'Cliente', role: 'customer' },
          { phone: '+18095550002', name: 'Admin', role: 'admin' },
        ])
        .returning({ id: users.id });
      await createZone(db, {
        name: 'Distrito Nacional',
        areas: ['Naco', 'Distrito Nacional'],
        feeCentavos: 15_000,
        minOrderCentavos: 80_000,
        freeOverCentavos: 400_000,
      });
      const ctx: OrderContext = { db, config, now: () => NOW };
      const slotStart = (await listSlots(db, config, NOW))[0]!.start;
      const actor = { id: admin!.id, role: 'admin' as const };
      const variantId = async (sku: string) =>
        (await db.select().from(variants).where(eq(variants.sku, sku)))[0]!.id;

      let n = 0;
      let oldWrong = 0;
      for (const c of CASES) {
        let code: string | undefined;
        if (c.coupon) {
          code = `PRUEBA${++n}`;
          await createCoupon(db, {
            code,
            description: '',
            kind: 'percent',
            value: 0,
            minSubtotal: 0,
            maxDiscount: null,
            startsAt: null,
            endsAt: null,
            maxRedemptions: null,
            perUserLimit: 1000,
            active: true,
            ...c.coupon,
          });
        }
        const order = await createOrder(ctx, {
          userId: customer!.id,
          items: await Promise.all(
            c.lines.map(async (l) => ({ variantId: await variantId(l.sku), quantity: l.quantity })),
          ),
          address: ADDRESS,
          slotStart,
          paymentMethod: 'cash',
          couponCode: code,
        });
        await transitionOrder(ctx, order.id, 'picking', actor);
        const weighable = c.lines.filter((l) => l.weigh !== undefined);
        const weighed = await recordWeights(
          ctx,
          order.id,
          weighable.map((l) => ({
            itemId: order.items.find((i) => i.sku === l.sku)!.id,
            finalQuantity: l.weigh!,
          })),
        );

        // Lo que recibe el panel: el pedido y la lista de cupones, ambos con la forma del DTO.
        const terms = (await listCoupons(db, NOW)).find((x) => x.code === code) ?? null;
        const items = weighed.items.map((i) => ({ ...i, quantity: i.finalQuantity ?? i.quantity }));
        const preview = previewOrderTotals(weighed, items, terms);

        const packed = await transitionOrder(ctx, order.id, 'packed', actor);
        expect(preview.total, c.name).toBe(packed.finalTotal);
        expect(preview.exact, c.name).toBe(true);
        expect(settledDiscount(packed, preview.gross, packed.finalTotal!), c.name).toBe(
          preview.discount,
        );

        // La vista previa de antes restaba el descuento del pedido tal cual se hizo.
        const oldTotal =
          items.reduce((a, i) => a + preview.lineGross[i.id]!, 0) -
          weighed.discount +
          weighed.deliveryFee;
        if (oldTotal !== packed.finalTotal) oldWrong++;
      }
      // Con un porcentaje (sin tope que lo iguale) y otro peso, la fórmula vieja daba otro total.
      expect(oldWrong).toBeGreaterThanOrEqual(3);
    } finally {
      await handle.close();
    }
  });

  it('sin los términos del cupón la vista previa se marca como estimada', () => {
    const order = { couponCode: 'PRUEBA', discount: 10_925, deliveryFee: 15_000 };
    const items = [
      {
        id: 'a',
        pricingUnit: 'lb' as const,
        unitPrice: 10_925,
        variableWeight: true,
        quantity: 1050,
      },
    ];
    expect(previewOrderTotals(order, items, undefined).exact).toBe(false);
    expect(previewOrderTotals(order, items, COUPONS[0]![1]).exact).toBe(true);
    // sin cupón no hay nada que adivinar
    expect(
      previewOrderTotals({ couponCode: null, discount: 0, deliveryFee: 15_000 }, items, undefined)
        .exact,
    ).toBe(true);
    // un envío gratis (descuento 0) tampoco depende de los términos
    expect(
      previewOrderTotals({ couponCode: 'PRUEBA', discount: 0, deliveryFee: 0 }, items, undefined)
        .exact,
    ).toBe(true);
  });
});
