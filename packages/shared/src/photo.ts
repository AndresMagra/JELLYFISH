/**
 * Utilidades para las fotos del catálogo. Una foto puede ser:
 *  - una URL del CDN de generación de imágenes (https://d8j0ntlcm91z4.cloudfront.net/…/hf_….png),
 *  - cualquier otra URL https/http,
 *  - una ruta local servida por el API (`/photos/<sku>.webp`), o
 *  - un texto libre heredado (p. ej. `fotos/pechuga.jpg`) que la app no sabe cargar.
 */

/** Host del CDN donde vive la generación; solo ahí existe la variante liviana `_min.webp`. */
export const GENERATION_CDN_HOST = 'd8j0ntlcm91z4.cloudfront.net';

/** ¿Es una URL absoluta http(s) (la app puede cargarla tal cual)? */
export function isRemotePhoto(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * Variante liviana para listas y tarjetas. Para las URLs del CDN de generación
 * (`…/hf_xxx.png`) devuelve `…/hf_xxx_min.webp`; cualquier otra URL o ruta local se devuelve igual.
 * Es idempotente: pasar una miniatura ya convertida no la cambia.
 */
export function photoThumb(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== GENERATION_CDN_HOST) return url;
  const m = /^(.*\/hf_[^/]*?)\.png$/i.exec(parsed.pathname);
  if (!m) return url;
  parsed.pathname = `${m[1]}_min.webp`;
  return parsed.toString();
}

/**
 * Las fotos locales (`/photos/…`) se guardan sin servidor para que el mismo CSV sirva en cualquier
 * entorno; la app móvil no tiene "mismo origen", así que el API las vuelve absolutas al responder.
 * Las URLs completas (https://…) y los textos que no empiezan con una sola "/" quedan intactos.
 */
export function absolutePhotoUrl(photo: string, baseUrl: string): string {
  if (!/^\/(?!\/)/.test(photo)) return photo;
  return `${baseUrl.replace(/\/+$/, '')}${photo}`;
}
