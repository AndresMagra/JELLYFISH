import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { type MovementType, inventoryMovements, variants } from '../db/schema';
import { conflict, invalid, notFound } from '../errors';

interface MovementMeta {
  orderId?: string | null;
  actorId?: string | null;
  note?: string;
}

async function log(db: Db, variantId: string, type: MovementType, qty: number, meta: MovementMeta) {
  await db.insert(inventoryMovements).values({
    variantId,
    type,
    qty,
    orderId: meta.orderId ?? null,
    actorId: meta.actorId ?? null,
    note: meta.note ?? '',
  });
}

/**
 * Reserva stock de forma atómica: el UPDATE solo ocurre si queda disponible
 * (on_hand - reserved >= qty), así dos pedidos simultáneos no pueden quedarse con la misma libra.
 * Devuelve false si no hay suficiente.
 */
export async function reserve(db: Db, variantId: string, qty: number, meta: MovementMeta = {}) {
  const rows = await db
    .update(variants)
    .set({ reserved: sql`${variants.reserved} + ${qty}`, updatedAt: new Date() })
    .where(
      and(eq(variants.id, variantId), sql`${variants.onHand} - ${variants.reserved} >= ${qty}`),
    )
    .returning({ id: variants.id });
  if (rows.length === 0) return false;
  await log(db, variantId, 'reserve', qty, meta);
  return true;
}

/** Libera una reserva (pedido cancelado o vencido). Nunca deja `reserved` negativo. */
export async function release(db: Db, variantId: string, qty: number, meta: MovementMeta = {}) {
  await db
    .update(variants)
    .set({ reserved: sql`GREATEST(${variants.reserved} - ${qty}, 0)`, updatedAt: new Date() })
    .where(eq(variants.id, variantId));
  await log(db, variantId, 'release', -qty, meta);
}

/**
 * Descuenta lo realmente empacado y libera la reserva original.
 * Si el peso real supera lo que hay registrado, `on_hand` queda en 0 (no negativo) y se anota
 * la diferencia: el inventario físico manda y el administrador debe cuadrarlo.
 */
export async function pick(
  db: Db,
  variantId: string,
  orderedQty: number,
  finalQty: number,
  meta: MovementMeta = {},
) {
  const [before] = await db
    .select({ onHand: variants.onHand })
    .from(variants)
    .where(eq(variants.id, variantId));
  if (!before) throw notFound('Artículo');
  const removed = Math.min(finalQty, before.onHand);
  await db
    .update(variants)
    .set({
      onHand: sql`GREATEST(${variants.onHand} - ${finalQty}, 0)`,
      reserved: sql`GREATEST(${variants.reserved} - ${orderedQty}, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(variants.id, variantId));
  const shortfall = finalQty - removed;
  await log(db, variantId, 'pick', -removed, {
    ...meta,
    note:
      shortfall > 0
        ? `${meta.note ?? ''} Faltaron ${shortfall} en el registro: cuadrar inventario`.trim()
        : (meta.note ?? ''),
  });
}

/** Devuelve al inventario algo ya empacado (pedido cancelado antes de salir). */
export async function restock(db: Db, variantId: string, qty: number, meta: MovementMeta = {}) {
  await db
    .update(variants)
    .set({ onHand: sql`${variants.onHand} + ${qty}`, updatedAt: new Date() })
    .where(eq(variants.id, variantId));
  await log(db, variantId, 'restock', qty, meta);
}

export type AdjustType = 'receive' | 'adjust' | 'waste';

/** Entrada de mercancía, ajuste por conteo o merma. `delta` positivo suma, negativo resta. */
export async function adjustStock(
  db: Db,
  variantId: string,
  type: AdjustType,
  delta: number,
  meta: MovementMeta = {},
) {
  if (!Number.isSafeInteger(delta) || delta === 0)
    throw invalid('La cantidad debe ser un entero distinto de 0');
  if (type === 'receive' && delta < 0) throw invalid('Una entrada de mercancía debe ser positiva');
  if (type === 'waste' && delta > 0) throw invalid('Una merma debe ser negativa');

  const rows = await db
    .update(variants)
    .set({ onHand: sql`${variants.onHand} + ${delta}`, updatedAt: new Date() })
    .where(
      and(
        eq(variants.id, variantId),
        // No se puede bajar por debajo de lo ya prometido a clientes.
        sql`${variants.onHand} + ${delta} >= ${variants.reserved}`,
      ),
    )
    .returning({ onHand: variants.onHand, reserved: variants.reserved });
  if (rows.length === 0) {
    const [v] = await db
      .select({ id: variants.id })
      .from(variants)
      .where(eq(variants.id, variantId));
    if (!v) throw notFound('Artículo');
    throw conflict(
      'stock_below_reserved',
      'No puedes dejar el inventario por debajo de lo reservado en pedidos activos',
    );
  }
  await log(db, variantId, type, delta, meta);
  return rows[0]!;
}

export async function lowStock(db: Db) {
  return db
    .select({
      id: variants.id,
      sku: variants.sku,
      onHand: variants.onHand,
      reserved: variants.reserved,
      threshold: variants.lowStockThreshold,
    })
    .from(variants)
    .where(
      and(
        eq(variants.active, true),
        sql`${variants.onHand} - ${variants.reserved} <= ${variants.lowStockThreshold}`,
      ),
    );
}
