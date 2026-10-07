import type { ReceiveLotInput } from '@jellyfish/shared';
import { and, asc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { orderItems, products, stockLots, variants } from '../db/schema';
import { conflict, invalid, notFound } from '../errors';
import { type AdjustType, adjustStock } from './inventory';
import type { OrderHooks } from './orders';

/**
 * Lotes con vencimiento (FEFO: primero en vencer, primero en salir).
 *
 * Modelo y reglas (ver docs/features/lotes-auditoria-seguridad.md):
 *  - `variants.on_hand` y `inventory_movements` siguen siendo la fuente de verdad del TOTAL. Los lotes
 *    solo dicen de dónde vino y cuándo vence. Invariante: suma de `qty_remaining` ≤ `on_hand`; la
 *    diferencia es "stock sin lote" (existencias anteriores a esta función, ajustes al alza).
 *  - Los lotes NUNCA bloquean la venta: lo vendible es `on_hand − reserved`, igual que siempre.
 *  - Todo lo que baja `on_hand` descuenta también de los lotes en orden FEFO: empacar un pedido,
 *    mermas y ajustes negativos. Lo que sube `on_hand` sin pasar por la recepción de un lote
 *    (ajuste al alza, cancelar un pedido ya empacado) queda como stock sin lote.
 */

export const EXPIRING_SOON_DAYS = 7;
/** Se acepta recibir un lote que venció hace poco (p. ej. para darlo de baja), no uno de años atrás. */
export const MAX_DAYS_PAST = 30;
/** Un congelado no dura más; evita años mal tecleados (2062). */
export const MAX_DAYS_FUTURE = 5 * 365;
const INT4_MAX = 2_147_483_647;
const DAY_MS = 86_400_000;

export interface LotContext {
  db: Db;
  config: Pick<Config, 'utcOffsetMinutes'>;
  now?: () => Date;
}

const nowOf = (ctx: Pick<LotContext, 'now'>) => (ctx.now ?? (() => new Date()))();

// ───────────── Fechas (día calendario de República Dominicana) ─────────────

/** "YYYY-MM-DD" del día local de RD en el instante `now`. */
export function localDate(now: Date, utcOffsetMinutes: number): string {
  return new Date(now.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Días de `from` a `to` (negativo si `to` ya pasó). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

export type LotStatus = 'expired' | 'expiring' | 'ok' | 'no_expiry';

/**
 * El día del vencimiento todavía es válido (daysLeft = 0 → "vence hoy"); vencido es estrictamente
 * antes de hoy.
 */
export function classifyLot(
  expiresOn: string | null,
  today: string,
): { daysLeft: number | null; status: LotStatus } {
  if (!expiresOn) return { daysLeft: null, status: 'no_expiry' };
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { daysLeft, status: 'expired' };
  return { daysLeft, status: daysLeft <= EXPIRING_SOON_DAYS ? 'expiring' : 'ok' };
}

// ───────────── Lecturas ─────────────

export interface LotView {
  id: string;
  variantId: string;
  sku: string;
  productName: string;
  variantLabel: string;
  pricingUnit: 'lb' | 'unit';
  lotCode: string;
  expiresOn: string | null;
  daysLeft: number | null;
  status: LotStatus;
  /** Centilibras si 'lb'; unidades si 'unit'. */
  qtyReceived: number;
  qtyRemaining: number;
  unitCostCentavos: number | null;
  note: string;
  receivedBy: string | null;
  receivedAt: Date;
}

/** Primero en vencer; sin fecha al final; a igual fecha, el que entró antes. */
const fefoOrder = () => [
  sql`${stockLots.expiresOn} ASC NULLS LAST`,
  asc(stockLots.receivedAt),
  asc(stockLots.id),
];

async function selectLotViews(
  db: Db,
  today: string,
  where: ReturnType<typeof and>,
  limit: number,
): Promise<LotView[]> {
  const rows = await db
    .select({
      lot: stockLots,
      sku: variants.sku,
      variantLabel: variants.variant,
      pricingUnit: variants.pricingUnit,
      productName: products.name,
    })
    .from(stockLots)
    .innerJoin(variants, eq(variants.id, stockLots.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(where)
    .orderBy(...fefoOrder())
    .limit(limit);
  return rows.map(({ lot, sku, variantLabel, pricingUnit, productName }) => ({
    id: lot.id,
    variantId: lot.variantId,
    sku,
    productName,
    variantLabel,
    pricingUnit,
    lotCode: lot.lotCode,
    expiresOn: lot.expiresOn,
    ...classifyLot(lot.expiresOn, today),
    qtyReceived: lot.qtyReceived,
    qtyRemaining: lot.qtyRemaining,
    unitCostCentavos: lot.unitCost,
    note: lot.note,
    receivedBy: lot.receivedBy,
    receivedAt: lot.receivedAt,
  }));
}

const todayOf = (ctx: LotContext) => localDate(nowOf(ctx), ctx.config.utcOffsetMinutes);

/** Lotes de un artículo (o de todos) en orden FEFO. Por defecto solo los que tienen saldo. */
export async function listLots(
  ctx: LotContext,
  opts: { variantId?: string; includeEmpty?: boolean; limit?: number } = {},
): Promise<LotView[]> {
  return selectLotViews(
    ctx.db,
    todayOf(ctx),
    and(
      opts.variantId ? eq(stockLots.variantId, opts.variantId) : undefined,
      opts.includeEmpty ? undefined : gt(stockLots.qtyRemaining, 0),
    ),
    Math.min(opts.limit ?? 200, 500),
  );
}

/**
 * Lotes con saldo que vencen en los próximos `days` días, por vencimiento. Incluye los ya vencidos
 * (con `status: 'expired'` y `daysLeft` negativo): son los que hay que sacar del congelador.
 */
export async function listExpiring(ctx: LotContext, days: number): Promise<LotView[]> {
  const today = todayOf(ctx);
  return selectLotViews(
    ctx.db,
    today,
    and(
      gt(stockLots.qtyRemaining, 0),
      isNotNull(stockLots.expiresOn),
      lte(stockLots.expiresOn, addDays(today, days)),
    ),
    500,
  );
}

/** Para el panel: lotes con saldo que vencen en ≤ 7 días (sin los ya vencidos) y vencidos con saldo. */
export async function expiryCounts(
  db: Db,
  now: Date,
  utcOffsetMinutes: number,
): Promise<{ expiringSoon: number; expired: number }> {
  const today = localDate(now, utcOffsetMinutes);
  const soon = addDays(today, EXPIRING_SOON_DAYS);
  const [row] = await db
    .select({
      expired: sql<number>`count(*) filter (where ${stockLots.expiresOn} < ${today}::date)::int`,
      expiringSoon: sql<number>`count(*) filter (where ${stockLots.expiresOn} >= ${today}::date and ${stockLots.expiresOn} <= ${soon}::date)::int`,
    })
    .from(stockLots)
    .where(and(gt(stockLots.qtyRemaining, 0), isNotNull(stockLots.expiresOn)));
  return { expiringSoon: row?.expiringSoon ?? 0, expired: row?.expired ?? 0 };
}

// ───────────── Recepción ─────────────

/**
 * Crea el lote y suma al inventario físico en UNA transacción, con el mismo `adjustStock('receive')`
 * de siempre: el movimiento en la bitácora de inventario y el lote nunca se desfasan.
 */
export async function receiveLot(
  ctx: LotContext,
  input: ReceiveLotInput,
  actorId: string | null,
): Promise<LotView> {
  const today = todayOf(ctx);
  const lotCode = input.lotCode.trim();
  if (!lotCode) throw invalid('El código del lote es obligatorio');
  if (!isCalendarDate(input.expiresOn)) throw invalid('expiresOn: usa una fecha válida AAAA-MM-DD');
  if (daysBetween(today, input.expiresOn) < -MAX_DAYS_PAST) {
    throw invalid(
      `expiresOn: la fecha de vencimiento ya pasó hace más de ${MAX_DAYS_PAST} días; revisa el año`,
    );
  }
  if (daysBetween(today, input.expiresOn) > MAX_DAYS_FUTURE) {
    throw invalid('expiresOn: la fecha de vencimiento está demasiado lejos; revisa el año');
  }
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw invalid('La cantidad debe ser un entero mayor que 0');
  }

  return ctx.db.transaction(async (tx) => {
    // Bloquea el artículo: dos recepciones o una recepción y un empaque no se pisan, y el chequeo
    // de código repetido de abajo no tiene carreras.
    const [variant] = await tx
      .select({ id: variants.id, onHand: variants.onHand })
      .from(variants)
      .where(eq(variants.id, input.variantId))
      .for('update');
    if (!variant) throw notFound('Artículo');
    if (variant.onHand + input.quantity > INT4_MAX)
      throw invalid('La cantidad es demasiado grande');

    const [dup] = await tx
      .select({ id: stockLots.id })
      .from(stockLots)
      .where(
        and(
          eq(stockLots.variantId, input.variantId),
          sql`lower(${stockLots.lotCode}) = ${lotCode.toLowerCase()}`,
        ),
      );
    if (dup) {
      throw conflict(
        'lot_exists',
        `El lote ${lotCode} ya está registrado para este artículo. Si es otra entrega, usa otro código.`,
      );
    }

    const extra = input.note?.trim();
    await adjustStock(tx, input.variantId, 'receive', input.quantity, {
      actorId,
      note: `Lote ${lotCode} (vence ${input.expiresOn})${extra ? `: ${extra}` : ''}`,
    });
    const [lot] = await tx
      .insert(stockLots)
      .values({
        variantId: input.variantId,
        lotCode,
        expiresOn: input.expiresOn,
        qtyReceived: input.quantity,
        qtyRemaining: input.quantity,
        unitCost: input.unitCostCentavos ?? null,
        note: extra ?? '',
        receivedBy: actorId,
        receivedAt: nowOf(ctx),
      })
      .returning({ id: stockLots.id });
    const [view] = await selectLotViews(tx, today, eq(stockLots.id, lot!.id), 1);
    return view!;
  });
}

// ───────────── Consumo FEFO ─────────────

export interface LotConsumption {
  consumed: number;
  /** Lo que los lotes no cubrieron (stock sin lote): no es un error. */
  shortfall: number;
  allocations: { lotId: string; lotCode: string; qty: number }[];
}

/**
 * Descuenta `qty` de los lotes del artículo, el que vence primero antes. Bloquea las filas de los
 * lotes. Si los lotes no alcanzan, consume lo que haya y lo demás queda como `shortfall`.
 */
export async function consumeFefo(tx: Db, variantId: string, qty: number): Promise<LotConsumption> {
  if (!(qty > 0)) return { consumed: 0, shortfall: 0, allocations: [] };
  const lots = await tx
    .select({ id: stockLots.id, lotCode: stockLots.lotCode, qtyRemaining: stockLots.qtyRemaining })
    .from(stockLots)
    .where(and(eq(stockLots.variantId, variantId), gt(stockLots.qtyRemaining, 0)))
    .orderBy(...fefoOrder())
    .for('update');
  let left = qty;
  const allocations: LotConsumption['allocations'] = [];
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(left, lot.qtyRemaining);
    await tx
      .update(stockLots)
      .set({ qtyRemaining: sql`${stockLots.qtyRemaining} - ${take}` })
      .where(eq(stockLots.id, lot.id));
    allocations.push({ lotId: lot.id, lotCode: lot.lotCode, qty: take });
    left -= take;
  }
  return { consumed: qty - left, shortfall: left, allocations };
}

/**
 * Ajuste manual de inventario que mantiene los lotes al día: una baja (merma o ajuste negativo)
 * también descuenta FEFO; una alta suelta (sin lote) queda como stock sin lote. Para altas con
 * vencimiento hay que usar la recepción de lotes.
 */
export async function adjustStockWithLots(
  db: Db,
  variantId: string,
  type: AdjustType,
  delta: number,
  meta: { actorId?: string | null; note?: string } = {},
) {
  return db.transaction(async (tx) => {
    const result = await adjustStock(tx, variantId, type, delta, meta);
    if (delta < 0) await consumeFefo(tx, variantId, -delta);
    return result;
  });
}

/**
 * Red de seguridad: si algo bajó `on_hand` sin pasar por aquí (p. ej. la importación del catálogo
 * con "aplicar existencias", que fija el valor absoluto), los lotes no pueden sumar más que el
 * inventario físico. Descuenta FEFO el exceso. Devuelve cuántos artículos corrigió.
 */
export async function reconcileLots(db: Db): Promise<number> {
  const rows = await db
    .select({
      variantId: stockLots.variantId,
      lots: sql<number>`sum(${stockLots.qtyRemaining})::int`,
      onHand: variants.onHand,
    })
    .from(stockLots)
    .innerJoin(variants, eq(variants.id, stockLots.variantId))
    .groupBy(stockLots.variantId, variants.onHand)
    .having(sql`sum(${stockLots.qtyRemaining}) > ${variants.onHand}`);
  let fixed = 0;
  for (const row of rows.sort((a, b) => a.variantId.localeCompare(b.variantId))) {
    await db.transaction(async (tx) => {
      // Se vuelve a medir ya con el artículo bloqueado: otro proceso pudo ajustarlo.
      const [v] = await tx
        .select({ onHand: variants.onHand })
        .from(variants)
        .where(eq(variants.id, row.variantId))
        .for('update');
      const [t] = await tx
        .select({ total: sql<number>`coalesce(sum(${stockLots.qtyRemaining}), 0)::int` })
        .from(stockLots)
        .where(eq(stockLots.variantId, row.variantId));
      const excess = (t?.total ?? 0) - (v?.onHand ?? 0);
      if (excess > 0) {
        await consumeFefo(tx, row.variantId, excess);
        fixed++;
      }
    });
  }
  return fixed;
}

// ───────────── Hook del pedido ─────────────

/**
 * Al pasar a `packed` se descuenta de los lotes lo realmente empacado (`finalQuantity ?? quantity`),
 * dentro de la misma transacción que el `pick` del inventario. Si cancelan un pedido ya empacado, lo
 * que vuelve al congelador queda como stock sin lote (no sabemos de qué lote salió cada libra).
 */
export function lotHooks(): OrderHooks {
  return {
    afterTransition: async (tx, order, _from, to) => {
      if (to !== 'packed') return;
      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      const perVariant = new Map<string, number>();
      for (const i of items) {
        perVariant.set(
          i.variantId,
          (perVariant.get(i.variantId) ?? 0) + (i.finalQuantity ?? i.quantity),
        );
      }
      // Mismo orden por artículo que el `pick` del pedido: evita interbloqueos entre pedidos.
      for (const variantId of [...perVariant.keys()].sort()) {
        await consumeFefo(tx, variantId, perVariant.get(variantId)!);
      }
    },
  };
}
