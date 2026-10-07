import { type Centavos, assertCentavos, divRound } from './money';

/**
 * Peso en CENTILIBRAS (1 lb = 100). En RD la carne se vende por libra; guardar enteros
 * evita errores de redondeo (1.5 lb = 150).
 */
export type Centilb = number;

export function lbToCentilb(lb: number): Centilb {
  if (!Number.isFinite(lb) || lb < 0) throw new RangeError(`peso inválido: ${lb}`);
  return Math.round(lb * 100);
}

export function centilbToLb(centilb: Centilb): number {
  return centilb / 100;
}

/** "2 lb", "1.5 lb", "0.25 lb" */
export function formatLb(centilb: Centilb): string {
  const lb = centilb / 100;
  const text = Number.isInteger(lb) ? String(lb) : String(Number(lb.toFixed(2)));
  return `${text} lb`;
}

/** Precio por libra (centavos) × peso (centilibras) → centavos. */
export function priceForWeight(pricePerLb: Centavos, weight: Centilb): Centavos {
  assertCentavos(pricePerLb, 'precio por libra');
  if (!Number.isSafeInteger(weight) || weight < 0) {
    throw new RangeError(`peso debe ser un entero de centilibras ≥ 0, recibido: ${weight}`);
  }
  return divRound(pricePerLb * weight, 100);
}
