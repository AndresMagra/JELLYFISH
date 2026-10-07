import type { OrderDTO } from '@jellyfish/shared';

/**
 * Lo que el repartidor debe cobrar en efectivo ahora (0 si ya está pagado o no es en efectivo).
 * Es el total real si ya se pesó; si no, el estimado.
 */
export function amountDue(order: OrderDTO): number {
  const cash = order.payments.find((p) => p.method === 'cash');
  if (order.paymentMethod !== 'cash' || !cash || cash.status !== 'pending') return 0;
  return order.finalTotal ?? order.total;
}

const enc = encodeURIComponent;

/** Texto de búsqueda para el mapa: en RD las direcciones son informales, así que se manda todo. */
export function addressQuery(order: OrderDTO): string {
  const a = order.address;
  return `${a.line1}, ${a.sector}, ${a.city}, República Dominicana`;
}

export function wazeUrl(order: OrderDTO): string {
  const { latitude, longitude } = order.address;
  return latitude != null && longitude != null
    ? `https://waze.com/ul?ll=${latitude},${longitude}&navigate=yes`
    : `https://waze.com/ul?q=${enc(addressQuery(order))}&navigate=yes`;
}

export function googleMapsUrl(order: OrderDTO): string {
  const { latitude, longitude } = order.address;
  const q =
    latitude != null && longitude != null ? `${latitude},${longitude}` : addressQuery(order);
  return `https://www.google.com/maps/search/?api=1&query=${enc(q)}`;
}

export const whatsappUrl = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;
