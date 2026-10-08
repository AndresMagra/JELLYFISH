import { type OrderStatus, es, formatDOP, formatLb } from '@jellyfish/shared';

export { formatDOP, formatLb };
export const statusLabel = (s: OrderStatus) => es.orderStatusLabel[s];

/** Dígitos con punto decimal opcional, o miles bien formados: "150", "150.5", "1,234", "1,234.50". */
const PESOS = /^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/;

/**
 * "174.95" | "1,234.50" | "RD$ 90" → centavos (null si no es un monto válido). En RD la coma separa
 * miles y el punto los decimales: "150,50" no es 150 pesos con 50 centavos (sería 15 050), así que se
 * rechaza en vez de adivinar.
 */
export function pesosToCentavos(text: string): number | null {
  const cleaned = text.replace(/rd\$|\s/gi, '');
  if (!PESOS.test(cleaned)) return null;
  return Math.round(Number(cleaned.replace(/,/g, '')) * 100);
}

/** Lo que se muestra cuando `pesosToCentavos` devuelve null. */
export const MONEY_ERROR = 'Monto inválido: usa punto para los centavos, como 150 o 1,234.50';

/** Centavos → "174.95" para editar en un campo. */
export const centavosToPesos = (c: number) => (c / 100).toFixed(2);

/** "2.5" → 250 centilibras (null si es inválido o no es múltiplo de 0.01). */
export function lbToCentilb(text: string): number | null {
  const t = text.replace(',', '.').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const OFFSET = -4 * 3_600_000; // RD: UTC-4 todo el año
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function hour12(d: Date) {
  const h = d.getUTCHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + OFFSET);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hour12(d)}`;
}

export function slot(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return 'Sin horario';
  const s = new Date(new Date(startIso).getTime() + OFFSET);
  const e = new Date(new Date(endIso).getTime() + OFFSET);
  return `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]} · ${hour12(s)} – ${hour12(e)}`;
}

export const qtyLabel = (unit: 'lb' | 'unit', q: number) =>
  unit === 'lb' ? formatLb(q) : `${q} u.`;

export const whatsappLink = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;
