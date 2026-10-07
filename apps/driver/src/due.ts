import { type OrderDTO, isInDominicanRepublic } from '@jellyfish/shared';

/**
 * Lo que el repartidor debe cobrar en efectivo ahora (0 si ya está pagado o no es en efectivo).
 * Es el total real si ya se pesó; si no, el estimado.
 */
export function amountDue(order: OrderDTO): number {
  const cash = order.payments.find((p) => p.method === 'cash');
  if (order.paymentMethod !== 'cash' || !cash || cash.status !== 'pending') return 0;
  return order.finalTotal ?? order.total;
}

// ───────────── Pasos de una entrega ─────────────

/**
 * Dónde va el repartidor con este pedido. El orden es siempre el mismo:
 *   depart → (cobrar efectivo) → (PIN del cliente) → entregado.
 *  - `depart`: aún no sale (empacado o entrega fallida que se reintenta).
 *  - `collect`: ya va en camino y falta cobrar el efectivo exacto.
 *  - `pin`: cobrado (o ya pagado); falta pedirle el PIN al cliente.
 *  - `locked`: se acabaron los 5 intentos del PIN; solo administración puede cerrar la entrega.
 *  - `deliver`: el pedido no usa PIN (anterior a esa función) y ya está cobrado: se entrega directo.
 */
export type DeliveryStep = 'depart' | 'collect' | 'pin' | 'locked' | 'deliver';

export function deliveryStep(order: OrderDTO): DeliveryStep {
  if (order.status !== 'out_for_delivery') return 'depart';
  if (amountDue(order) > 0) return 'collect';
  if (order.pinRequired) return order.pinAttemptsLeft === 0 ? 'locked' : 'pin';
  return 'deliver';
}

/** El pedido está bloqueado por intentos de PIN agotados. */
export const isPinLocked = (order: OrderDTO): boolean =>
  order.pinRequired && order.pinAttemptsLeft === 0;

/**
 * Pedido sobre el que se reporta la ubicación: el que salió a entregar más recientemente (por la
 * hora del evento "en camino"; si falta, el de número más alto). null si no hay ninguno en camino.
 */
export function latestOutForDeliveryId(orders: readonly OrderDTO[]): string | null {
  let best: { id: string; at: string; number: number } | null = null;
  for (const o of orders) {
    if (o.status !== 'out_for_delivery') continue;
    const at =
      o.timeline
        .filter((e) => e.toStatus === 'out_for_delivery')
        .map((e) => e.createdAt)
        .sort()
        .pop() ?? '';
    if (!best || at > best.at || (at === best.at && o.number > best.number)) {
      best = { id: o.id, at, number: o.number };
    }
  }
  return best?.id ?? null;
}

/**
 * Orden de la lista: primero lo que ya va en camino, luego lo listo para salir y al final las
 * entregas fallidas; dentro de cada grupo, por franja horaria y número de pedido.
 */
export function sortDeliveries(orders: readonly OrderDTO[]): OrderDTO[] {
  const rank = (o: OrderDTO) =>
    o.status === 'out_for_delivery' ? 0 : o.status === 'packed' ? 1 : 2;
  return [...orders].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.slotStart ?? '').localeCompare(b.slotStart ?? '') ||
      a.number - b.number,
  );
}

// ───────────── Mapas ─────────────

const enc = encodeURIComponent;

/** Coordenadas del cliente, solo si existen y caen dentro de República Dominicana. */
export function destinationCoords(order: OrderDTO): { latitude: number; longitude: number } | null {
  const { latitude, longitude } = order.address;
  if (latitude == null || longitude == null) return null;
  return isInDominicanRepublic(latitude, longitude) ? { latitude, longitude } : null;
}

/** Texto de búsqueda para el mapa: en RD las direcciones son informales, así que se manda todo. */
export function addressQuery(order: OrderDTO): string {
  const a = order.address;
  return `${a.line1}, ${a.sector}, ${a.city}, República Dominicana`;
}

/** Waze: con coordenadas, `ll=lat,lng` (exacto); si no, busca por el texto de la dirección. */
export function wazeUrl(order: OrderDTO): string {
  const c = destinationCoords(order);
  return c
    ? `https://waze.com/ul?ll=${c.latitude},${c.longitude}&navigate=yes`
    : `https://waze.com/ul?q=${enc(addressQuery(order))}&navigate=yes`;
}

/** Google Maps con la ruta desde donde está el repartidor hasta el cliente. */
export function googleMapsUrl(order: OrderDTO): string {
  const c = destinationCoords(order);
  const destination = c ? `${c.latitude},${c.longitude}` : addressQuery(order);
  return `https://www.google.com/maps/dir/?api=1&destination=${enc(destination)}&travelmode=driving`;
}

export const whatsappUrl = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;
