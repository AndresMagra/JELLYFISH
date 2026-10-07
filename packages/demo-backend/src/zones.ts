import type { SlotDTO } from '@jellyfish/shared';
import { invalid } from './errors';
import type { OrderRec, ZoneSeed } from './types';
import { iso, normalizeText, stableUuid } from './util';

/**
 * Zona de entrega de ejemplo. Misma tarifa que la zona demo del API (envío RD$ 150, pedido mínimo
 * RD$ 800, envío gratis desde RD$ 4,000) con más sectores conocidos de la capital.
 */
export const DEFAULT_ZONE: ZoneSeed = {
  name: 'Santo Domingo (demo)',
  areas: [
    'Santo Domingo',
    'Distrito Nacional',
    'Naco',
    'Piantini',
    'Evaristo Morales',
    'Bella Vista',
    'Los Prados',
    'Gazcue',
    'Ensanche Quisqueya',
    'Serrallés',
    'Mirador Sur',
    'Arroyo Hondo',
    'La Esperilla',
    'Paraíso',
    'Julieta Morales',
    'Renacimiento',
  ],
  feeCentavos: 15_000,
  minOrderCentavos: 80_000,
  freeOverCentavos: 400_000,
};

export interface ZoneRec {
  id: string;
  name: string;
  areas: string[];
  feeCentavos: number;
  minOrderCentavos: number;
  freeOverCentavos: number | null;
}

export function makeZone(seed: ZoneSeed = DEFAULT_ZONE): ZoneRec {
  return {
    id: stableUuid(`zone:${seed.name}`),
    name: seed.name,
    areas: seed.areas.map(normalizeText),
    feeCentavos: seed.feeCentavos,
    minOrderCentavos: seed.minOrderCentavos,
    freeOverCentavos: seed.freeOverCentavos,
  };
}

/** Busca la zona que cubre el sector o la ciudad indicados (el sector pesa más que la ciudad). */
export function findZone(zone: ZoneRec, place: { sector: string; city: string }): ZoneRec | null {
  const sector = normalizeText(place.sector);
  const city = normalizeText(place.city);
  return zone.areas.includes(sector) || zone.areas.includes(city) ? zone : null;
}

export interface Pricing {
  fee: number;
  free: boolean;
  missingForMinimum: number;
  missingForFree: number | null;
}

export function deliveryPricing(zone: ZoneRec, subtotal: number): Pricing {
  const free = zone.freeOverCentavos !== null && subtotal >= zone.freeOverCentavos;
  return {
    fee: free ? 0 : zone.feeCentavos,
    free,
    missingForMinimum: Math.max(0, zone.minOrderCentavos - subtotal),
    missingForFree:
      zone.freeOverCentavos === null ? null : Math.max(0, zone.freeOverCentavos - subtotal),
  };
}

// ───────────────────────── franjas de entrega ─────────────────────────

/** Mismas ventanas que el API: de 10 a.m. a 8 p.m., de 2 en 2 horas, hora de RD (UTC-4). */
export const DELIVERY_WINDOWS = {
  startHour: 10,
  endHour: 20,
  windowHours: 2,
  capacityPerWindow: 8,
  leadMinutes: 90,
  daysAhead: 3,
  utcOffsetMinutes: -240,
} as const;

const MIN = 60_000;

export interface Slot {
  start: number;
  end: number;
  remaining: number;
}

/** Franjas ofrecidas a partir de `now`, con los cupos que quedan (los pedidos activos los ocupan). */
export function listSlots(orders: readonly OrderRec[], now: number): Slot[] {
  const w = DELIVERY_WINDOWS;
  const offsetMs = w.utcOffsetMinutes * MIN;
  const local = new Date(now + offsetMs);
  const dayStartUtc =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs;

  const earliest = now + w.leadMinutes * MIN;
  const candidates: { start: number; end: number }[] = [];
  for (let d = 0; d <= w.daysAhead; d++) {
    for (let h = w.startHour; h + w.windowHours <= w.endHour; h += w.windowHours) {
      const start = dayStartUtc + d * 86_400_000 + h * 3_600_000;
      if (start < earliest) continue;
      candidates.push({ start, end: start + w.windowHours * 3_600_000 });
    }
  }
  const booked = new Map<number, number>();
  for (const o of orders) {
    if (o.status === 'cancelled' || o.status === 'refunded') continue;
    const t = Date.parse(o.slotStart);
    booked.set(t, (booked.get(t) ?? 0) + 1);
  }
  return candidates.map((c) => ({
    ...c,
    remaining: Math.max(0, w.capacityPerWindow - (booked.get(c.start) ?? 0)),
  }));
}

export function slotsToDTO(slots: Slot[]): SlotDTO[] {
  return slots.map((s) => ({
    start: iso(s.start),
    end: iso(s.end),
    remaining: s.remaining,
    available: s.remaining > 0,
  }));
}

/** Valida que `start` sea una franja ofrecida y con cupo. */
export function assertSlotAvailable(orders: readonly OrderRec[], start: number, now: number): Slot {
  const slot = listSlots(orders, now).find((s) => s.start === start);
  if (!slot) throw invalid('La franja de entrega elegida no está disponible');
  if (slot.remaining <= 0) throw invalid('Esa franja de entrega ya está llena. Elige otra.');
  return slot;
}
