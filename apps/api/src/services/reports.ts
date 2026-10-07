import { and, count, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { orders, payments, variants } from '../db/schema';
import { listCatalogAdmin } from './catalog';
import { cashReport } from './payments';
import type { OrderContext } from './orders';

/** Medianoche (hora de RD) del día de `now`, expresada en UTC. */
export function startOfLocalDay(now: Date, utcOffsetMinutes: number): Date {
  const offset = utcOffsetMinutes * 60_000;
  const local = new Date(now.getTime() + offset);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset,
  );
}

const ACTIVE = [
  'pending_payment',
  'confirmed',
  'picking',
  'packed',
  'out_for_delivery',
  'delivery_failed',
] as const;

/** Lo que el dueño necesita ver al abrir el panel: qué hacer ahora y cómo va el día. */
export async function adminSummary(ctx: OrderContext) {
  const { db, config } = ctx;
  const now = (ctx.now ?? (() => new Date()))();
  const dayStart = startOfLocalDay(now, config.utcOffsetMinutes);

  const activeRows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .where(inArray(orders.status, [...ACTIVE]))
    .groupBy(orders.status);
  const active = Object.fromEntries(ACTIVE.map((s) => [s, 0])) as Record<
    (typeof ACTIVE)[number],
    number
  >;
  for (const r of activeRows) active[r.status as (typeof ACTIVE)[number]] = r.n;

  const [today] = await db
    .select({
      orders: count(),
      sales: sql<number>`coalesce(sum(coalesce(${orders.finalTotal}, ${orders.total})), 0)::int`,
    })
    .from(orders)
    .where(
      and(
        gte(orders.createdAt, dayStart),
        ne(orders.status, 'cancelled'),
        ne(orders.status, 'pending_payment'),
        ne(orders.status, 'refunded'),
      ),
    );
  const [delivered] = await db
    .select({ n: count() })
    .from(orders)
    .where(and(eq(orders.status, 'delivered'), gte(orders.deliveredAt, dayStart)));

  const [refunds] = await db
    .select({ n: count(), amount: sql<number>`coalesce(sum(${payments.refundPending}), 0)::int` })
    .from(payments)
    .where(sql`${payments.refundPending} > 0`);
  const [transfers] = await db
    .select({ n: count() })
    .from(payments)
    .where(
      and(
        eq(payments.method, 'transfer'),
        eq(payments.status, 'pending'),
        sql`${payments.raw} -> 'proof' IS NOT NULL`,
      ),
    );

  const cash = await cashReport(db);
  const catalog = await listCatalogAdmin(db, config.demo);
  const [variantCount] = await db.select({ n: count() }).from(variants);

  return {
    generatedAt: now,
    today: { orders: today?.orders ?? 0, sales: today?.sales ?? 0, delivered: delivered?.n ?? 0 },
    active,
    refunds: { count: refunds?.n ?? 0, amount: refunds?.amount ?? 0 },
    transfersToVerify: transfers?.n ?? 0,
    cashOutstanding: cash.reduce((a, r) => a + r.balance, 0),
    catalog: {
      variants: variantCount?.n ?? 0,
      blocked: catalog.filter((r) => r.blockers.length > 0).length,
      outOfStock: catalog.filter((r) => r.active && r.onHand - r.reserved <= 0).length,
    },
  };
}
