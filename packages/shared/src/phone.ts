/**
 * Teléfonos dominicanos. Los celulares y fijos de RD usan el plan norteamericano:
 * +1 con códigos de área 809, 829 y 849.
 */
const DR_AREA_CODES = ['809', '829', '849'] as const;

/**
 * Devuelve el número en formato E.164 (+18095551234) o null si no es un número dominicano válido.
 * Acepta "809-555-1234", "(829) 555 1234", "18495551234", "+1 809 555 1234".
 */
export function normalizeDominicanPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '');
  const national =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : null;
  if (!national) return null;
  const area = national.slice(0, 3);
  if (!(DR_AREA_CODES as readonly string[]).includes(area)) return null;
  // El número local no puede empezar con 0 ni 1 en el plan norteamericano.
  if (/^[01]/.test(national.slice(3))) return null;
  return `+1${national}`;
}

/** "+18095551234" → "(809) 555-1234" */
export function formatDominicanPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
