import {
  type CouponDTO,
  type OrderDTO,
  type OrderItemDTO,
  computeOrderTotals,
  lineGross,
} from '@jellyfish/shared';

// Reproduce lo que cobra el servidor al empacar (services/orders.ts + services/coupons.ts): el
// pesador ve el total que de verdad se va a cobrar. La prueba diferencial lo compara con el real.

/** Lo que hace falta de un cupón para recalcular su descuento. */
export type CouponTerms = Pick<CouponDTO, 'kind' | 'value' | 'maxDiscount'>;

/**
 * Descuento sobre los productos (centavos). Los porcentajes redondean hacia abajo, nunca pasa del
 * tope del cupón ni del subtotal; el envío gratis no descuenta productos.
 */
export function couponDiscount(coupon: CouponTerms, subtotal: number): number {
  if (coupon.kind === 'free_delivery' || subtotal <= 0) return 0;
  let discount =
    coupon.kind === 'percent' ? Math.floor((subtotal * coupon.value) / 10_000) : coupon.value;
  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  return Math.max(0, Math.min(discount, subtotal));
}

/**
 * Descuento definitivo con el peso real: el porcentaje se recalcula sobre el monto real; el fijo se
 * mantiene (nunca más que el monto real). `coupon` null = el cupón ya no existe: el servidor cae en
 * la regla del monto fijo.
 */
export function finalDiscount(
  order: Pick<OrderDTO, 'couponCode' | 'discount'>,
  coupon: CouponTerms | null,
  grossFinal: number,
): number {
  if (!order.couponCode || order.discount <= 0) return order.discount;
  if (coupon?.kind === 'percent') return couponDiscount(coupon, grossFinal);
  return Math.min(order.discount, grossFinal);
}

/** Una línea con la cantidad que se cobraría: centilibras si es por libra, unidades si no. */
export type PreviewItem = Pick<
  OrderItemDTO,
  'id' | 'pricingUnit' | 'unitPrice' | 'variableWeight' | 'quantity'
>;

export interface TotalsPreview {
  /** Suma de las líneas sin descuento (centavos). */
  gross: number;
  /** Descuento de productos que se aplicaría. */
  discount: number;
  deliveryFee: number;
  total: number;
  /** Importe de cada línea sin descuento, por id. */
  lineGross: Record<string, number>;
  /**
   * false cuando es una estimación: el pedido trae cupón con descuento pero no se conocen sus
   * términos (no se pudo leer la lista de cupones), así que no se sabe si el descuento se recalcula.
   */
  exact: boolean;
}

/**
 * Total del pedido con estas cantidades. `coupon`: los términos del cupón del pedido; null si no existe
 * (regla del monto fijo); undefined si no se pudieron leer (el resultado queda marcado `exact: false`).
 */
export function previewOrderTotals(
  order: Pick<OrderDTO, 'couponCode' | 'discount' | 'deliveryFee'>,
  items: PreviewItem[],
  coupon: CouponTerms | null | undefined,
): TotalsPreview {
  const lines = items.map((i) => ({
    id: i.id,
    pricingUnit: i.pricingUnit,
    unitPrice: i.unitPrice,
    // El ITBIS ya viene incluido en el precio: no cambia el total.
    itbisBps: 0,
    quantity: i.quantity,
    variableWeight: i.variableWeight,
  }));
  const gross = lines.reduce((sum, l) => sum + lineGross(l), 0);
  const hasCoupon = !!order.couponCode && order.discount > 0;
  const discount = finalDiscount(order, coupon ?? null, gross);
  const totals = computeOrderTotals(lines, { discount, deliveryFee: order.deliveryFee });
  return {
    gross,
    discount: totals.discount,
    deliveryFee: totals.deliveryFee,
    total: totals.total,
    lineGross: Object.fromEntries(totals.lines.map((l) => [l.id, l.gross])),
    exact: !hasCoupon || coupon !== undefined,
  };
}

/**
 * Con el pedido ya empacado el servidor guardó el total final: el descuento definitivo sale de
 * restarlo al importe real más el envío.
 */
export function settledDiscount(
  order: Pick<OrderDTO, 'deliveryFee'>,
  gross: number,
  total: number,
) {
  return Math.max(0, gross + order.deliveryFee - total);
}
