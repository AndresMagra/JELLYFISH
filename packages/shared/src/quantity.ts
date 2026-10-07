import { LIMITS } from './limits';
import type { PricingUnit } from './pricing';

export interface QuantityRules {
  pricingUnit: PricingUnit;
  stepCentilb: number | null;
  minCentilb: number | null;
}

/** Incremento del stepper: media libra (o lo que defina el artículo) o 1 unidad. */
export function quantityStep(r: QuantityRules): number {
  return r.pricingUnit === 'lb' ? (r.stepCentilb ?? LIMITS.defaultStepCentilb) : 1;
}

export function quantityMin(r: QuantityRules): number {
  return r.pricingUnit === 'lb' ? (r.minCentilb ?? LIMITS.defaultMinCentilb) : 1;
}

export function quantityMax(r: QuantityRules): number {
  return r.pricingUnit === 'lb' ? LIMITS.maxCentilbPerLine : LIMITS.maxUnitsPerLine;
}

/**
 * "+": sube un paso. No pasa el máximo ni lo disponible, y siempre cae en un múltiplo del paso
 * (el API rechaza cantidades que no lo sean). Si ya no cabe otro paso, devuelve la cantidad actual.
 */
export function stepUp(q: number, r: QuantityRules, available = Infinity): number {
  const step = quantityStep(r);
  const ceiling = Math.min(quantityMax(r), Math.floor(available / step) * step);
  const next = q <= 0 ? quantityMin(r) : q + step;
  return next > ceiling ? q : next;
}

/** "−": baja un paso; por debajo del mínimo la línea se quita (devuelve 0). */
export function stepDown(q: number, r: QuantityRules): number {
  const next = q - quantityStep(r);
  return next < quantityMin(r) ? 0 : next;
}

/** Ajusta una cantidad arbitraria a un múltiplo válido dentro de [mínimo, máximo]. */
export function clampQuantity(q: number, r: QuantityRules, available = Infinity): number {
  if (!Number.isFinite(q) || q <= 0) return 0;
  const step = quantityStep(r);
  const snapped = Math.floor(q / step) * step;
  const capped = Math.min(snapped, quantityMax(r), Math.floor(available / step) * step);
  return capped < quantityMin(r) ? 0 : capped;
}
