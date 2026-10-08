import type { PricingUnit, ReceiveLotInput, StockLotStatus } from '@jellyfish/shared';
import { lbToCentilb, pesosToCentavos } from './format';

/** Los mismos topes que `receiveLot` en el API: validar aquí evita un viaje con un error evidente. */
export const MAX_DAYS_PAST = 30;
export const MAX_DAYS_FUTURE = 5 * 365;
export const LOT_CODE_MAX = 40;
export const LOT_NOTE_MAX = 300;
const QTY_MAX = 1_000_000_000;
const COST_MAX_CENTAVOS = 100_000_000;

/** Un lote cuenta como "por vencer" en el Resumen cuando le quedan 7 días o menos. */
export const EXPIRING_SOON_DAYS = 7;
export const EXPIRING_WINDOWS = [7, 30, 60] as const;

const DAY_MS = 86_400_000;
const RD_OFFSET_MS = -4 * 3_600_000; // RD: UTC-4 todo el año
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ───────────── Fechas (día calendario de República Dominicana) ─────────────

/** "AAAA-MM-DD" del día de hoy en RD. */
export function todayInRD(now: Date = new Date()): string {
  return new Date(now.getTime() + RD_OFFSET_MS).toISOString().slice(0, 10);
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Días de `from` a `to` (negativo si `to` ya pasó). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** "2026-11-05" → "5 nov 2026". */
export function expiryDateLabel(ymd: string | null): string {
  if (!ymd || !isCalendarDate(ymd)) return '—';
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** Texto de los días que le quedan al lote (0 = todavía válido, vence hoy). */
export function daysLeftText(daysLeft: number | null): string {
  if (daysLeft === null || !Number.isFinite(daysLeft)) return 'sin vencimiento';
  if (daysLeft === 0) return 'vence hoy';
  if (daysLeft === 1) return 'vence mañana';
  if (daysLeft === -1) return 'venció ayer';
  return daysLeft > 0 ? `vence en ${daysLeft} días` : `venció hace ${-daysLeft} días`;
}

// ───────────── Estado, alertas ─────────────

export const LOT_STATUS: Record<
  StockLotStatus,
  { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }
> = {
  expired: { label: 'Vencido', tone: 'danger' },
  expiring: { label: 'Por vencer', tone: 'warning' },
  ok: { label: 'Vigente', tone: 'success' },
  no_expiry: { label: 'Sin vencimiento', tone: 'neutral' },
};

export function expiryAlertText(kind: 'expiring' | 'expired', count: number): string {
  if (kind === 'expiring') {
    return count === 1
      ? `1 lote vence en ${EXPIRING_SOON_DAYS} días o menos`
      : `${count} lotes vencen en ${EXPIRING_SOON_DAYS} días o menos`;
  }
  return count === 1 ? '1 lote vencido con existencias' : `${count} lotes vencidos con existencias`;
}

// ───────────── Cantidades y costo según la unidad ─────────────

/**
 * Lo que escribió la persona → lo que guarda el API: centilibras si el artículo es por libra
 * ("12.5" → 1250), unidades enteras si es por unidad. null si no es válido o no es mayor que 0.
 */
export function parseLotQuantity(text: string, unit: PricingUnit): number | null {
  const q =
    unit === 'lb' ? lbToCentilb(text) : /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  return q !== null && q > 0 && q <= QTY_MAX ? q : null;
}

/** El costo es opcional: vacío → null (sin costo); inválido → undefined. */
export function parseLotCost(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const c = pesosToCentavos(text);
  return c !== null && c <= COST_MAX_CENTAVOS ? c : undefined;
}

// ───────────── Buscar el artículo ─────────────

/** Sin mayúsculas ni tildes: "camaron" encuentra "Camarón". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/** Artículos cuyo nombre, variante o SKU contienen todas las palabras escritas. */
export function matchVariants<T extends { productName: string; variant: string; sku: string }>(
  items: readonly T[],
  query: string,
  limit = 10,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: T[] = [];
  for (const it of items) {
    const hay = fold(`${it.productName} ${it.variant} ${it.sku}`);
    if (words.every((w) => hay.includes(w))) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ───────────── Formulario de recepción ─────────────

export type LotField = 'variant' | 'lotCode' | 'expiresOn' | 'quantity' | 'cost' | 'note';

export interface LotFormInput {
  variantId: string | null;
  pricingUnit: PricingUnit | null;
  lotCode: string;
  expiresOn: string;
  quantity: string;
  cost: string;
  note: string;
}

export interface LotFormResult {
  /** El cuerpo listo para el API; null mientras haya algún error. */
  body: ReceiveLotInput | null;
  errors: Partial<Record<LotField, string>>;
}

export function checkExpiresOn(value: string, today: string): string | null {
  if (!value.trim()) return 'Elige la fecha de vencimiento';
  if (!isCalendarDate(value)) return 'Usa una fecha válida (AAAA-MM-DD)';
  const days = daysBetween(today, value);
  if (days < -MAX_DAYS_PAST) {
    return `Esa fecha pasó hace más de ${MAX_DAYS_PAST} días; revisa el año`;
  }
  if (days > MAX_DAYS_FUTURE) return 'Esa fecha está demasiado lejos; revisa el año';
  return null;
}

export function checkLotForm(input: LotFormInput, today: string): LotFormResult {
  const errors: LotFormResult['errors'] = {};
  const lotCode = input.lotCode.trim();
  const note = input.note.trim();

  if (!input.variantId || !input.pricingUnit) errors.variant = 'Elige el artículo';

  if (!lotCode) errors.lotCode = 'Escribe el código del lote';
  else if (lotCode.length > LOT_CODE_MAX) errors.lotCode = `Máximo ${LOT_CODE_MAX} caracteres`;
  else if (!/^[^\p{C}]+$/u.test(lotCode)) errors.lotCode = 'El código tiene caracteres no válidos';

  const dateError = checkExpiresOn(input.expiresOn, today);
  if (dateError) errors.expiresOn = dateError;

  const quantity = input.pricingUnit ? parseLotQuantity(input.quantity, input.pricingUnit) : null;
  if (input.pricingUnit && quantity === null) {
    errors.quantity =
      input.pricingUnit === 'lb'
        ? 'Escribe las libras que entraron (máximo 2 decimales), mayor que 0'
        : 'Escribe un número entero de unidades, mayor que 0';
  }

  const cost = parseLotCost(input.cost);
  if (cost === undefined) errors.cost = 'Usa un monto en pesos como 85 o 85.50';

  if (note.length > LOT_NOTE_MAX) errors.note = `Máximo ${LOT_NOTE_MAX} caracteres`;

  if (
    Object.keys(errors).length > 0 ||
    !input.variantId ||
    quantity === null ||
    cost === undefined
  ) {
    return { body: null, errors };
  }
  return {
    body: {
      variantId: input.variantId,
      lotCode,
      expiresOn: input.expiresOn,
      quantity,
      unitCostCentavos: cost,
      note,
    },
    errors,
  };
}
