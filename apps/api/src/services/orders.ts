import {
  type OrderStatus,
  type PricedLineInput,
  assertTransition,
  authorizationAmount,
  computeOrderTotals,
  formatDOP,
  lineGross,
  nextStatuses,
} from '@jellyfish/shared';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import {
  type AddressSnapshot,
  type PaymentMethod,
  type SubstitutionPolicy,
  orderEvents,
  orderItems,
  orders,
  products,
  users,
  variants,
} from '../db/schema';
import { DomainError, conflict, forbidden, invalid, notFound } from '../errors';
import { formatOrderNumber } from '../text';
import { variantBlockers } from './catalog';
import * as inventory from './inventory';
import { assertSlotAvailable, deliveryPricing, findZone, type Zone } from './zones';

export interface OrderHooks {
  /** Se ejecuta dentro de la transacción, tras cambiar el estado. Úsalo para cobrar/anular/reembolsar. */
  afterTransition?: (
    tx: Db,
    order: typeof orders.$inferSelect,
    from: OrderStatus,
    to: OrderStatus,
  ) => Promise<void>;
}

export interface OrderContext {
  db: Db;
  config: Config;
  hooks?: OrderHooks;
  now?: () => Date;
}

const nowOf = (ctx: OrderContext) => (ctx.now ?? (() => new Date()))();

// ───────────────────────── cotización ─────────────────────────

export interface OrderItemInput {
  variantId: string;
  /** Centilibras si el artículo se vende por libra; unidades si es por unidad. */
  quantity: number;
}

export interface QuoteLine {
  variantId: string;
  sku: string;
  name: string;
  variant: string;
  pricingUnit: 'lb' | 'unit';
  unitPrice: number;
  itbisBps: number;
  variableWeight: boolean;
  quantity: number;
  photo: string;
  gross: number;
  discount: number;
  net: number;
  itbis: number;
}

export interface Quote {
  lines: QuoteLine[];
  subtotal: number;
  discount: number;
  deliveryFee: number;
  itbis: number;
  total: number;
  authorizedAmount: number;
  zone: { id: string; name: string } | null;
  freeDelivery: boolean;
  missingForMinimum: number;
  missingForFreeDelivery: number | null;
  demo: boolean;
}

function mergeItems(items: OrderItemInput[]): OrderItemInput[] {
  const map = new Map<string, number>();
  for (const i of items) map.set(i.variantId, (map.get(i.variantId) ?? 0) + i.quantity);
  return [...map.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export async function quoteOrder(
  ctx: OrderContext,
  input: { items: OrderItemInput[]; zone?: Zone | null },
  db: Db = ctx.db,
): Promise<Quote> {
  const { config } = ctx;
  if (input.items.length === 0) throw invalid('El carrito está vacío');
  const items = mergeItems(input.items);

  const rows = await db
    .select()
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(
      inArray(
        variants.id,
        items.map((i) => i.variantId),
      ),
    );
  const byId = new Map(rows.map((r) => [r.variants.id, r]));

  const lines: QuoteLine[] = [];
  const priced: PricedLineInput[] = [];
  for (const item of items) {
    const row = byId.get(item.variantId);
    if (!row)
      throw new DomainError('invalid_item', 'Un producto del carrito ya no existe', 400, item);
    const v = row.variants;
    const label = v.variant ? `${row.products.name} ${v.variant}` : row.products.name;
    if (variantBlockers(v, row.products.active, config.demo).length > 0) {
      throw new DomainError('unavailable', `${label} no está disponible por ahora`, 409, item);
    }
    const q = item.quantity;
    if (!Number.isSafeInteger(q) || q <= 0) throw invalid(`Cantidad inválida para ${label}`, item);

    if (v.pricingUnit === 'lb') {
      const min = v.minCentilb ?? 100;
      const step = v.stepCentilb ?? 50;
      if (q < min) throw invalid(`El mínimo de ${label} es ${min / 100} lb`, item);
      if (q % step !== 0) throw invalid(`${label} se vende en múltiplos de ${step / 100} lb`, item);
      if (q > config.maxCentilbPerLine) {
        throw invalid(
          `El máximo por pedido de ${label} es ${config.maxCentilbPerLine / 100} lb`,
          item,
        );
      }
    } else if (q > config.maxUnitsPerLine) {
      throw invalid(`El máximo por pedido de ${label} es ${config.maxUnitsPerLine} unidades`, item);
    }

    const available = v.onHand - v.reserved;
    if (available < q) {
      throw new DomainError(
        'out_of_stock',
        available > 0
          ? `Solo quedan ${v.pricingUnit === 'lb' ? `${available / 100} lb` : `${available} u.`} de ${label}`
          : `${label} está agotado`,
        409,
        { variantId: v.id, available },
      );
    }

    const itbisBps = v.itbisBps ?? 0;
    priced.push({
      id: v.id,
      pricingUnit: v.pricingUnit,
      unitPrice: v.price,
      itbisBps,
      quantity: q,
      variableWeight: v.variableWeight && v.pricingUnit === 'lb',
    });
    lines.push({
      variantId: v.id,
      sku: v.sku,
      name: row.products.name,
      variant: v.variant,
      pricingUnit: v.pricingUnit,
      unitPrice: v.price,
      itbisBps,
      variableWeight: v.variableWeight && v.pricingUnit === 'lb',
      quantity: q,
      photo: v.photo,
      gross: 0,
      discount: 0,
      net: 0,
      itbis: 0,
    });
  }

  const subtotal = priced.reduce((a, p) => a + lineGross(p), 0);
  const zone = input.zone ?? null;
  const delivery = zone ? deliveryPricing(zone, subtotal) : null;
  const totals = computeOrderTotals(priced, { deliveryFee: delivery?.fee ?? 0 });
  totals.lines.forEach((l, i) => {
    Object.assign(lines[i]!, { gross: l.gross, discount: l.discount, net: l.net, itbis: l.itbis });
  });

  return {
    lines,
    subtotal: totals.subtotal,
    discount: totals.discount,
    deliveryFee: totals.deliveryFee,
    itbis: totals.itbis,
    total: totals.total,
    authorizedAmount: authorizationAmount(totals, config.authBufferBps),
    zone: zone ? { id: zone.id, name: zone.name } : null,
    freeDelivery: delivery?.free ?? false,
    missingForMinimum: delivery?.missingForMinimum ?? 0,
    missingForFreeDelivery: delivery?.missingForFree ?? null,
    demo: config.demo,
  };
}

// ───────────────────────── crear pedido ─────────────────────────

export interface CreateOrderInput {
  userId: string;
  items: OrderItemInput[];
  address: AddressSnapshot;
  slotStart: Date;
  paymentMethod: PaymentMethod;
  notes?: string;
  substitutionPolicy?: SubstitutionPolicy;
  /** Mismo valor ⇒ mismo pedido: el reintento devuelve el original en vez de duplicarlo. */
  idempotencyKey?: string;
}

async function findByIdempotencyKey(db: Db, userId: string, key: string) {
  const [row] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, key)));
  return row?.id ?? null;
}

export async function createOrder(ctx: OrderContext, input: CreateOrderInput) {
  const now = nowOf(ctx);
  const { config } = ctx;

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(ctx.db, input.userId, input.idempotencyKey);
    if (existing) return getOrder(ctx, existing, { userId: input.userId });
  }

  try {
    return await createOrderOnce(ctx, input, now, config);
  } catch (e) {
    // Dos reintentos simultáneos con la misma clave: gana uno, el otro devuelve el ganador.
    if (
      input.idempotencyKey &&
      /orders_idem_uq|duplicate key/i.test(String((e as Error).message))
    ) {
      const existing = await findByIdempotencyKey(ctx.db, input.userId, input.idempotencyKey);
      if (existing) return getOrder(ctx, existing, { userId: input.userId });
    }
    throw e;
  }
}

async function createOrderOnce(
  ctx: OrderContext,
  input: CreateOrderInput,
  now: Date,
  config: Config,
) {
  const orderId = await ctx.db.transaction(async (tx) => {
    const zone = await findZone(tx, input.address);
    if (!zone) {
      throw new DomainError(
        'out_of_zone',
        `Aún no entregamos en ${input.address.sector || input.address.city}. Pronto llegaremos.`,
        409,
      );
    }

    // Serializa las reservas de la misma franja para no sobrepasar su capacidad.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${Math.floor(input.slotStart.getTime() / 1000)})`,
    );
    const slot = await assertSlotAvailable(tx, config, input.slotStart, now);

    const quote = await quoteOrder(ctx, { items: input.items, zone }, tx);
    if (quote.missingForMinimum > 0) {
      throw new DomainError(
        'below_minimum',
        `El pedido mínimo para ${zone.name} es ${formatDOP(zone.minOrderCentavos)}. Te faltan ${formatDOP(quote.missingForMinimum)}.`,
        409,
        { missing: quote.missingForMinimum },
      );
    }

    const instantlyConfirmed = input.paymentMethod === 'cash';
    const holdMinutes =
      input.paymentMethod === 'transfer'
        ? config.reservationMinutesTransfer
        : config.reservationMinutesCard;
    const status: OrderStatus = instantlyConfirmed ? 'confirmed' : 'pending_payment';

    const [order] = await tx
      .insert(orders)
      .values({
        userId: input.userId,
        status,
        paymentMethod: input.paymentMethod,
        substitutionPolicy: input.substitutionPolicy ?? 'contact',
        zoneId: zone.id,
        address: input.address,
        slotStart: slot.start,
        slotEnd: slot.end,
        notes: input.notes ?? '',
        idempotencyKey: input.idempotencyKey ?? null,
        subtotal: quote.subtotal,
        discount: quote.discount,
        deliveryFee: quote.deliveryFee,
        itbis: quote.itbis,
        total: quote.total,
        authorizedAmount: quote.authorizedAmount,
        reservationExpiresAt: instantlyConfirmed
          ? null
          : new Date(now.getTime() + holdMinutes * 60_000),
      })
      .returning({ id: orders.id });

    await tx.insert(orderItems).values(
      quote.lines.map((l) => ({
        orderId: order!.id,
        variantId: l.variantId,
        sku: l.sku,
        name: l.name,
        variant: l.variant,
        pricingUnit: l.pricingUnit,
        unitPrice: l.unitPrice,
        itbisBps: l.itbisBps,
        variableWeight: l.variableWeight,
        quantity: l.quantity,
        lineTotal: l.net,
      })),
    );

    // Orden estable por id: evita interbloqueos entre pedidos que comparten artículos.
    const toReserve = [...quote.lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
    for (const l of toReserve) {
      const ok = await inventory.reserve(tx, l.variantId, l.quantity, {
        orderId: order!.id,
        actorId: input.userId,
        note: 'Reserva por pedido',
      });
      if (!ok) {
        throw new DomainError('out_of_stock', `${l.name} se agotó mientras hacías el pedido`, 409, {
          variantId: l.variantId,
        });
      }
    }

    await tx.insert(orderEvents).values({
      orderId: order!.id,
      fromStatus: null,
      toStatus: status,
      actorId: input.userId,
      note: instantlyConfirmed ? 'Pedido creado (pago contra entrega)' : 'Pedido creado',
    });
    return order!.id;
  });

  return getOrder(ctx, orderId);
}

// ───────────────────────── consulta ─────────────────────────

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

export interface OrderDTO extends Omit<OrderRow, 'number'> {
  number: number;
  code: string;
  items: OrderItemRow[];
  timeline: (typeof orderEvents.$inferSelect)[];
  /** Estados a los que se puede pasar desde el actual (para el panel admin y el repartidor). */
  next: readonly OrderStatus[];
}

async function hydrate(db: Db, order: OrderRow): Promise<OrderDTO> {
  const [items, timeline] = await Promise.all([
    db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.name)),
    db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, order.id))
      .orderBy(asc(orderEvents.createdAt)),
  ]);
  return {
    ...order,
    code: formatOrderNumber(order.number),
    items,
    timeline,
    next: nextStatuses(order.status),
  };
}

export async function getOrder(
  ctx: OrderContext,
  orderId: string,
  scope: { userId?: string } = {},
): Promise<OrderDTO> {
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  // 404 (no 403) para no revelar que el pedido existe.
  if (!order || (scope.userId && order.userId !== scope.userId)) throw notFound('Pedido');
  return hydrate(ctx.db, order);
}

export async function listOrdersForUser(ctx: OrderContext, userId: string, limit = 30) {
  const rows = await ctx.db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  return Promise.all(rows.map((o) => hydrate(ctx.db, o)));
}

export async function listOrdersAdmin(
  ctx: OrderContext,
  filter: { status?: OrderStatus[]; driverId?: string; limit?: number } = {},
) {
  const conditions = [];
  if (filter.status?.length) conditions.push(inArray(orders.status, filter.status));
  if (filter.driverId) conditions.push(eq(orders.driverId, filter.driverId));
  const rows = await ctx.db
    .select()
    .from(orders)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(filter.limit ?? 100, 200));
  return Promise.all(rows.map((o) => hydrate(ctx.db, o)));
}

// ───────────────────────── pesaje ─────────────────────────

export interface Actor {
  id: string | null;
  role: 'customer' | 'admin' | 'staff' | 'driver' | 'system';
}

export async function recordWeights(
  ctx: OrderContext,
  orderId: string,
  weights: { itemId: string; finalQuantity: number }[],
): Promise<OrderDTO> {
  const { config } = ctx;
  await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Pedido');
    if (order.status !== 'confirmed' && order.status !== 'picking') {
      throw conflict('wrong_status', 'Solo se puede pesar un pedido confirmado o en preparación');
    }
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const byId = new Map(items.map((i) => [i.id, i]));

    for (const w of weights) {
      const item = byId.get(w.itemId);
      if (!item) throw notFound('Línea del pedido');
      if (item.pricingUnit !== 'lb' || !item.variableWeight) {
        throw invalid(`${item.name} no se pesa: es de cantidad fija`);
      }
      if (!Number.isSafeInteger(w.finalQuantity) || w.finalQuantity <= 0) {
        throw invalid(`Peso inválido para ${item.name}`);
      }
      const low = (item.quantity * config.weightToleranceLowBps) / 10_000;
      const high = (item.quantity * config.weightToleranceHighBps) / 10_000;
      if (w.finalQuantity < low || w.finalQuantity > high) {
        throw invalid(
          `El peso de ${item.name} (${w.finalQuantity / 100} lb) difiere demasiado de lo pedido (${item.quantity / 100} lb). Revisa la báscula.`,
        );
      }
      const finalLineTotal = lineGross({
        id: item.id,
        pricingUnit: 'lb',
        unitPrice: item.unitPrice,
        itbisBps: item.itbisBps,
        quantity: w.finalQuantity,
        variableWeight: true,
      });
      await tx
        .update(orderItems)
        .set({ finalQuantity: w.finalQuantity, finalLineTotal })
        .where(eq(orderItems.id, item.id));
    }
  });
  return getOrder(ctx, orderId);
}

// ───────────────────────── cambios de estado ─────────────────────────

export async function transitionOrder(
  ctx: OrderContext,
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  note = '',
): Promise<OrderDTO> {
  const now = nowOf(ctx);
  await ctx.db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    if (!order) throw notFound('Pedido');
    const from = order.status;

    if (actor.role === 'customer') {
      if (order.userId !== actor.id) throw notFound('Pedido');
      if (to !== 'cancelled' || (from !== 'pending_payment' && from !== 'confirmed')) {
        throw forbidden('Solo puedes cancelar un pedido que aún no empezamos a preparar');
      }
    }
    if (actor.role === 'driver') {
      if (order.driverId !== actor.id) throw forbidden('Este pedido no está asignado a ti');
      if (to !== 'out_for_delivery' && to !== 'delivered' && to !== 'delivery_failed') {
        throw forbidden('Un repartidor solo puede marcar salida, entrega o intento fallido');
      }
    }

    try {
      assertTransition(from, to);
    } catch (e) {
      throw conflict('invalid_transition', (e as Error).message);
    }

    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    const patch: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: now };

    if (to === 'confirmed') patch.reservationExpiresAt = null;

    if (to === 'out_for_delivery' && !order.driverId) {
      throw conflict('no_driver', 'Asigna un repartidor antes de enviar el pedido');
    }

    if (to === 'packed') {
      const missing = items.filter(
        (i) => i.pricingUnit === 'lb' && i.variableWeight && i.finalQuantity === null,
      );
      if (missing.length > 0) {
        throw conflict('weights_missing', `Falta pesar: ${missing.map((m) => m.name).join(', ')}`, {
          itemIds: missing.map((m) => m.id),
        });
      }
      const finals = items.map((i) => ({
        item: i,
        finalQuantity: i.finalQuantity ?? i.quantity,
      }));
      const totals = computeOrderTotals(
        finals.map(({ item, finalQuantity }) => ({
          id: item.id,
          pricingUnit: item.pricingUnit,
          unitPrice: item.unitPrice,
          itbisBps: item.itbisBps,
          quantity: finalQuantity,
          variableWeight: item.variableWeight,
        })),
        { discount: order.discount, deliveryFee: order.deliveryFee },
      );
      for (const [idx, { item, finalQuantity }] of finals.entries()) {
        const line = totals.lines[idx]!;
        await tx
          .update(orderItems)
          .set({ finalQuantity, finalLineTotal: line.net })
          .where(eq(orderItems.id, item.id));
      }
      patch.finalTotal = totals.total;
      patch.finalItbis = totals.itbis;

      for (const { item, finalQuantity } of [...finals].sort((a, b) =>
        a.item.variantId.localeCompare(b.item.variantId),
      )) {
        await inventory.pick(tx, item.variantId, item.quantity, finalQuantity, {
          orderId,
          actorId: actor.id,
          note: 'Empacado',
        });
      }
    }

    if (to === 'cancelled') {
      patch.cancelReason = note || null;
      const sorted = [...items].sort((a, b) => a.variantId.localeCompare(b.variantId));
      if (from === 'packed') {
        // Ya descontado del inventario: vuelve al congelador porque aún no salió.
        for (const i of sorted) {
          await inventory.restock(tx, i.variantId, i.finalQuantity ?? i.quantity, {
            orderId,
            actorId: actor.id,
            note: 'Pedido cancelado antes de salir',
          });
        }
      } else if (from !== 'delivery_failed') {
        for (const i of sorted) {
          await inventory.release(tx, i.variantId, i.quantity, {
            orderId,
            actorId: actor.id,
            note: 'Pedido cancelado',
          });
        }
      }
      // Desde delivery_failed el producto ya salió: no vuelve solo al inventario (cadena de frío).
      // El administrador decide con un ajuste manual.
    }

    if (to === 'delivered') patch.deliveredAt = now;

    await tx.update(orders).set(patch).where(eq(orders.id, orderId));
    await tx.insert(orderEvents).values({
      orderId,
      fromStatus: from,
      toStatus: to,
      actorId: actor.id,
      note,
    });

    if (ctx.hooks?.afterTransition) {
      const [updated] = await tx.select().from(orders).where(eq(orders.id, orderId));
      await ctx.hooks.afterTransition(tx, updated!, from, to);
    }
  });
  return getOrder(ctx, orderId);
}

export async function assignDriver(ctx: OrderContext, orderId: string, driverId: string) {
  const [driver] = await ctx.db.select().from(users).where(eq(users.id, driverId));
  if (!driver || driver.role !== 'driver') throw invalid('El usuario indicado no es repartidor');
  const [order] = await ctx.db
    .update(orders)
    .set({ driverId, updatedAt: nowOf(ctx) })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.status, ['confirmed', 'picking', 'packed', 'delivery_failed']),
      ),
    )
    .returning({ id: orders.id });
  if (!order)
    throw conflict(
      'wrong_status',
      'No se puede asignar repartidor a este pedido en su estado actual',
    );
  return getOrder(ctx, orderId);
}

/** Cancela pedidos sin pagar cuya reserva venció y libera su stock. Devuelve cuántos canceló. */
export async function expireStaleOrders(ctx: OrderContext): Promise<number> {
  const now = nowOf(ctx);
  const stale = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, 'pending_payment'), lt(orders.reservationExpiresAt, now)));
  let n = 0;
  for (const { id } of stale) {
    try {
      await transitionOrder(
        ctx,
        id,
        'cancelled',
        { id: null, role: 'system' },
        'Reserva vencida sin pago',
      );
      n++;
    } catch (e) {
      // Otro proceso pudo cancelarlo o confirmarlo entre la consulta y la transacción.
      if (!(e instanceof DomainError)) throw e;
    }
  }
  return n;
}
