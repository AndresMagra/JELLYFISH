import { type VariantDTO, formatDOP, formatLb } from '@jellyfish/shared';

/** "RD$ 174.95 / lb" o "RD$ 2,450.00" */
export function priceLabel(v: Pick<VariantDTO, 'price' | 'pricingUnit'>): string {
  return v.pricingUnit === 'lb' ? `${formatDOP(v.price)} / lb` : formatDOP(v.price);
}

/** "2.5 lb" o "3 u." */
export function quantityLabel(pricingUnit: 'lb' | 'unit', q: number): string {
  return pricingUnit === 'lb' ? formatLb(q) : `${q} u.`;
}

/** "Hoy 12:00 – 2:00 p. m." según la hora local de RD (UTC-4, sin horario de verano). */
export function slotLabel(
  startIso: string,
  endIso: string,
  now: Date = new Date(),
): { day: string; time: string } {
  const OFFSET = -4 * 3_600_000;
  const local = (d: Date) => new Date(d.getTime() + OFFSET);
  const s = local(new Date(startIso));
  const e = local(new Date(endIso));
  const today = local(now);
  const key = (d: Date) => d.toISOString().slice(0, 10);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const hour = (d: Date) => {
    const h = d.getUTCHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
  };
  const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const day =
    key(s) === key(today)
      ? 'Hoy'
      : key(s) === key(tomorrow)
        ? 'Mañana'
        : `${days[s.getUTCDay()]} ${s.getUTCDate()}`;
  return { day, time: `${hour(s)} – ${hour(e)}` };
}

export function dayKey(startIso: string): string {
  return new Date(new Date(startIso).getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
}

/** "7 oct, 12:30 p. m." */
export function dateTimeLabel(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 4 * 3_600_000);
  const months = [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ];
  const h = d.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${h12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'a. m.' : 'p. m.'}`;
}
