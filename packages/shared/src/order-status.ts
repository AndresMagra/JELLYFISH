/**
 * Estados del pedido visibles para cliente, empacadores y repartidores.
 * La autorización/captura de la tarjeta vive en `payment.status`, no aquí.
 */
export const ORDER_STATUSES = [
  'pending_payment',
  'confirmed',
  'picking',
  'packed',
  'out_for_delivery',
  'delivered',
  'delivery_failed',
  'cancelled',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['picking', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered', 'delivery_failed'],
  delivery_failed: ['out_for_delivery', 'cancelled'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Estados en los que el stock sigue reservado para el pedido. */
export function holdsStock(status: OrderStatus): boolean {
  return [
    'pending_payment',
    'confirmed',
    'picking',
    'packed',
    'out_for_delivery',
    'delivery_failed',
  ].includes(status);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
  ) {
    super(`Transición de pedido no permitida: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
