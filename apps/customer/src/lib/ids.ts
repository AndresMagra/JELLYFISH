/** Clave de idempotencia (no es secreta): identifica un intento de pedido. */
export function randomKey(prefix = 'jf'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Hash corto y estable de un texto (para firmar el contenido de un pedido). */
export function shortHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
