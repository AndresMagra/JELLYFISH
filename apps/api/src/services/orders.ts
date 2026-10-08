import {
  type OrderStatus,
  type PricedLineInput,
  absolutePhotoUrl,
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
  type CouponKind,
  type PaymentMethod,
  type PaymentStatus,
  type SubstitutionPolicy,
  orderEvents,
  orderItems,
  orders,
  payments,
  products,
  users,
  variants,
} from '../db/schema';
import { DomainError, conflict, forbidden, invalid, notFound } from '../errors';
import { formatOrderNumber } from '../text';
import { variantBlockers } from './catalog';
import {
  type CouponAttemptLimiter,
  couponRejectionError,
  describeCoupon,
  evaluateCoupon,
  finalDiscountForOrder,
  isUniqueViolation,
  recordFinalDiscount,
  recordRedemption,
  releaseRedemption,
} from './coupons';
import {
  type DeliveryGateInput,
  DRIVER_VIEWER,
  INTERNAL_VIEWER,
  type OrderViewer,
  PinRejection,
  applyDeliveryGate,
  deliveryFieldsFor,
  timelineFor,
} from './delivery';
import * as inventory from './inventory';
import { assertSlotAvailable, deliveryPricing, findZone, type Zone } from './zones';

/**
 * Puntos de extensión que se ejecutan DENTRO de la transacción del pedido. Así el módulo de
 * pagos reacciona a la creación y a los cambios de estado sin que `orders` dependa de él.
 */
export interface OrderHooks {
  /** Tras insertar el pedido, sus líneas y las reservas de stock. */
  afterCreate?: (tx: Db, order: OrderRow) => Promise<void>;
  /** Antes de aplicar un cambio de estado ya validado. Lanza un error para impedirlo. */
  beforeTransition?: (tx: Db, order: OrderRow, to: OrderStatus) => Promise<void>;
  /** Tras aplicar el cambio de estado. */
  afterTransition?: (tx: Db, order: OrderRow, from: OrderStatus, to: OrderStatus) => Promise<void>;
}

export interface OrderContext {
  db: Db;
  config: Config;
  hooks?: OrderHooks;
  now?: () => Date;
  /** Freno a quien prueba cupones al azar. Sin él (pruebas de servicio) no hay límite. */
  couponLimiter?: CouponAttemptLimiter;
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
  /** true = imagen ilustrativa: el carrito la rotula "Imagen ilustrativa". */
  photoIllustrative: boolean;
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
  /** Cupón aplicado (null si no se pidió o no sirvió). */
  coupon: { code: string; kind: CouponKind; discount: number; description: string } | null;
  /** Por qué no se aplicó el cupón pedido; null si no hubo problema. */
  couponError: string | null;
}

/** Cupón que acompaña a la cotización: `strict` = al crear el pedido (bloquea y rechaza). */
export interface QuoteCouponInput {
  code: string;
  userId: string | null;
  strict?: boolean;
}

function mergeItems(items: OrderItemInput[]): OrderItemInput[] {
  const map = new Map<string, number>();
  for (const i of items) map.set(i.variantId, (map.get(i.variantId) ?? 0) + i.quantity);
  return [...map.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export async function quoteOrder(
  ctx: OrderContext,
  input: { items: OrderItemInput[]; zone?: Zone | null; coupon?: QuoteCouponInput },
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
      photo: absolutePhotoUrl(v.photo, config.payments.publicBaseUrl),
      photoIllustrative: v.photoIllustrative,
      gross: 0,
      discount: 0,
      net: 0,
      itbis: 0,
    });
  }

  const subtotal = priced.reduce((a, p) => a + lineGross(p), 0);
  const zone = input.zone ?? null;
  const delivery = zone ? deliveryPricing(zone, subtotal) : null;

  // El mínimo del pedido y el envío gratis por monto se miden sobre el subtotal ANTES del cupón.
  let applied: Quote['coupon'] = null;
  let couponError: string | null = null;
  let discount = 0;
  let deliveryFee = delivery?.fee ?? 0;
  let waivedByCoupon = false;
  let totals = computeOrderTotals(priced, { deliveryFee });

  if (input.coupon) {
    const res = await evaluateCoupon(db, {
      rawCode: input.coupon.code,
      userId: input.coupon.userId,
      subtotal,
      deliveryFee: delivery ? delivery.fee : null,
      now: nowOf(ctx),
      lock: input.coupon.strict,
      limiter: ctx.couponLimiter,
    });
    if (!res.ok) {
      if (input.coupon.strict) throw couponRejectionError(res);
      couponError = res.message;
    } else {
      discount = res.discount;
      waivedByCoupon = res.deliveryWaived > 0;
      if (waivedByCoupon) deliveryFee = 0;
      totals = computeOrderTotals(priced, { discount, deliveryFee });
      // Un pedido de RD$ 0 no se puede cobrar (tarjeta, efectivo ni transferencia): con la zona
      // conocida, un cupón que lo deje así no se aplica. Sin zona el envío aún no se suma.
      if (zone && totals.total <= 0) {
        const message = 'Este cupón cubre todo el pedido. Agrega más productos para poder pagar';
        if (input.coupon.strict) {
          throw couponRejectionError({ ok: false, reason: 'covers_all', message });
        }
        couponError = message;
        discount = 0;
        waivedByCoupon = false;
        deliveryFee = delivery?.fee ?? 0;
        totals = computeOrderTotals(priced, { deliveryFee });
      } else {
        applied = {
          code: res.coupon.code,
          kind: res.coupon.kind,
          discount: res.coupon.kind === 'free_delivery' ? res.deliveryWaived : totals.discount,
          description: describeCoupon(res.coupon),
        };
      }
    }
  }

  totals.lines.forEach((l, i) => {
    Object.assign(lines[i]!, { gross: l.gross, discount: l.discount, net: l.net, itbis: l.itbis });
  });

  // El colchón de peso variable se calcula sobre el monto BRUTO de esas líneas: un descuento fijo
  // no baja al crecer el peso, así que el colchón sobre el neto se quedaría corto al empacar.
  const variableGross = totals.lines
    .filter((l) => l.variableWeight)
    .reduce((a, l) => a + l.gross, 0);

  return {
    lines,
    subtotal: totals.subtotal,
    discount: totals.discount,
    deliveryFee: totals.deliveryFee,
    itbis: totals.itbis,
    total: totals.total,
    authorizedAmount: authorizationAmount(
      { total: totals.total, variableWeightNet: variableGross },
      config.authBufferBps,
    ),
    zone: zone ? { id: zone.id, name: zone.name } : null,
    freeDelivery: (delivery?.free ?? false) || waivedByCoupon,
    missingForMinimum: delivery?.missingForMinimum ?? 0,
    missingForFreeDelivery: waivedByCoupon ? null : (delivery?.missingForFree ?? null),
    demo: config.demo,
    coupon: applied,
    couponError,
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
  /** Código de cupón tal como lo escribió la persona. Si no sirve, el pedido se RECHAZA. */
  couponCode?: string | null;
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
    // Con cupón, el perdedor choca antes con el uso que el ganador acaba de tomar (coupon_invalid).
    // (El índice único se detecta por SQLSTATE: el mensaje del driver trae el SQL, no el error.)
    const raced = isUniqueViolation(e) || (e instanceof DomainError && e.code === 'coupon_invalid');
    if (input.idempotencyKey && raced) {
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

    // Con cupón, la cotización bloquea su fila hasta el final de esta transacción: dos pedidos
    // simultáneos hacen cola y los límites de uso se respetan.
    const quote = await quoteOrder(
      ctx,
      {
        items: input.items,
        zone,
        coupon: input.couponCode
          ? { code: input.couponCode, userId: input.userId, strict: true }
          : undefined,
      },
      tx,
    );
    if (quote.missingForMinimum > 0) {
      throw new DomainError(
        'below_minimum',
        `El pedido mínimo para ${zone.name} es ${formatDOP(zone.minOrderCentavos)}. Te faltan ${formatDOP(quote.missingForMinimum)}.`,
        409,
        { missing: quote.missingForMinimum },
      );
    }

    if (input.paymentMethod === 'card' && !config.payments.cardProvider) {
      throw conflict('method_unavailable', 'El pago con tarjeta no está disponible por ahora');
    }
    if (input.paymentMethod === 'transfer' && !config.payments.transfer) {
      throw conflict(
        'method_unavailable',
        'El pago por transferencia no está disponible por ahora',
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
        couponCode: quote.coupon?.code ?? null,
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

    if (quote.coupon) {
      await recordRedemption(tx, {
        code: quote.coupon.code,
        userId: input.userId,
        orderId: order!.id,
        amount: quote.coupon.discount,
      });
    }

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

    if (ctx.hooks?.afterCreate) {
      const [created] = await tx.select().from(orders).where(eq(orders.id, order!.id));
      await ctx.hooks.afterCreate(tx, created!);
    }
    return order!.id;
  });

  // Quien crea el pedido es su dueño: ve su PIN de entrega apenas el pedido queda confirmado.
  return getOrder(ctx, orderId, { userId: input.userId });
}

// ───────────────────────── consulta ─────────────────────────

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;

export interface PaymentSummary {
  id: string;
  provider: string;
  method: PaymentMethod;
  status: PaymentStatus;
  amount: number;
  capturedAmount: number;
  refundedAmount: number;
  /** Dinero que hay que devolver al cliente y aún no se ha devuelto. */
  refundPending: number;
  failureReason: string | null;
  /** El cliente ya envió la referencia de su transferencia (sin exponer el detalle interno). */
  proofSubmitted: boolean;
  createdAt: Date;
}

export interface OrderDTO extends Omit<OrderRow, 'number'> {
  number: number;
  code: string;
  items: OrderItemRow[];
  payments: PaymentSummary[];
  /** Quién hizo el pedido (el repartidor y el personal necesitan contactarlo). */
  customer: { id: string; name: string; phone: string };
  timeline: (typeof orderEvents.$inferSelect)[];
  /** Estados a los que se puede pasar desde el actual (para el panel admin y el repartidor). */
  next: readonly OrderStatus[];
  /**
   * La entrega se cierra con el PIN del cliente. `deliveryPin` (heredado de la fila) solo trae el
   * valor en la vista del cliente dueño; para todos los demás es null (ver `deliveryFieldsFor`).
   */
  pinRequired: boolean;
  /** Intentos de PIN que le quedan al repartidor (0 = bloqueado); null si el pedido no usa PIN. */
  pinAttemptsLeft: number | null;
}

async function hydrate(db: Db, order: OrderRow, viewer: OrderViewer): Promise<OrderDTO> {
  const [items, timeline, paymentRows, customerRows] = await Promise.all([
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
    db
      .select({
        id: payments.id,
        provider: payments.provider,
        method: payments.method,
        status: payments.status,
        amount: payments.amount,
        capturedAmount: payments.capturedAmount,
        refundedAmount: payments.refundedAmount,
        refundPending: payments.refundPending,
        failureReason: payments.failureReason,
        raw: payments.raw,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.orderId, order.id))
      .orderBy(asc(payments.createdAt)),
    db
      .select({ id: users.id, name: users.name, phone: users.phone })
      .from(users)
      .where(eq(users.id, order.userId)),
  ]);
  return toOrderDTO(
    order,
    { items, timeline, payments: paymentRows, customer: customerRows[0] },
    viewer,
  );
}

/**
 * ÚNICO lugar donde se arma un `OrderDTO`. Recibe quién mira para decidir los campos sensibles
 * (el PIN de entrega): ningún listado ni ruta debe construir el DTO por su cuenta.
 */
export function toOrderDTO(
  order: OrderRow,
  parts: {
    items: OrderItemRow[];
    timeline: (typeof orderEvents.$inferSelect)[];
    payments: (Omit<PaymentSummary, 'proofSubmitted'> & { raw: unknown })[];
    customer: { id: string; name: string; phone: string } | undefined;
  },
  viewer: OrderViewer,
): OrderDTO {
  return {
    ...order,
    // La dirección siempre trae las coordenadas (null si el cliente no las dio) para el navegador del repartidor.
    address: {
      ...order.address,
      latitude: order.address.latitude ?? null,
      longitude: order.address.longitude ?? null,
    },
    ...deliveryFieldsFor(order, parts.timeline, viewer),
    code: formatOrderNumber(order.number),
    items: parts.items,
    customer: parts.customer ?? { id: order.userId, name: '', phone: '' },
    payments: parts.payments.map(({ raw, ...p }) => ({
      ...p,
      proofSubmitted: !!(raw as { proof?: unknown } | null)?.proof,
    })),
    timeline: timelineFor(parts.timeline, viewer),
    next: nextStatuses(order.status),
  };
}

/**
 * `scope.userId` = el cliente dueño mira su propio pedido (404 si es de otra persona) y es el
 * único que puede ver el PIN. `scope.viewer` = otra vista (el repartidor). Sin `scope` la vista es
 * interna (admin, personal, pagos): sin PIN, pero con el motivo de una entrega sin PIN.
 */
export async function getOrder(
  ctx: OrderContext,
  orderId: string,
  scope: { userId?: string; viewer?: OrderViewer } = {},
): Promise<OrderDTO> {
  const viewer: OrderViewer = scope.userId
    ? { role: 'customer', userId: scope.userId }
    : (scope.viewer ?? INTERNAL_VIEWER);
  const [order] = await ctx.db.select().from(orders).where(eq(orders.id, orderId));
  // 404 (no 403) para no revelar que el pedido existe.
  if (!order || (viewer.role === 'customer' && order.userId !== viewer.userId)) {
    throw notFound('Pedido');
  }
  return hydrate(ctx.db, order, viewer);
}

/** La respuesta de una acción se arma con la vista de quien la hizo, no con la interna. */
export function viewerForActor(actor: Actor): OrderViewer {
  if (actor.role === 'customer') return { role: 'customer', userId: actor.id ?? '' };
  return actor.role === 'driver' ? DRIVER_VIEWER : INTERNAL_VIEWER;
}

export async function listOrdersForUser(ctx: OrderContext, userId: string, limit = 30) {
  const rows = await ctx.db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
  return Promise.all(rows.map((o) => hydrate(ctx.db, o, { role: 'customer', userId })));
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
  return Promise.all(rows.map((o) => hydrate(ctx.db, o, INTERNAL_VIEWER)));
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
  /** Solo para 'delivered': el PIN del repartidor o el motivo del personal (ver `delivery.ts`). */
  delivery: DeliveryGateInput = {},
): Promise<OrderDTO> {
  let pinRejection: PinRejection | null = null as PinRejection | null;
  await ctx.db.transaction(async (tx) => {
    try {
      await transitionOrderInTx(ctx, tx, orderId, to, actor, note, delivery);
    } catch (e) {
      // Un PIN incorrecto rechaza la entrega, pero el intento fallido ya escrito debe quedar
      // guardado (es lo que cuenta hacia el bloqueo): se confirma la transacción y luego se lanza.
      if (!(e instanceof PinRejection)) throw e;
      pinRejection = e;
    }
  });
  if (pinRejection) throw pinRejection;
  return getOrder(ctx, orderId, { viewer: viewerForActor(actor) });
}

/** Igual que `transitionOrder`, pero dentro de una transacción ya abierta (la usan los pagos). */
export async function transitionOrderInTx(
  ctx: OrderContext,
  tx: Db,
  orderId: string,
  to: OrderStatus,
  actor: Actor,
  note = '',
  delivery: DeliveryGateInput = {},
): Promise<void> {
  const now = nowOf(ctx);
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

  await ctx.hooks?.beforeTransition?.(tx, order, to);

  const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  const patch: Partial<typeof orders.$inferInsert> = { status: to, updatedAt: now };

  if (to === 'confirmed') patch.reservationExpiresAt = null;

  if (to === 'out_for_delivery' && !order.driverId) {
    throw conflict('no_driver', 'Asigna un repartidor antes de enviar el pedido');
  }

  // Puerta de la entrega: va DESPUÉS de las reglas de dinero (cobro en efectivo exacto) y antes de
  // cualquier otra escritura, porque un PIN incorrecto debe guardar solo su intento fallido.
  let eventNote = note;
  if (to === 'delivered') {
    const gate = await applyDeliveryGate(tx, order, actor, delivery, now);
    Object.assign(patch, gate.patch);
    if (gate.note) eventNote = note ? `${gate.note}. ${note}` : gate.note;
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
    const finalLines = finals.map(({ item, finalQuantity }) => ({
      id: item.id,
      pricingUnit: item.pricingUnit,
      unitPrice: item.unitPrice,
      itbisBps: item.itbisBps,
      quantity: finalQuantity,
      variableWeight: item.variableWeight,
    }));
    // Cupón con peso real: el porcentaje se recalcula sobre el monto real; el fijo se mantiene.
    const finalDiscount = await finalDiscountForOrder(
      tx,
      order,
      finalLines.reduce((a, l) => a + lineGross(l), 0),
    );
    const totals = computeOrderTotals(finalLines, {
      discount: finalDiscount,
      deliveryFee: order.deliveryFee,
    });
    // El cliente solo autorizó hasta total + colchón: si el peso real lo supera, hay que ajustar.
    if (totals.total > order.authorizedAmount) {
      throw conflict(
        'overweight',
        `Con el peso real el pedido llega a ${formatDOP(totals.total)}, por encima de lo autorizado (${formatDOP(order.authorizedAmount)}). Ajusta las porciones.`,
        { finalTotal: totals.total, authorizedAmount: order.authorizedAmount },
      );
    }
    for (const [idx, { item, finalQuantity }] of finals.entries()) {
      const line = totals.lines[idx]!;
      await tx
        .update(orderItems)
        .set({ finalQuantity, finalLineTotal: line.net })
        .where(eq(orderItems.id, item.id));
    }
    patch.finalTotal = totals.total;
    patch.finalItbis = totals.itbis;
    await recordFinalDiscount(tx, order, totals.discount);

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

    // El cupón no se consumió: el uso se libera para los límites global y por persona.
    await releaseRedemption(tx, orderId);
  }

  if (to === 'delivered') patch.deliveredAt = now;

  await tx.update(orders).set(patch).where(eq(orders.id, orderId));
  await tx.insert(orderEvents).values({
    orderId,
    fromStatus: from,
    toStatus: to,
    actorId: actor.id,
    note: eventNote,
  });

  if (ctx.hooks?.afterTransition) {
    const [updated] = await tx.select().from(orders).where(eq(orders.id, orderId));
    await ctx.hooks.afterTransition(tx, updated!, from, to);
  }
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
