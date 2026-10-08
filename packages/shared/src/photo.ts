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

/** `/photos/<sku>.webp`: el nombre solo lleva letras, números, guion y guion bajo (así la `.thumb.webp` no vuelve a convertirse). */
const LOCAL_PHOTO_NAME = /^(.*\/photos\/[A-Za-z0-9_-]+)\.webp$/;
const LOCAL_PHOTO_PATH = /^(\/photos\/[A-Za-z0-9_-]+)\.webp([?#].*)?$/;

/**
 * Variante liviana para listas y tarjetas. Para las URLs del CDN de generación
 * (`…/hf_xxx.png`) devuelve `…/hf_xxx_min.webp`; para las fotos locales `/photos/<sku>.webp` (con o sin
 * servidor delante) devuelve `/photos/<sku>.thumb.webp`, que `photos:fetch` genera junto a la grande;
 * cualquier otra URL se devuelve igual.
 * Es idempotente: pasar una miniatura ya convertida no la cambia.
 */
export function photoThumb(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Ruta local sin servidor (`/photos/JF-RES-001.webp`): conserva lo que venga después (?v=…).
    const local = LOCAL_PHOTO_PATH.exec(url);
    return local ? `${local[1]}.thumb.webp${local[2] ?? ''}` : url;
  }
  if (parsed.protocol === 'https:' && parsed.hostname === GENERATION_CDN_HOST) {
    const m = /^(.*\/hf_[^/]*?)\.png$/i.exec(parsed.pathname);
    if (!m) return url;
    parsed.pathname = `${m[1]}_min.webp`;
    return parsed.toString();
  }
  // La misma foto local ya vuelta absoluta por el API (`https://api…/photos/JF-RES-001.webp`).
  // Si esa miniatura no existiera, la app cae a la foto completa.
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    const m = LOCAL_PHOTO_NAME.exec(parsed.pathname);
    if (m) {
      parsed.pathname = `${m[1]}.thumb.webp`;
      return parsed.toString();
    }
  }
  return url;
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

/**
 * Lo único que se acepta al GUARDAR una foto: vacía (sin foto), una ruta local que empieza con una sola "/"
 * o una URL http(s). Rechaza `javascript:`, `data:`, rutas relativas a otro servidor ("//host/x") y espacios.
 * Devuelve el motivo en español, o null si es válida. Los textos heredados que ya estaban guardados se
 * siguen mostrando (ver arriba); esto solo gobierna lo que se escribe de aquí en adelante.
 */
export function photoRefError(text: string): string | null {
  if (!text) return null;
  if (text.length > 300) return 'Máximo 300 caracteres';
  if (/^\/(?!\/)\S+$/.test(text) || /^https?:\/\/\S+$/i.test(text)) return null;
  return 'Escribe una ruta que empiece con / (como /photos/archivo.webp) o una URL que empiece con https://';
}
