import { and, eq, gte, lt, notInArray, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { deliveryZones, orders } from '../db/schema';
import { invalid, notFound } from '../errors';
import { normalizeText } from '../text';

export type Zone = typeof deliveryZones.$inferSelect;

export async function listZones(db: Db, onlyActive = true): Promise<Zone[]> {
  return db
    .select()
    .from(deliveryZones)
    .where(onlyActive ? eq(deliveryZones.active, true) : undefined);
}

export async function createZone(
  db: Db,
  input: {
    name: string;
    areas: string[];
    feeCentavos: number;
    minOrderCentavos?: number;
    freeOverCentavos?: number | null;
  },
): Promise<Zone> {
  const [row] = await db
    .insert(deliveryZones)
    .values({
      name: input.name,
      areas: input.areas.map(normalizeText),
      feeCentavos: input.feeCentavos,
      minOrderCentavos: input.minOrderCentavos ?? 0,
      freeOverCentavos: input.freeOverCentavos ?? null,
    })
    .returning();
  return row!;
}

/** Busca la zona que cubre el sector o la ciudad indicados. */
export async function findZone(
  db: Db,
  place: { sector: string; city: string },
): Promise<Zone | null> {
  const zones = await listZones(db);
  const sector = normalizeText(place.sector);
  const city = normalizeText(place.city);
  // El sector es más específico que la ciudad: se prueba primero.
  return (
    zones.find((z) => z.areas.includes(sector)) ?? zones.find((z) => z.areas.includes(city)) ?? null
  );
}

export async function getZone(db: Db, id: string): Promise<Zone> {
  const [z] = await db.select().from(deliveryZones).where(eq(deliveryZones.id, id));
  if (!z) throw notFound('Zona de entrega');
  return z;
}

export interface Pricing {
  fee: number;
  free: boolean;
  /** Falta para llegar al pedido mínimo (0 si ya lo cumple). */
  missingForMinimum: number;
  /** Falta para envío gratis, o null si la zona no lo ofrece. */
  missingForFree: number | null;
}

export function deliveryPricing(zone: Zone, subtotal: number): Pricing {
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

export interface Slot {
  start: Date;
  end: Date;
  remaining: number;
}

const MIN = 60_000;

/** Franjas ofrecidas a partir de `now`, con cupos restantes. Las horas son de RD (UTC-4). */
export async function listSlots(db: Db, config: Config, now: Date = new Date()): Promise<Slot[]> {
  const w = config.windows;
  const offsetMs = config.utcOffsetMinutes * MIN;
  // Medianoche local del día actual, expresada en UTC.
  const local = new Date(now.getTime() + offsetMs);
  const dayStartUtc =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs;

  const earliest = now.getTime() + w.leadMinutes * MIN;
  const candidates: { start: Date; end: Date }[] = [];
  for (let d = 0; d <= w.daysAhead; d++) {
    for (let h = w.startHour; h + w.windowHours <= w.endHour; h += w.windowHours) {
      const start = new Date(dayStartUtc + d * 86_400_000 + h * 3_600_000);
      if (start.getTime() < earliest) continue;
      candidates.push({ start, end: new Date(start.getTime() + w.windowHours * 3_600_000) });
    }
  }
  if (candidates.length === 0) return [];

  const first = candidates[0]!.start;
  const last = candidates[candidates.length - 1]!.start;
  const counts = await db
    .select({ slotStart: orders.slotStart, n: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        gte(orders.slotStart, first),
        lt(orders.slotStart, new Date(last.getTime() + 1)),
        notInArray(orders.status, ['cancelled', 'refunded']),
      ),
    )
    .groupBy(orders.slotStart);
  const booked = new Map(counts.map((c) => [c.slotStart?.getTime(), c.n]));

  return candidates.map((c) => ({
    ...c,
    remaining: Math.max(0, w.capacityPerWindow - (booked.get(c.start.getTime()) ?? 0)),
  }));
}

/** Valida que `start` sea una franja ofrecida y con cupo. */
export async function assertSlotAvailable(
  db: Db,
  config: Config,
  start: Date,
  now: Date = new Date(),
): Promise<Slot> {
  const slots = await listSlots(db, config, now);
  const slot = slots.find((s) => s.start.getTime() === start.getTime());
  if (!slot) throw invalid('La franja de entrega elegida no está disponible');
  if (slot.remaining <= 0) throw invalid('Esa franja de entrega ya está llena. Elige otra.');
  return slot;
}
