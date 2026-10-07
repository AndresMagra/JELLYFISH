/** Límites de pedido compartidos por el API (validación) y las apps (stepper de cantidad). */
export const LIMITS = {
  /** Máximo por línea, en centilibras (100 lb). */
  maxCentilbPerLine: 10_000,
  /** Máximo de unidades por línea (combos, piezas). */
  maxUnitsPerLine: 20,
  /** Paso y mínimo por defecto cuando un artículo no los define. */
  defaultStepCentilb: 50,
  defaultMinCentilb: 100,
} as const;
