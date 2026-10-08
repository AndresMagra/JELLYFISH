/**
 * Fotos de la vista previa. La página publicada solo puede pedir archivos PROPIOS (la política de
 * seguridad del alojamiento bloquea cualquier otro servidor), así que la foto de cada variante es una
 * ruta RELATIVA a la carpeta de la página (`photos/<sku>.thumb.webp`) que se resuelve, al ejecutar,
 * contra la carpeta real donde quedó publicada.
 *
 * Sin dependencias de Node ni del navegador: se prueba tal cual.
 */

/** Ruta publicada (relativa) de la miniatura de un SKU: 480×360, WebP. */
export function localThumbPath(sku: string): string {
  return `photos/${sku}.thumb.webp`;
}

export interface PhotoPolicy {
  /**
   * URL absoluta de la carpeta de la página (con "/" al final), p. ej. `https://host/x/y/z/`. Las rutas
   * relativas se resuelven contra ella; sin esto se devuelven tal cual.
   */
  photoBase?: string | undefined;
  /**
   * true = la vista previa: nunca se devuelve una foto de otro servidor (CDN, etc.); solo rutas propias,
   * `data:` y `blob:`.
   */
  localOnly?: boolean | undefined;
}

/** ¿Apunta a otro servidor (o a cualquier esquema que no sea propio)? */
export function isExternalPhoto(url: string): boolean {
  const u = url.trim();
  if (/^(data|blob):/i.test(u)) return false;
  // "https://…", "http://…", "//cdn…", "ftp://…", "file:…": nada de eso es un archivo publicado junto a la página.
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u);
}

/**
 * Foto final de una variante según la política. Vacío si no hay o si no se puede servir sin salir a
 * internet (en modo `localOnly`).
 */
export function resolvePhoto(raw: string | undefined | null, policy: PhotoPolicy = {}): string {
  const url = (raw ?? '').trim();
  if (url === '') return '';
  if (isExternalPhoto(url)) return policy.localOnly ? '' : url;
  if (/^(data|blob):/i.test(url)) return url;
  // "/photos/x.webp" (la ruta pública del API) o "photos/x.webp": en la página publicada ambas viven
  // junto a la página, no en la raíz del servidor.
  const relative = url.replace(/^\/+/, '');
  if (!policy.photoBase) return policy.localOnly ? relative : url;
  try {
    return new URL(relative, policy.photoBase).href;
  } catch {
    return '';
  }
}
