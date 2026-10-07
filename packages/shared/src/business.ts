/**
 * Datos del negocio que aparecen en los textos legales y en la app.
 *
 * IMPORTANTE: los datos que todavía no existen NO se inventan: llevan el marcador
 * `PENDING` ("[por definir]"). Antes de abrir a clientes reales, el dueño reemplaza cada
 * marcador por el dato verdadero (razón social y RNC tal como constan en la DGII, dirección
 * física, teléfono y correo de soporte) y revisa los textos con su asesor legal.
 */
export const PENDING = '[por definir]';

export const BUSINESS = {
  /** Nombre comercial (la marca). */
  tradeName: 'JELLYFISH',
  /** Razón social registrada. */
  legalName: PENDING,
  /** RNC del negocio. */
  taxId: PENDING,
  /** Dirección física del negocio. */
  address: PENDING,
  /** Teléfono de atención al cliente. */
  phone: PENDING,
  /** Correo de soporte (también para pedir acceso, corrección o borrado de datos). */
  supportEmail: PENDING,
  /** País donde opera y cuyas leyes aplican. */
  country: 'República Dominicana',
  /** Moneda de todos los precios. */
  currency: 'DOP',
} as const;

export type BusinessData = { [K in keyof typeof BUSINESS]: string };

/** ¿Este dato del negocio sigue sin definirse? */
export function isPending(value: string): boolean {
  return value.includes(PENDING);
}

/** Campos del negocio que todavía faltan (para avisar al dueño antes de publicar). */
export function pendingBusinessFields(business: BusinessData = BUSINESS): string[] {
  return Object.entries(business)
    .filter(([, v]) => isPending(v))
    .map(([k]) => k);
}
