import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  LIMITS,
  OUTSIDE_DR_MESSAGE,
  type OrderStatus,
  type ReorderDTO,
  type ReorderLineDTO,
  type TrackingDTO,
  formatLb,
  isInDominicanRepublic,
} from '@jellyfish/shared';
import { and, asc, count, eq, like, lte, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { driverLocations, orderEvents, orderItems, orders, products, variants } from '../db/schema';
import { DomainError, forbidden, invalid, notFound } from '../errors';
import { formatOrderNumber } from '../text';
import { variantBlockers } from './catalog';
// Solo tipos: `orders.ts` importa este módulo, así que aquí no puede haber imports de valores de allá.
import type { Actor, OrderContext, OrderHooks, OrderRow } from './orders';

const nowOf = (ctx: OrderContext) => (ctx.now ?? (() => new Date()))();

// ───────────────────────── PIN de entrega ─────────────────────────

export const PIN_LENGTH = 4;
/** Intentos fallidos por pedido antes de bloquearlo para el repartidor. */
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_OVERRIDE_MIN_CHARS = 8;
/** Estados en los que el cliente dueño ve su PIN (de la confirmación hasta la entrega). */
export const PIN_VISIBLE_STATUSES: readonly OrderStatus[] = [
  'confirmed',
  'picking',
  'packed',
  'out_for_delivery',
  'delivery_failed',
];

/**
 * Los intentos fallidos se guardan como eventos del pedido con estado de origen = destino (una
 * transición real nunca lo es). Así el conteo es duradero, vale entre reinicios y entre varias
 * instancias del API, y deja constancia para el administrador sin guardar el PIN que se tecleó.
 */
const PIN_FAILED_NOTE = 'PIN incorrecto';
/** Nota del evento de una entrega sin PIN; detrás va el motivo interno que escribió el personal. */
const PIN_OVERRIDE_NOTE = 'Entrega sin PIN autorizada';
/** Lo que ven el cliente y el repartidor en lugar de esa nota. */
export const PIN_OVERRIDE_PUBLIC_NOTE = 'Entrega confirmada por administración';

export function generateDeliveryPin(): string {
  return String(randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
}

function pinMatches(candidate: string, actual: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  // Mismo largo siempre (4 dígitos validados): la comparación toma el mismo tiempo acierte o no.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isPinFailureEvent(e: {
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string;
}): boolean {
  return e.fromStatus !== null && e.fromStatus === e.toStatus && e.note.startsWith(PIN_FAILED_NOTE);
}

export function isPinOverrideEvent(e: { toStatus: OrderStatus; note: string }): boolean {
  return e.toStatus === 'delivered' && e.note.startsWith(`${PIN_OVERRIDE_NOTE}:`);
}

/**
 * Quién mira el pedido. Lo que no se pide expresamente como cliente dueño o como repartidor es
 * vista interna (personal y administrador), la única que ve los motivos internos.
 */
export type OrderViewer =
  { role: 'customer'; userId: string } | { role: 'driver' } | { role: 'internal' };
export const INTERNAL_VIEWER: OrderViewer = { role: 'internal' };
export const DRIVER_VIEWER: OrderViewer = { role: 'driver' };

/**
 * Historial que puede ver cada quien. El evento de una entrega sin PIN lleva el motivo interno (y la
 * nota que el personal le sumó): solo la vista interna lo lee, los demás ven un texto neutro.
 */
export function timelineFor<T extends { toStatus: OrderStatus; note: string }>(
  timeline: T[],
  viewer: OrderViewer,
): T[] {
  if (viewer.role === 'internal') return timeline;
  return timeline.map((e) =>
    isPinOverrideEvent(e) ? { ...e, note: PIN_OVERRIDE_PUBLIC_NOTE } : e,
  );
}

/**
 * Campos del PIN que viajan en el DTO del pedido. Es el ÚNICO lugar que decide quién ve el PIN:
 * solo el cliente dueño y solo mientras el pedido está por entregarse.
 */
export function deliveryFieldsFor(
  order: Pick<
    OrderRow,
    'userId' | 'status' | 'deliveryPin' | 'pinVerifiedAt' | 'pinOverrideReason'
  >,
  timeline: { fromStatus: OrderStatus | null; toStatus: OrderStatus; note: string }[],
  viewer: OrderViewer,
) {
  const isOwner = viewer.role === 'customer' && viewer.userId === order.userId;
  const hasPin = order.deliveryPin !== null;
  const failures = timeline.filter(isPinFailureEvent).length;
  return {
    deliveryPin: isOwner && PIN_VISIBLE_STATUSES.includes(order.status) ? order.deliveryPin : null,
    pinRequired: hasPin,
    pinAttemptsLeft: hasPin ? Math.max(0, PIN_MAX_ATTEMPTS - failures) : null,
    pinVerifiedAt: order.pinVerifiedAt,
    // El motivo de una entrega sin PIN es una nota interna: ni el cliente ni el repartidor la necesitan.
    pinOverrideReason: viewer.role === 'internal' ? order.pinOverrideReason : null,
  };
}

/** Entrada de la transición a 'delivered'. */
export interface DeliveryGateInput {
  /** Lo que el repartidor teclea (los 4 dígitos que le dice el cliente). */
  pin?: string;
  /** Personal/administrador: por qué se entrega sin PIN. */
  pinOverrideReason?: string;
}

/**
 * Rechazo del PIN que debe CONSERVAR lo escrito en la transacción (el intento fallido) aunque la
 * transición no se aplique. `transitionOrder` lo reconoce, confirma y recién entonces lo lanza.
 */
export class PinRejection extends DomainError {}

export interface DeliveryGateResult {
  patch: Partial<typeof orders.$inferInsert>;
  /** Texto para el historial del pedido. */
  note: string;
}

async function countPinFailures(tx: Db, orderId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(orderEvents)
    .where(
      and(
        eq(orderEvents.orderId, orderId),
        eq(orderEvents.fromStatus, orderEvents.toStatus),
        like(orderEvents.note, `${PIN_FAILED_NOTE}%`),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Puerta de la entrega: se aplica DENTRO de la transacción de la transición, con el pedido ya
 * bloqueado (`FOR UPDATE`), así que dos intentos simultáneos no pueden saltarse el límite.
 *  - Pedido sin PIN (anterior a esta función): pasa.
 *  - Repartidor: debe acertar el PIN; tras 5 fallos el pedido queda bloqueado para él.
 *  - Personal/administrador: debe dar un motivo (≥ 8 caracteres) y queda registrado.
 */
export async function applyDeliveryGate(
  tx: Db,
  order: OrderRow,
  actor: Actor,
  input: DeliveryGateInput,
  now: Date,
): Promise<DeliveryGateResult> {
  if (order.deliveryPin === null) return { patch: {}, note: '' };

  if (actor.role === 'admin' || actor.role === 'staff') {
    const reason = (input.pinOverrideReason ?? '').trim();
    if (reason.length < PIN_OVERRIDE_MIN_CHARS) {
      throw new DomainError(
        'pin_override_required',
        `Este pedido tiene PIN de entrega. Para marcarlo entregado sin PIN escribe el motivo (mínimo ${PIN_OVERRIDE_MIN_CHARS} caracteres).`,
        400,
      );
    }
    return {
      patch: { pinOverrideReason: reason },
      note: `${PIN_OVERRIDE_NOTE}: ${reason}`,
    };
  }
  if (actor.role !== 'driver') {
    throw forbidden('Solo el repartidor o el personal pueden confirmar la entrega');
  }

  const failures = await countPinFailures(tx, order.id);
  if (failures >= PIN_MAX_ATTEMPTS) throw lockedError();

  const pin = input.pin;
  if (pin === undefined || pin === '') {
    throw new DomainError(
      'pin_required',
      'Pídele al cliente el PIN de 4 dígitos para confirmar la entrega.',
      400,
    );
  }
  // Un PIN mal escrito (letras, 3 dígitos) no cuenta como intento: no es una adivinanza.
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) throw invalid('El PIN son 4 dígitos');

  if (!pinMatches(pin, order.deliveryPin)) {
    const used = failures + 1;
    await tx.insert(orderEvents).values({
      orderId: order.id,
      fromStatus: order.status,
      toStatus: order.status,
      actorId: actor.id,
      note: `${PIN_FAILED_NOTE} (intento ${used} de ${PIN_MAX_ATTEMPTS})`,
    });
    const left = PIN_MAX_ATTEMPTS - used;
    if (left <= 0) throw lockedError();
    throw new PinRejection(
      'pin_incorrect',
      `PIN incorrecto. Te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`,
      409,
      { attemptsLeft: left },
    );
  }
  return { patch: { pinVerifiedAt: now }, note: 'Entrega confirmada con el PIN del cliente' };
}

function lockedError(): PinRejection {
  return new PinRejection(
    'pin_locked',
    'Demasiados intentos con el PIN: el pedido quedó bloqueado. Pídele a administración que confirme la entrega.',
    423,
    { attemptsLeft: 0 },
  );
}

// ───────────────────────── enganches con los pedidos ─────────────────────────

/** Borra la posición del repartidor cuando ya no hay una entrega suya en curso (privacidad). */
async function clearDriverLocation(tx: Db, order: OrderRow): Promise<void> {
  if (!order.driverId) return;
  // Si la última posición apuntaba a este pedido, deja de apuntar a un pedido terminado.
  await tx
    .update(driverLocations)
    .set({ orderId: null })
    .where(
      and(eq(driverLocations.driverId, order.driverId), eq(driverLocations.orderId, order.id)),
    );
  // Con otra entrega suya aún en camino, ese cliente sigue esperando: la posición se queda.
  const [stillOut] = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.driverId, order.driverId),
        eq(orders.status, 'out_for_delivery'),
        ne(orders.id, order.id),
      ),
    )
    .limit(1);
  if (!stillOut) {
    await tx.delete(driverLocations).where(eq(driverLocations.driverId, order.driverId));
  }
}

export function deliveryHooks(): OrderHooks {
  return {
    afterCreate: async (tx, order) => {
      if (order.deliveryPin) return;
      await tx
        .update(orders)
        .set({ deliveryPin: generateDeliveryPin() })
        .where(eq(orders.id, order.id));
    },
    afterTransition: async (tx, order, _from, to) => {
      if (to === 'delivered' || to === 'delivery_failed' || to === 'cancelled') {
        await clearDriverLocation(tx, order);
      }
    },
  };
}

// ───────────────────────── ubicación del repartidor ─────────────────────────

/** Una actualización por repartidor cada 4 segundos. */
export const LOCATION_MIN_INTERVAL_MS = 4_000;
/** Una posición más vieja que esto ya no se le muestra al cliente. */
export const TRACKING_MAX_AGE_MS = 3 * 60_000;
const MAX_ACCURACY_M = 100_000;
/** Con el pedido en estos estados la posición ya no se asocia a él. */
const FINISHED: readonly OrderStatus[] = ['delivered', 'delivery_failed', 'cancelled', 'refunded'];

export interface DriverLocationInput {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
  orderId?: string | null;
}

export async function recordDriverLocation(
  ctx: OrderContext,
  driverId: string,
  input: DriverLocationInput,
): Promise<{ updatedAt: Date }> {
  if (!isInDominicanRepublic(input.latitude, input.longitude)) {
    throw invalid(OUTSIDE_DR_MESSAGE);
  }
  const accuracy = input.accuracyM ?? null;
  if (
    accuracy !== null &&
    (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_M)
  ) {
    throw invalid('La precisión del GPS no es válida');
  }

  let orderId: string | null = null;
  if (input.orderId) {
    const [order] = await ctx.db
      .select({ id: orders.id, driverId: orders.driverId, status: orders.status })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!order) throw notFound('Pedido');
    if (order.driverId !== driverId) throw forbidden('Este pedido no está asignado a ti');
    // Un ping que llega justo después de entregar es normal: se guarda, pero sin apuntar al pedido.
    orderId = FINISHED.includes(order.status) ? null : order.id;
  }

  const now = nowOf(ctx);
  const values = {
    driverId,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyM: accuracy,
    orderId,
    updatedAt: now,
  };
  // Un solo INSERT ... ON CONFLICT con condición: la frecuencia se controla de forma atómica, sin
  // carreras entre dos peticiones del mismo repartidor y sin depender de memoria del proceso.
  const rows = await ctx.db
    .insert(driverLocations)
    .values(values)
    .onConflictDoUpdate({
      target: driverLocations.driverId,
      set: {
        latitude: values.latitude,
        longitude: values.longitude,
        accuracyM: values.accuracyM,
        orderId: values.orderId,
        updatedAt: values.updatedAt,
      },
      setWhere: lte(driverLocations.updatedAt, new Date(now.getTime() - LOCATION_MIN_INTERVAL_MS)),
    })
    .returning({ updatedAt: driverLocations.updatedAt });
  if (rows.length === 0) {
    throw new DomainError(
      'rate_limited',
      'Estás enviando la ubicación muy seguido. Espera unos segundos.',
      429,
      { retryAfterMs: LOCATION_MIN_INTERVAL_MS },
    );
  }
  return { updatedAt: rows[0]!.updatedAt };
}

/** Dónde va el repartidor, solo para el cliente dueño y solo mientras su pedido va en camino. */
export async function getTracking(
  ctx: OrderContext,
  orderId: string,
  userId: string,
): Promise<TrackingDTO> {
  const [order] = await ctx.db
    .select({ userId: orders.userId, status: orders.status, driverId: orders.driverId })
    .from(orders)
    .where(eq(orders.id, orderId));
  // 404 (no 403): no se revela que el pedido de otra persona existe.
  if (!order || order.userId !== userId) throw notFound('Pedido');
  if (order.status !== 'out_for_delivery') {
    return { available: false, reason: 'not_out_for_delivery' };
  }
  if (!order.driverId) return { available: false, reason: 'no_driver' };

  const [loc] = await ctx.db
    .select({
      latitude: driverLocations.latitude,
      longitude: driverLocations.longitude,
      updatedAt: driverLocations.updatedAt,
    })
    .from(driverLocations)
    .where(eq(driverLocations.driverId, order.driverId));
  if (!loc) return { available: false, reason: 'no_position' };

  const ageMs = nowOf(ctx).getTime() - loc.updatedAt.getTime();
  if (ageMs > TRACKING_MAX_AGE_MS) return { available: false, reason: 'stale' };
  return {
    available: true,
    latitude: loc.latitude,
    longitude: loc.longitude,
    updatedAt: loc.updatedAt.toISOString(),
    ageSeconds: Math.max(0, Math.floor(ageMs / 1000)),
  };
}

// ───────────────────────── pedir de nuevo ─────────────────────────

type ItemRow = typeof orderItems.$inferSelect;
type VariantRow = typeof variants.$inferSelect;
type ProductRow = typeof products.$inferSelect;

export interface ReorderLimits {
  demo: boolean;
  maxCentilbPerLine: number;
  maxUnitsPerLine: number;
}

/**
 * Una línea del pedido anterior contra el catálogo de HOY: mismo criterio de publicación que
 * `listProducts` (`variantBlockers`) y mismas reglas de cantidad que `quoteOrder`, así que la
 * cantidad sugerida siempre se puede cotizar.
 */
export function reorderLine(
  item: Pick<ItemRow, 'quantity' | 'unitPrice'>,
  variant: VariantRow,
  product: Pick<ProductRow, 'name' | 'active'>,
  limits: ReorderLimits,
): ReorderLineDTO {
  const base = {
    variantId: variant.id,
    name: product.name,
    variant: variant.variant,
    photo: variant.photo,
    photoIllustrative: variant.photoIllustrative,
    pricingUnit: variant.pricingUnit,
    unitPrice: variant.price,
    previousUnitPrice: item.unitPrice,
    requestedQuantity: item.quantity,
  };
  const unavailable = (reason: string): ReorderLineDTO => ({
    ...base,
    quantity: 0,
    status: 'unavailable',
    reason,
  });

  if (variantBlockers(variant, product.active, limits.demo).length > 0) {
    return unavailable('Ya no está disponible');
  }

  const isLb = variant.pricingUnit === 'lb';
  const fmt = (n: number) => (isLb ? formatLb(n) : `${n} u.`);
  const step = isLb ? (variant.stepCentilb ?? LIMITS.defaultStepCentilb) : 1;
  const min = isLb ? (variant.minCentilb ?? LIMITS.defaultMinCentilb) : 1;
  const max = isLb ? limits.maxCentilbPerLine : limits.maxUnitsPerLine;
  const available = Math.max(0, variant.onHand - variant.reserved);
  // Menor cantidad que `quoteOrder` acepta: ≥ mínimo y múltiplo del paso.
  const smallest = Math.ceil(min / step) * step;

  if (available < smallest) {
    return unavailable(
      available <= 0
        ? 'Agotado por ahora'
        : `Solo quedan ${fmt(available)} y lo mínimo es ${fmt(smallest)}`,
    );
  }

  const wanted = item.quantity;
  const capped = Math.min(wanted, max, available);
  // Siempre un múltiplo del paso y nunca por debajo del mínimo (available >= smallest lo permite).
  const quantity = Math.max(smallest, Math.floor(capped / step) * step);

  if (quantity === wanted) return { ...base, quantity, status: 'ok' };
  if (quantity > wanted) {
    // El mínimo subió desde la última compra: se sube a él en vez de perder la línea.
    return { ...base, quantity, status: 'ok', reason: `Ahora lo mínimo es ${fmt(smallest)}` };
  }
  const reason =
    available < wanted && available <= max
      ? `Solo quedan ${fmt(available)} disponibles`
      : max < wanted
        ? `El máximo por pedido es ${fmt(max)}`
        : `Se vende en múltiplos de ${fmt(step)}`;
  return { ...base, quantity, status: 'reduced', reason };
}

export async function buildReorder(
  ctx: OrderContext,
  orderId: string,
  userId: string,
): Promise<ReorderDTO> {
  const [order] = await ctx.db
    .select({ id: orders.id, number: orders.number, userId: orders.userId })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order || order.userId !== userId) throw notFound('Pedido');

  const rows = await ctx.db
    .select()
    .from(orderItems)
    .innerJoin(variants, eq(variants.id, orderItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.name));

  const limits: ReorderLimits = {
    demo: ctx.config.demo,
    maxCentilbPerLine: ctx.config.maxCentilbPerLine,
    maxUnitsPerLine: ctx.config.maxUnitsPerLine,
  };
  return {
    orderId: order.id,
    code: formatOrderNumber(order.number),
    demo: ctx.config.demo,
    lines: rows.map((r) => reorderLine(r.order_items, r.variants, r.products, limits)),
  };
}
