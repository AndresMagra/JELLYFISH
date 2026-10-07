import { type Bps, type Centavos, assertCentavos, itbisIncluded } from './money';
import { type Centilb, priceForWeight } from './weight';

/**
 * 'lb'   → se vende por libra; `quantity` está en centilibras.
 * 'unit' → precio fijo por pieza/paquete/combo; `quantity` es un entero de unidades.
 */
export type PricingUnit = 'lb' | 'unit';

export interface PricedLineInput {
  /** Identificador de la línea (id de variante/SKU). */
  id: string;
  pricingUnit: PricingUnit;
  /** Precio por libra o por unidad, YA con ITBIS incluido, en centavos. */
  unitPrice: Centavos;
  /** Tasa de ITBIS en puntos básicos (0 = exento, 1800 = 18 %). */
  itbisBps: Bps;
  /** Centilibras si pricingUnit = 'lb'; unidades si 'unit'. */
  quantity: number;
  /** El peso final puede diferir del estimado (se pesa al empacar). */
  variableWeight: boolean;
}

export interface PricedLine extends PricedLineInput {
  gross: Centavos;
  discount: Centavos;
  /** gross − discount */
  net: Centavos;
  /** ITBIS contenido en `net`. */
  itbis: Centavos;
}

export interface OrderTotals {
  lines: PricedLine[];
  subtotal: Centavos;
  discount: Centavos;
  deliveryFee: Centavos;
  deliveryFeeItbis: Centavos;
  /** ITBIS contenido en el total (productos + envío). */
  itbis: Centavos;
  total: Centavos;
  /** Parte del subtotal (neto de descuento) cuyo peso final puede variar. */
  variableWeightNet: Centavos;
}

export function lineGross(input: PricedLineInput): Centavos {
  assertCentavos(input.unitPrice, 'precio unitario');
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new RangeError(`cantidad inválida en ${input.id}: ${input.quantity}`);
  }
  return input.pricingUnit === 'lb'
    ? priceForWeight(input.unitPrice, input.quantity as Centilb)
    : input.unitPrice * input.quantity;
}

/**
 * Reparte un descuento entre líneas de forma proporcional al monto bruto, sin perder centavos
 * (método del mayor resto, desempate por orden). Necesario para calcular el ITBIS correcto.
 */
export function allocateProportionally(amount: Centavos, weights: Centavos[]): Centavos[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (amount <= 0 || totalWeight <= 0) return weights.map(() => 0);
  const capped = Math.min(amount, totalWeight);
  const raw = weights.map((w) => (capped * w) / totalWeight);
  const floors = raw.map(Math.floor);
  let remainder = capped - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export interface TotalsOptions {
  /** Descuento total del pedido (cupón), en centavos. Se limita al subtotal. */
  discount?: Centavos;
  deliveryFee?: Centavos;
  /** ITBIS del envío (por defecto 0: confirmar tratamiento con el contador). */
  deliveryFeeItbisBps?: Bps;
}

export function computeOrderTotals(
  inputs: PricedLineInput[],
  options: TotalsOptions = {},
): OrderTotals {
  const { discount = 0, deliveryFee = 0, deliveryFeeItbisBps = 0 } = options;
  assertCentavos(discount, 'descuento');
  assertCentavos(deliveryFee, 'envío');

  const grosses = inputs.map(lineGross);
  const subtotal = grosses.reduce((a, b) => a + b, 0);
  const discounts = allocateProportionally(discount, grosses);

  const lines: PricedLine[] = inputs.map((input, i) => {
    const gross = grosses[i] ?? 0;
    const lineDiscount = discounts[i] ?? 0;
    const net = gross - lineDiscount;
    return {
      ...input,
      gross,
      discount: lineDiscount,
      net,
      itbis: itbisIncluded(net, input.itbisBps),
    };
  });

  const appliedDiscount = lines.reduce((a, l) => a + l.discount, 0);
  const net = subtotal - appliedDiscount;
  const deliveryFeeItbis = itbisIncluded(deliveryFee, deliveryFeeItbisBps);
  const itbis = lines.reduce((a, l) => a + l.itbis, 0) + deliveryFeeItbis;
  const variableWeightNet = lines.filter((l) => l.variableWeight).reduce((a, l) => a + l.net, 0);

  return {
    lines,
    subtotal,
    discount: appliedDiscount,
    deliveryFee,
    deliveryFeeItbis,
    itbis,
    total: net + deliveryFee,
    variableWeightNet,
  };
}

/** Colchón por defecto al pre-autorizar pedidos con peso variable (10 %). */
export const DEFAULT_AUTH_BUFFER_BPS: Bps = 1000;

/**
 * Monto a pre-autorizar en la tarjeta: total + colchón sobre la parte de peso variable.
 * Si no hay líneas de peso variable, se autoriza exactamente el total.
 */
export function authorizationAmount(
  totals: Pick<OrderTotals, 'total' | 'variableWeightNet'>,
  bufferBps: Bps = DEFAULT_AUTH_BUFFER_BPS,
): Centavos {
  const buffer = Math.ceil((totals.variableWeightNet * bufferBps) / 10_000);
  return totals.total + buffer;
}
