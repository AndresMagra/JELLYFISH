/**
 * Deja el código de cupón como lo espera el servidor: sin espacios, sin guiones raros de teclado y
 * en mayúsculas ("  jelly 10 " → "JELLY10"). Vacío si no queda nada.
 */
export function normalizeCouponCode(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-') // guiones tipográficos → "-"
    .replace(/\s+/g, '')
    .toUpperCase()
    .slice(0, 32);
}
