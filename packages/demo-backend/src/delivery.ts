import {
  LIMITS,
  type ReorderDTO,
  type ReorderLineDTO,
  type TrackingDTO,
  formatLb,
  isInDominicanRepublic,
} from '@jellyfish/shared';
import { publishable } from './catalog';
import { type Ctx, stockOf } from './context';
import type { ItemRec, OrderRec } from './types';
import { formatOrderNumber, iso } from './util';

// ───────────────────────── seguimiento ─────────────────────────

/** El repartidor "reporta" su posición cada 4 segundos, como la app real. */
export const LOCATION_INTERVAL_MS = 4_000;

interface Point {
  lat: number;
  lng: number;
}

/** De dónde sale el repartidor (Santo Domingo Oeste) y a dónde va si el cliente no dio coordenadas. */
const START: Point = { lat: 18.4972, lng: -69.9871 };
const DEFAULT_DESTINATION: Point = { lat: 18.4861, lng: -69.9312 }; // Naco

function destinationOf(order: OrderRec): Point {
  const { latitude, longitude } = order.address;
  if (latitude !== null && longitude !== null && isInDominicanRepublic(latitude, longitude)) {
    return { lat: latitude, lng: longitude };
  }
  return DEFAULT_DESTINATION;
}

/** Punto a la fracción `t` (0–1) de una línea quebrada, a velocidad constante. */
function pointAlong(points: Point[], t: number): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]!.lat - points[i - 1]!.lat, points[i]!.lng - points[i - 1]!.lng);
    lengths.push(d);
    total += d;
  }
  let remaining = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (remaining <= len || i === lengths.length - 1) {
      const f = len === 0 ? 1 : Math.min(remaining / len, 1);
      const a = points[i]!;
      const b = points[i + 1]!;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
    remaining -= len;
  }
  return points[points.length - 1]!;
}

/** Recorrido simulado: sale de un punto de la capital, dobla una vez y llega al destino. */
export function routeFor(order: OrderRec): Point[] {
  const end = destinationOf(order);
  const corner: Point = { lat: START.lat + (end.lat - START.lat) * 0.2, lng: end.lng };
  return [START, corner, end];
}

export function getTracking(ctx: Ctx, order: OrderRec): TrackingDTO {
  if (order.status !== 'out_for_delivery') return { available: false, reason: 'not_out_for_delivery' };
  if (!order.driverId) return { available: false, reason: 'no_driver' };

  const now = ctx.now();
  const stage = ctx.cfg.stageMs.out_for_delivery;
  const sinceStart = Math.max(0, now - order.stageEnteredAt);
  // Última posición reportada: múltiplo de 4 s desde que salió el pedido.
  const reportedAt = order.stageEnteredAt + Math.floor(sinceStart / LOCATION_INTERVAL_MS) * LOCATION_INTERVAL_MS;
  const progress = Math.min(1, (reportedAt - order.stageEnteredAt) / stage);
  const p = pointAlong(routeFor(order), progress);
  return {
    available: true,
    latitude: Number(p.lat.toFixed(6)),
    longitude: Number(p.lng.toFixed(6)),
    updatedAt: iso(reportedAt),
    ageSeconds: Math.max(0, Math.floor((now - reportedAt) / 1000)),
  };
}

// ───────────────────────── pedir de nuevo ─────────────────────────

/**
 * Una línea del pedido anterior contra el catálogo de HOY: mismas reglas de cantidad que la
 * cotización, así que la cantidad sugerida siempre se puede cotizar (copia de `reorderLine`).
 */
function reorderLine(ctx: Ctx, item: ItemRec): ReorderLineDTO | null {
  const variant = ctx.catalog.variantsById.get(item.variantId);
  const product = ctx.catalog.productOfVariant.get(item.variantId);
  if (!variant || !product) return null;

  const base = {
    variantId: variant.id,
    name: product.name,
    variant: variant.variant,
    photo: variant.photo,
    photoIllustrative: variant.photoIllustrative,
    pricingUnit: variant.pricingUnit,
    unitPrice: variant.price,
    previousUnitPrice: item.unitPrice,
    requestedQuantity: item.quantity,
  };
  const unavailable = (reason: string): ReorderLineDTO => ({
    ...base,
    quantity: 0,
    status: 'unavailable',
    reason,
  });

  if (!publishable(variant)) return unavailable('Ya no está disponible');

  const isLb = variant.pricingUnit === 'lb';
  const fmt = (n: number) => (isLb ? formatLb(n) : `${n} u.`);
  const step = isLb ? (variant.stepCentilb ?? LIMITS.defaultStepCentilb) : 1;
  const min = isLb ? (variant.minCentilb ?? LIMITS.defaultMinCentilb) : 1;
  const max = isLb ? LIMITS.maxCentilbPerLine : LIMITS.maxUnitsPerLine;
  const stock = stockOf(ctx, variant.id);
  const available = Math.max(0, stock.onHand - stock.reserved);
  // Menor cantidad que la cotización acepta: ≥ mínimo y múltiplo del paso.
  const smallest = Math.ceil(min / step) * step;

  if (available < smallest) {
    return unavailable(
      available <= 0
        ? 'Agotado por ahora'
        : `Solo quedan ${fmt(available)} y lo mínimo es ${fmt(smallest)}`,
    );
  }

  const wanted = item.quantity;
  const capped = Math.min(wanted, max, available);
  const quantity = Math.max(smallest, Math.floor(capped / step) * step);

  if (quantity === wanted) return { ...base, quantity, status: 'ok' };
  if (quantity > wanted) {
    return { ...base, quantity, status: 'ok', reason: `Ahora lo mínimo es ${fmt(smallest)}` };
  }
  const reason =
    available < wanted && available <= max
      ? `Solo quedan ${fmt(available)} disponibles`
      : max < wanted
        ? `El máximo por pedido es ${fmt(max)}`
        : `Se vende en múltiplos de ${fmt(step)}`;
  return { ...base, quantity, status: 'reduced', reason };
}

export function buildReorder(ctx: Ctx, order: OrderRec): ReorderDTO {
  const lines = [...order.items]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((i) => reorderLine(ctx, i))
    .filter((l): l is ReorderLineDTO => l !== null);
  return { orderId: order.id, code: formatOrderNumber(order.number), demo: true, lines };
}
