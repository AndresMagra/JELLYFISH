/**
 * Caja que contiene a República Dominicana (con algo de mar alrededor). Sirve para descartar
 * coordenadas imposibles: un GPS sin señal, un simulador en California o un error de signo.
 */
export const DR_BOUNDS = {
  minLat: 17.3,
  maxLat: 20.1,
  minLng: -72.1,
  maxLng: -68.2,
} as const;

export const OUTSIDE_DR_MESSAGE = 'La ubicación debe estar dentro de República Dominicana';

export function isInDominicanRepublic(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= DR_BOUNDS.minLat &&
    latitude <= DR_BOUNDS.maxLat &&
    longitude >= DR_BOUNDS.minLng &&
    longitude <= DR_BOUNDS.maxLng
  );
}
