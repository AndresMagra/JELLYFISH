import {
  type OrderDTO,
  type OrderStatus,
  type PricedLineInput,
  type QuoteDTO,
  type QuoteLineDTO,
  LIMITS,
  assertTransition,
  authorizationAmount,
  computeOrderTotals,
  formatDOP,
  lineGross,
  nextStatuses,
} from '@jellyfish/shared';
import { type Ctx, stockOf } from './context';
import { describeCoupon, evaluateCoupon, finalDiscountForOrder } from './coupons';
import { publishable } from './catalog';
import { DemoError, conflict, forbidden, invalid, notFound } from './errors';
import type {
  AddressSnapshot,
  EventRec,
  ItemRec,
  LifecycleStage,
  OrderRec,
  PaymentRec,
  UserRec,
} from './types';
import { formatOrderNumber, iso, randomInt, randomUuid } from './util';
import { assertSlotAvailable, deliveryPricing, findZone, type ZoneRec } from './zones';

/** Estados en los que el cliente dueño ve su PIN (de la confirmación hasta la entrega). */
const PIN_VISIBLE: readonly OrderStatus[] = [
  'confirmed',
  'picking',
  'packed',
  'out_for_delivery',
  'delivery_failed',
];
const PIN_MAX_ATTEMPTS = 5;
/** Repartidor de la demostración (un solo id estable: el cliente nunca ve su nombre). */
export const DEMO_DRIVER_ID = '5a1e0f6e-7a3b-4c11-8d3e-2f4b9c0d1e77';
/** Persona del equipo que "prepara" los pedidos en la demostración (queda como autora de las etapas). */
export const DEMO_STAFF_ID = '2c7d8e41-9b0a-4f63-a5d2-6e1f3a8b0c94';

const HELD = ['captured', 'partially_refunded'] as const;
const isHeld = (p: PaymentRec) => (HELD as readonly string[]).includes(p.status);

/** Etapa automática que sigue a cada estado del ciclo simulado. */
const NEXT_STAGE: Partial<Record<OrderStatus, OrderStatus>> = {
  confirmed: 'picking',
  picking: 'packed',
  packed: 'out_for_delivery',
  out_for_delivery: 'delivered',
};

// ───────────────────────── cotización ─────────────────────────

export interface OrderItemInput {
  variantId: string;
  quantity: number;
}

function mergeItems(items: OrderItemInput[]): OrderItemInput[] {
  const map = new Map<string, number>();
  for (const i of items) map.set(i.variantId, (map.get(i.variantId) ?? 0) + i.quantity);
  return [...map.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export type QuoteResult = Omit<QuoteDTO, 'coverage'>;

/** Cupón que acompaña a la cotización: `strict` = al crear el pedido (rechaza en vez de avisar). */
export interface QuoteCouponInput {
  code: string;
  userId: string | null;
  strict?: boolean;
}

export function quoteOrder(
  ctx: Ctx,
  input: { items: OrderItemInput[]; zone?: ZoneRec | null; coupon?: QuoteCouponInput | undefined },
): QuoteResult {
  if (input.items.length === 0) throw invalid('El carrito está vacío');
  const items = mergeItems(input.items);

  const lines: QuoteLineDTO[] = [];
  const priced: PricedLineInput[] = [];
  for (const item of items) {
    const v = ctx.catalog.variantsById.get(item.variantId);
    const product = ctx.catalog.productOfVariant.get(item.variantId);
    if (!v || !product) {
      throw new DemoError('invalid_item', 'Un producto del carrito ya no existe', 400, item);
    }
    const label = v.variant ? `${product.name} ${v.variant}` : product.name;
    if (!publishable(v)) {
      throw new DemoError('unavailable', `${label} no está disponible por ahora`, 409, item);
    }
    const q = item.quantity;
    if (!Number.isSafeInteger(q) || q <= 0) throw invalid(`Cantidad inválida para ${label}`, item);

    if (v.pricingUnit === 'lb') {
      const min = v.minCentilb ?? 100;
      const step = v.stepCentilb ?? 50;
      if (q < min) throw invalid(`El mínimo de ${label} es ${min / 100} lb`, item);
      if (q % step !== 0) throw invalid(`${label} se vende en múltiplos de ${step / 100} lb`, item);
      if (q > LIMITS.maxCentilbPerLine) {
        throw invalid(`El máximo por pedido de ${label} es ${LIMITS.maxCentilbPerLine / 100} lb`, item);
      }
    } else if (q > LIMITS.maxUnitsPerLine) {
      throw invalid(`El máximo por pedido de ${label} es ${LIMITS.maxUnitsPerLine} unidades`, item);
    }

    const stock = stockOf(ctx, v.id);
    const available = stock.onHand - stock.reserved;
    if (available < q) {
      throw new DemoError(
        'out_of_stock',
        available > 0
          ? `Solo quedan ${v.pricingUnit === 'lb' ? `${available / 100} lb` : `${available} u.`} de ${label}`
          : `${label} está agotado`,
        409,
        { variantId: v.id, available },
      );
    }

    const itbisBps = v.itbisBps ?? 0;
    const variableWeight = v.variableWeight && v.pricingUnit === 'lb';
    priced.push({
      id: v.id,
      pricingUnit: v.pricingUnit,
      unitPrice: v.price,
      itbisBps,
      quantity: q,
      variableWeight,
    });
    lines.push({
      variantId: v.id,
      sku: v.sku,
      name: product.name,
      variant: v.variant,
      pricingUnit: v.pricingUnit,
      unitPrice: v.price,
      itbisBps,
      variableWeight,
      quantity: q,
      photo: v.photo,
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
  let applied: QuoteResult['coupon'] = null;
  let couponError: string | null = null;
  let deliveryFee = delivery?.fee ?? 0;
  let waivedByCoupon = false;
  let totals = computeOrderTotals(priced, { deliveryFee });

  if (input.coupon) {
    const res = evaluateCoupon(ctx, {
      rawCode: input.coupon.code,
      userId: input.coupon.userId,
      subtotal,
      deliveryFee: delivery ? delivery.fee : null,
    });
    if (!res.ok) {
      if (input.coupon.strict) throw couponRejectionError(res.reason, res.message);
      couponError = res.message;
    } else {
      waivedByCoupon = res.deliveryWaived > 0;
      if (waivedByCoupon) deliveryFee = 0;
      totals = computeOrderTotals(priced, { discount: res.discount, deliveryFee });
      // Un pedido de RD$ 0 no se puede cobrar: con la zona conocida, un cupón que lo deje así no se aplica.
      if (zone && totals.total <= 0) {
        const message = 'Este cupón cubre todo el pedido. Agrega más productos para poder pagar';
        if (input.coupon.strict) throw couponRejectionError('covers_all', message);
        couponError = message;
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
  const variableGross = totals.lines.filter((l) => l.variableWeight).reduce((a, l) => a + l.gross, 0);

  return {
    lines,
    subtotal: totals.subtotal,
    discount: totals.discount,
    deliveryFee: totals.deliveryFee,
    itbis: totals.itbis,
    total: totals.total,
    authorizedAmount: authorizationAmount(
      { total: totals.total, variableWeightNet: variableGross },
      ctx.cfg.authBufferBps,
    ),
    zone: zone ? { id: zone.id, name: zone.name } : null,
    freeDelivery: (delivery?.free ?? false) || waivedByCoupon,
    missingForMinimum: delivery?.missingForMinimum ?? 0,
    missingForFreeDelivery: waivedByCoupon ? null : (delivery?.missingForFree ?? null),
    demo: true,
    coupon: applied,
    couponError,
  };
}

/** Error que ve la app al CREAR un pedido con un cupón que no sirve (la cotización solo avisa). */
function couponRejectionError(reason: string, message: string): DemoError {
  return new DemoError('coupon_invalid', message, 409, { reason });
}

// ───────────────────────── crear pedido ─────────────────────────

export interface CreateOrderInput {
  user: UserRec;
  items: OrderItemInput[];
  address: AddressSnapshot;
  slotStart: Date;
  paymentMethod: 'card' | 'cash' | 'transfer';
  notes?: string | undefined;
  substitutionPolicy?: 'contact' | 'substitute' | 'refund' | undefined;
  idempotencyKey?: string | undefined;
  /** Código de cupón tal como lo escribió la persona. Si no sirve, el pedido se RECHAZA. */
  couponCode?: string | undefined;
}

function newEvent(
  ctx: Ctx,
  order: OrderRec,
  from: OrderStatus | null,
  to: OrderStatus,
  at: number,
  actorId: string | null,
  note: string,
): void {
  const e: EventRec = {
    id: randomUuid(ctx.rng),
    orderId: order.id,
    fromStatus: from,
    toStatus: to,
    actorId,
    note,
    createdAt: iso(at),
  };
  order.timeline.push(e);
}

export function createOrder(ctx: Ctx, input: CreateOrderInput): OrderRec {
  const { state } = ctx;
  const now = ctx.now();

  if (input.idempotencyKey) {
    const existing = state.orders.find(
      (o) => o.userId === input.user.id && o.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
  }

  const zone = findZone(ctx.zone, input.address);
  if (!zone) {
    throw new DemoError(
      'out_of_zone',
      `Aún no entregamos en ${input.address.sector || input.address.city}. Pronto llegaremos.`,
      409,
    );
  }

  const slot = assertSlotAvailable(state.orders, input.slotStart.getTime(), now);

  const quote = quoteOrder(ctx, {
    items: input.items,
    zone,
    coupon: input.couponCode
      ? { code: input.couponCode, userId: input.user.id, strict: true }
      : undefined,
  });
  if (quote.missingForMinimum > 0) {
    throw new DemoError(
      'below_minimum',
      `El pedido mínimo para ${zone.name} es ${formatDOP(zone.minOrderCentavos)}. Te faltan ${formatDOP(quote.missingForMinimum)}.`,
      409,
      { missing: quote.missingForMinimum },
    );
  }

  const instantlyConfirmed = input.paymentMethod === 'cash';
  const holdMinutes =
    input.paymentMethod === 'transfer'
      ? ctx.cfg.reservationMinutesTransfer
      : ctx.cfg.reservationMinutesCard;
  const status: OrderStatus = instantlyConfirmed ? 'confirmed' : 'pending_payment';

  const orderId = randomUuid(ctx.rng);
  const number = state.orderCounter++;
  const order: OrderRec = {
    id: orderId,
    number,
    userId: input.user.id,
    status,
    paymentMethod: input.paymentMethod,
    substitutionPolicy: input.substitutionPolicy ?? 'contact',
    zoneId: zone.id,
    address: input.address,
    slotStart: iso(slot.start),
    slotEnd: iso(slot.end),
    notes: input.notes ?? '',
    subtotal: quote.subtotal,
    discount: quote.discount,
    deliveryFee: quote.deliveryFee,
    itbis: quote.itbis,
    total: quote.total,
    authorizedAmount: quote.authorizedAmount,
    finalTotal: null,
    finalItbis: null,
    reservationExpiresAt: instantlyConfirmed ? null : iso(now + holdMinutes * 60_000),
    driverId: null,
    cancelReason: null,
    idempotencyKey: input.idempotencyKey ?? null,
    couponCode: quote.coupon?.code ?? null,
    deliveryPin: String(randomInt(ctx.rng, 10_000)).padStart(4, '0'),
    pinVerifiedAt: null,
    createdAt: iso(now),
    updatedAt: iso(now),
    deliveredAt: null,
    stageEnteredAt: now,
    items: [],
    payments: [],
    timeline: [],
  };

  order.items = quote.lines.map(
    (l): ItemRec => ({
      id: randomUuid(ctx.rng),
      orderId,
      variantId: l.variantId,
      sku: l.sku,
      name: l.name,
      variant: l.variant,
      pricingUnit: l.pricingUnit,
      unitPrice: l.unitPrice,
      itbisBps: l.itbisBps,
      variableWeight: l.variableWeight,
      quantity: l.quantity,
      finalQuantity: null,
      lineTotal: l.net,
      finalLineTotal: null,
    }),
  );

  // Reserva de existencias (orden estable por id, como el API).
  const toReserve = [...quote.lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
  for (const l of toReserve) {
    const stock = stockOf(ctx, l.variantId);
    if (stock.onHand - stock.reserved < l.quantity) {
      throw new DemoError('out_of_stock', `${l.name} se agotó mientras hacías el pedido`, 409, {
        variantId: l.variantId,
      });
    }
    stock.reserved += l.quantity;
  }

  newEvent(
    ctx,
    order,
    null,
    status,
    now,
    input.user.id,
    instantlyConfirmed ? 'Pedido creado (pago contra entrega)' : 'Pedido creado',
  );

  if (order.paymentMethod === 'cash' || order.paymentMethod === 'transfer') {
    order.payments.push(newPayment(ctx, order, order.paymentMethod, order.paymentMethod, now));
  }
  state.orders.push(order);
  return order;
}

function newPayment(
  ctx: Ctx,
  order: OrderRec,
  provider: string,
  method: PaymentRec['method'],
  at: number,
): PaymentRec {
  return {
    id: randomUuid(ctx.rng),
    orderId: order.id,
    provider,
    method,
    status: 'pending',
    amount: order.total,
    capturedAmount: 0,
    refundedAmount: 0,
    refundPending: 0,
    failureReason: null,
    providerRef: null,
    proof: null,
    settleAt: null,
    createdAt: iso(at),
    updatedAt: iso(at),
  };
}

// ───────────────────────── consulta ─────────────────────────

/** Lo que el API real devuelve además de `OrderDTO` (filas completas de la base de datos). */
export type OrderJson = OrderDTO & {
  userId: string;
  zoneId: string;
  idempotencyKey: string | null;
  couponCode: string | null;
  updatedAt: string;
};

export function toOrderDTO(order: OrderRec, user: UserRec | undefined): OrderJson {
  const hasPin = order.deliveryPin !== '';
  return {
    id: order.id,
    number: order.number,
    userId: order.userId,
    status: order.status,
    paymentMethod: order.paymentMethod,
    substitutionPolicy: order.substitutionPolicy,
    zoneId: order.zoneId,
    address: {
      label: order.address.label,
      line1: order.address.line1,
      reference: order.address.reference,
      sector: order.address.sector,
      city: order.address.city,
      latitude: order.address.latitude ?? null,
      longitude: order.address.longitude ?? null,
      contactPhone: order.address.contactPhone,
    },
    slotStart: order.slotStart,
    slotEnd: order.slotEnd,
    notes: order.notes,
    subtotal: order.subtotal,
    discount: order.discount,
    deliveryFee: order.deliveryFee,
    itbis: order.itbis,
    total: order.total,
    authorizedAmount: order.authorizedAmount,
    finalTotal: order.finalTotal,
    finalItbis: order.finalItbis,
    reservationExpiresAt: order.reservationExpiresAt,
    driverId: order.driverId,
    cancelReason: order.cancelReason,
    idempotencyKey: order.idempotencyKey,
    couponCode: order.couponCode,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    deliveredAt: order.deliveredAt,
    deliveryPin: PIN_VISIBLE.includes(order.status) ? order.deliveryPin : null,
    pinRequired: hasPin,
    pinAttemptsLeft: hasPin ? PIN_MAX_ATTEMPTS : null,
    pinVerifiedAt: order.pinVerifiedAt,
    pinOverrideReason: null,
    code: formatOrderNumber(order.number),
    items: [...order.items]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((i) => ({ ...i })),
    customer: { id: order.userId, name: user?.name ?? '', phone: user?.phone ?? '' },
    payments: order.payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      method: p.method,
      status: p.status,
      amount: p.amount,
      capturedAmount: p.capturedAmount,
      refundedAmount: p.refundedAmount,
      refundPending: p.refundPending,
      failureReason: p.failureReason,
      proofSubmitted: p.proof !== null,
      createdAt: p.createdAt,
    })),
    timeline: order.timeline.map((e) => ({ ...e })),
    next: [...nextStatuses(order.status)],
  };
}

export function findOwnOrder(ctx: Ctx, orderId: string, userId: string): OrderRec {
  const order = ctx.state.orders.find((o) => o.id === orderId);
  // 404 (no 403) para no revelar que el pedido existe.
  if (!order || order.userId !== userId) throw notFound('Pedido');
  return order;
}

export function listOrdersForUser(ctx: Ctx, userId: string, limit = 30): OrderRec[] {
  return ctx.state.orders
    .filter((o) => o.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.number - a.number))
    .slice(0, limit);
}

// ───────────────────────── transiciones ─────────────────────────

interface Actor {
  id: string | null;
  role: 'customer' | 'system' | 'staff' | 'driver';
}

const SYSTEM: Actor = { id: null, role: 'system' };
const STAFF: Actor = { id: DEMO_STAFF_ID, role: 'staff' };
const DRIVER: Actor = { id: DEMO_DRIVER_ID, role: 'driver' };

/**
 * Cambia el estado de un pedido en el instante `at` con las mismas reglas de dinero e inventario
 * del API: pesar y empacar, devolver lo cobrado al cancelar, cobrar en efectivo al entregar.
 */
function applyTransition(
  ctx: Ctx,
  order: OrderRec,
  to: OrderStatus,
  at: number,
  actor: Actor,
  note = '',
): void {
  const from = order.status;
  try {
    assertTransition(from, to);
  } catch (e) {
    throw conflict('invalid_transition', (e as Error).message);
  }

  if (to === 'confirmed') order.reservationExpiresAt = null;

  if (to === 'picking') weighItems(ctx, order);

  if (to === 'packed') {
    pack(ctx, order);
    order.driverId = order.driverId ?? DEMO_DRIVER_ID;
  }

  if (to === 'cancelled') {
    order.cancelReason = note || null;
    const sorted = [...order.items].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
    if (from === 'packed') {
      // Ya descontado del inventario: vuelve al congelador porque aún no salió.
      for (const i of sorted) stockOf(ctx, i.variantId).onHand += i.finalQuantity ?? i.quantity;
    } else if (from !== 'delivery_failed') {
      for (const i of sorted) {
        const s = stockOf(ctx, i.variantId);
        s.reserved = Math.max(0, s.reserved - i.quantity);
      }
    }
  }

  let eventNote = note;
  if (to === 'delivered') {
    order.deliveredAt = iso(at);
    order.pinVerifiedAt = iso(at);
    eventNote = note ? `Entrega confirmada con el PIN del cliente. ${note}` : 'Entrega confirmada con el PIN del cliente';
    // El efectivo se cobra al entregar (el repartidor lo registra antes de cerrar la entrega).
    for (const p of order.payments) {
      if (p.method === 'cash' && p.status === 'pending') {
        const due = order.finalTotal ?? order.total;
        p.status = 'captured';
        p.amount = due;
        p.capturedAmount = due;
        p.updatedAt = iso(at);
      }
    }
  }

  order.status = to;
  order.updatedAt = iso(at);
  order.stageEnteredAt = at;
  newEvent(ctx, order, from, to, at, actor.id, eventNote);

  paymentsAfterTransition(order, to, at);
}

/** Pesa en la báscula: el peso real de lo que se vende por libra varía un poco del pedido. */
function weighItems(ctx: Ctx, order: OrderRec): void {
  for (const item of order.items) {
    if (item.pricingUnit !== 'lb' || !item.variableWeight || item.finalQuantity !== null) continue;
    // Entre 95 % y 106 %: nunca pasa del colchón de pre-autorización (10 %).
    const factor = 0.95 + ctx.rng() * 0.11;
    const finalQuantity = Math.max(5, Math.round((item.quantity * factor) / 5) * 5);
    item.finalQuantity = finalQuantity;
    item.finalLineTotal = lineGross({
      id: item.id,
      pricingUnit: 'lb',
      unitPrice: item.unitPrice,
      itbisBps: item.itbisBps,
      quantity: finalQuantity,
      variableWeight: true,
    });
  }
}

function pack(ctx: Ctx, order: OrderRec): void {
  const finals = order.items.map((item) => ({ item, finalQuantity: item.finalQuantity ?? item.quantity }));
  const totalsFor = () => {
    const lines = finals.map(({ item, finalQuantity }) => ({
      id: item.id,
      pricingUnit: item.pricingUnit,
      unitPrice: item.unitPrice,
      itbisBps: item.itbisBps,
      quantity: finalQuantity,
      variableWeight: item.variableWeight,
    }));
    // Cupón con peso real: el porcentaje se recalcula sobre el monto real; el fijo se mantiene.
    const discount = finalDiscountForOrder(
      ctx,
      order,
      lines.reduce((a, l) => a + lineGross(l), 0),
    );
    return computeOrderTotals(lines, { discount, deliveryFee: order.deliveryFee });
  };
  let totals = totalsFor();
  if (totals.total > order.authorizedAmount) {
    // Nunca se cobra por encima de lo autorizado: se empaca lo pedido.
    for (const f of finals) f.finalQuantity = f.item.quantity;
    totals = totalsFor();
  }
  finals.forEach(({ item, finalQuantity }, idx) => {
    item.finalQuantity = finalQuantity;
    item.finalLineTotal = totals.lines[idx]!.net;
  });
  order.finalTotal = totals.total;
  order.finalItbis = totals.itbis;

  const sorted = [...finals].sort((a, b) => (a.item.variantId < b.item.variantId ? -1 : 1));
  for (const { item, finalQuantity } of sorted) {
    const s = stockOf(ctx, item.variantId);
    s.onHand = Math.max(0, s.onHand - finalQuantity);
    s.reserved = Math.max(0, s.reserved - item.quantity);
  }
}

/** Reglas de dinero que acompañan a cada cambio de estado (`paymentHooks().afterTransition`). */
function paymentsAfterTransition(order: OrderRec, to: OrderStatus, at: number): void {
  if (to === 'packed' && order.finalTotal !== null) {
    for (const p of order.payments) {
      // En efectivo se cobra el total real, no el estimado.
      if (p.method === 'cash' && p.status === 'pending') {
        p.amount = order.finalTotal;
        p.updatedAt = iso(at);
      }
    }
    // Prepago: si el peso real cuesta menos que lo cobrado, se devuelve la diferencia.
    const prepaid = order.payments.filter((p) => p.method !== 'cash' && isHeld(p));
    const held = prepaid.reduce((a, p) => a + p.capturedAmount - p.refundedAmount - p.refundPending, 0);
    const excess = held - order.finalTotal;
    if (excess > 0 && prepaid[0]) {
      prepaid[0].refundPending += excess;
      prepaid[0].updatedAt = iso(at);
    }
  }

  if (to === 'cancelled') {
    for (const p of order.payments) {
      if (p.status === 'pending') {
        p.status = 'voided';
        p.failureReason = p.failureReason ?? 'order_cancelled';
        p.settleAt = null;
        p.updatedAt = iso(at);
      } else if (isHeld(p)) {
        // Lo cobrado y no devuelto vuelve completo al cliente.
        p.refundPending = p.capturedAmount - p.refundedAmount;
        p.updatedAt = iso(at);
      }
    }
  }
}

// ───────────────────────── cancelar ─────────────────────────

export function cancelOrder(ctx: Ctx, user: UserRec, orderId: string, reason: string): OrderRec {
  const order = findOwnOrder(ctx, orderId, user.id);
  if (order.status !== 'pending_payment' && order.status !== 'confirmed') {
    // Mismo orden que el API: primero el permiso del cliente, luego la validez de la transición.
    throw forbidden('Solo puedes cancelar un pedido que aún no empezamos a preparar');
  }
  applyTransition(ctx, order, 'cancelled', ctx.now(), { id: user.id, role: 'customer' }, reason);
  return order;
}

// ───────────────────────── pagos ─────────────────────────

export function startCardPayment(
  ctx: Ctx,
  user: UserRec,
  orderId: string,
): { payment: PaymentRec; expiresAt: number } {
  const now = ctx.now();
  const order = findOwnOrder(ctx, orderId, user.id);
  if (order.paymentMethod !== 'card') {
    throw conflict('wrong_method', 'Este pedido no es de pago con tarjeta');
  }
  if (order.status !== 'pending_payment') {
    throw conflict('not_payable', 'Este pedido ya no está esperando pago');
  }
  if (order.reservationExpiresAt && Date.parse(order.reservationExpiresAt) <= now) {
    throw conflict('expired', 'Tu reserva venció. Haz el pedido de nuevo para asegurar tus productos.');
  }
  if (order.payments.some(isHeld)) throw conflict('already_paid', 'Este pedido ya fue pagado');

  const payment = newPayment(ctx, order, 'mock', 'card', now);
  // El banco simulado aprueba el pago solo, unos segundos después.
  payment.settleAt = now + ctx.cfg.paymentApproveMs;
  order.payments.push(payment);
  return { payment, expiresAt: now + 10 * 60_000 };
}

export function submitTransferProof(
  ctx: Ctx,
  user: UserRec,
  orderId: string,
  proof: { reference: string; note?: string | undefined },
): OrderRec {
  const now = ctx.now();
  const order = findOwnOrder(ctx, orderId, user.id);
  if (order.paymentMethod !== 'transfer') {
    throw conflict('wrong_method', 'Este pedido no es de transferencia');
  }
  if (order.status !== 'pending_payment') {
    throw conflict('not_payable', 'Este pedido ya no está esperando pago');
  }
  const payment = order.payments.find((p) => p.method === 'transfer');
  if (!payment) throw notFound('Pago');
  payment.proof = { reference: proof.reference, note: proof.note ?? '', submittedAt: iso(now) };
  payment.updatedAt = iso(now);
  // Nadie del equipo verifica en la demostración: el banco simulado "confirma" la transferencia.
  payment.settleAt = payment.settleAt ?? now + ctx.cfg.transferVerifyMs;
  return order;
}

/** El banco (o la verificación de la transferencia) simulado resuelve un pago pendiente. */
function settlePayment(ctx: Ctx, order: OrderRec, payment: PaymentRec, at: number): void {
  payment.settleAt = null;
  payment.status = 'captured';
  payment.capturedAmount = payment.amount;
  payment.updatedAt = iso(at);
  payment.providerRef =
    payment.method === 'card'
      ? `DEMO-${order.number}-${payment.id.slice(0, 6)}`
      : (payment.proof?.reference ?? null);
  const note =
    payment.method === 'card'
      ? 'Pago con tarjeta aprobado'
      : `Pago confirmado manualmente (${payment.proof?.reference ?? ''})`;
  if (order.status === 'pending_payment') {
    // La tarjeta la confirma el sistema; la transferencia, quien la verifica en el panel.
    applyTransition(ctx, order, 'confirmed', at, payment.method === 'card' ? SYSTEM : STAFF, note);
  } else {
    // El dinero ya se movió pero el pedido no esperaba pago: queda por devolver.
    payment.failureReason = 'order_not_active';
    payment.refundPending = payment.capturedAmount;
  }
}

// ───────────────────────── el tiempo pasa ─────────────────────────

/**
 * Pone al día todos los pedidos: aplica, en el instante exacto en que tocaban, las etapas y los
 * pagos que ya vencieron. Se llama antes de cada petición, así que el ciclo sigue avanzando aunque
 * la página haya estado cerrada, y las pruebas lo gobiernan con un reloj falso.
 */
export function advanceAll(ctx: Ctx): void {
  const now = ctx.now();
  for (const order of ctx.state.orders) advanceOrder(ctx, order, now);
}

function advanceOrder(ctx: Ctx, order: OrderRec, now: number): void {
  for (let guard = 0; guard < 50; guard++) {
    if (order.status === 'pending_payment') {
      const pending = order.payments
        .filter((p) => p.status === 'pending' && p.settleAt !== null)
        .sort((a, b) => a.settleAt! - b.settleAt!)[0];
      const settleAt = pending?.settleAt ?? Infinity;
      const expiry = order.reservationExpiresAt ? Date.parse(order.reservationExpiresAt) : Infinity;
      const next = Math.min(settleAt, expiry);
      if (next > now) return;
      if (pending && settleAt <= expiry) settlePayment(ctx, order, pending, settleAt);
      else applyTransition(ctx, order, 'cancelled', expiry, SYSTEM, 'Reserva vencida sin pago');
      continue;
    }
    const to = NEXT_STAGE[order.status];
    if (!to) return;
    const stage = ctx.cfg.stageMs[order.status as LifecycleStage];
    const due = order.stageEnteredAt + stage;
    if (due > now) return;
    // Igual que en el API real: el personal prepara y despacha; el repartidor entrega.
    applyTransition(ctx, order, to, due, to === 'delivered' ? DRIVER : STAFF);
  }
}
