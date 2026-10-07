import { type OrderStatus, es, formatDOP, formatLb } from '@jellyfish/shared';

export { formatDOP, formatLb };
export const statusLabel = (s: OrderStatus) => es.orderStatusLabel[s];

/** "174.95" | "1,234.5" | "RD$ 90" → centavos (null si no es un monto válido). */
export function pesosToCentavos(text: string): number | null {
  const cleaned = text.replace(/rd\$|\s/gi, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

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
