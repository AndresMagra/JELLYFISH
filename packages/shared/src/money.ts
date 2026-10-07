/**
 * Dinero en pesos dominicanos (DOP). Siempre se guarda como ENTERO en centavos
 * para evitar errores de coma flotante. Los precios de góndola en RD ya incluyen ITBIS.
 */
export type Centavos = number;

export function assertCentavos(value: number, label = 'monto'): asserts value is Centavos {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} debe ser un entero en centavos, recibido: ${value}`);
  }
}

/** Convierte pesos (p. ej. 174.95) a centavos (17495) sin errores de redondeo. */
export function toCentavos(pesos: number): Centavos {
  if (!Number.isFinite(pesos)) throw new RangeError(`monto inválido: ${pesos}`);
  return Math.round(pesos * 100 + Number.EPSILON * Math.sign(pesos));
}

export function toPesos(centavos: Centavos): number {
  assertCentavos(centavos);
  return centavos / 100;
}

/** Redondeo "half away from zero" sobre un cociente entero. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError('división entre cero');
  const q = numerator / denominator;
  return q < 0 ? -Math.round(-q) : Math.round(q);
}

const dopFormatter = new Intl.NumberFormat('es-DO', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "RD$ 1,234.50" */
export function formatDOP(centavos: Centavos): string {
  assertCentavos(centavos);
  return `RD$ ${dopFormatter.format(centavos / 100)}`;
}

/** Puntos básicos: 1800 = 18 %. */
export type Bps = number;

export const ITBIS_STANDARD_BPS: Bps = 1800;
export const ITBIS_EXEMPT_BPS: Bps = 0;

/**
 * ITBIS contenido en un monto que YA lo incluye (precio de góndola).
 * itbis = total * r / (1 + r)
 */
export function itbisIncluded(total: Centavos, rateBps: Bps): Centavos {
  assertCentavos(total, 'total');
  if (rateBps <= 0) return 0;
  return divRound(total * rateBps, 10_000 + rateBps);
}
