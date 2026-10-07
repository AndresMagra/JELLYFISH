import { type TrackingUnavailableReason, isInDominicanRepublic } from '@jellyfish/shared';

/** Cada cuánto la pantalla del pedido pregunta dónde va el repartidor. */
export const TRACKING_POLL_MS = 15_000;

/**
 * Antigüedad de la posición: "ahora mismo", "hace 12 s", "hace 3 min".
 * `ageSeconds` ya incluye el tiempo que pasó desde que la app consultó (ver `liveAgeSeconds`).
 */
export function trackingAge(ageSeconds: number): string {
  const s = Math.max(0, Math.round(ageSeconds));
  if (s < 5) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  return `hace ${Math.floor(s / 60)} min`;
}

/** "Tu repartidor va en camino · actualizado hace 12 s". */
export function trackingHeadline(ageSeconds: number): string {
  return `Tu repartidor va en camino · actualizado ${trackingAge(ageSeconds)}`;
}

/** Edad de la posición ahora: la que dijo el servidor más lo que pasó desde que se consultó. */
export function liveAgeSeconds(
  serverAgeSeconds: number,
  fetchedAtMs: number,
  nowMs: number,
): number {
  return Math.max(0, Math.round(serverAgeSeconds + (nowMs - fetchedAtMs) / 1000));
}

/** Por qué no se ve el repartidor, dicho con claridad. */
export function trackingUnavailableText(reason: TrackingUnavailableReason): string {
  switch (reason) {
    case 'not_out_for_delivery':
      return 'Cuando tu pedido salga a la entrega podrás ver aquí por dónde va tu repartidor.';
    case 'no_driver':
      return 'Todavía estamos asignando un repartidor a tu pedido.';
    case 'no_position':
      return 'Tu repartidor ya está en camino, pero todavía no recibimos su ubicación. Esto se actualiza solo.';
    case 'stale':
      return 'No hemos recibido la ubicación de tu repartidor en los últimos minutos; puede estar sin señal. Esto se actualiza solo.';
    default:
      return 'Por ahora no podemos mostrar la ubicación de tu repartidor.';
  }
}

export type MapsPlatform = 'ios' | 'android' | 'web' | (string & {});

/**
 * Enlace para abrir un punto en el mapa del teléfono (sin mapa embebido):
 * Apple Maps en iPhone; Google Maps en Android y en la web. null si las coordenadas no sirven.
 */
export function mapsUrl(
  platform: MapsPlatform,
  latitude: number,
  longitude: number,
  label = 'Tu repartidor',
): string | null {
  if (!isInDominicanRepublic(latitude, longitude)) return null;
  const lat = Number(latitude.toFixed(6));
  const lng = Number(longitude.toFixed(6));
  if (platform === 'ios')
    return `https://maps.apple.com/?ll=${lat},${lng}&q=${encodeURIComponent(label)}`;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/** "18.4861, -69.9312": coordenadas cortas para mostrar. */
export function formatCoords(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}
