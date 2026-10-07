/**
 * Reglas del PIN de entrega (4 dígitos que el cliente le dice al repartidor) y cómo explicar cada
 * respuesta del API. Sin dependencias de React Native: se prueba en Node.
 *
 * Códigos del API (docs/features/entrega.md): pin_required (400), pin_incorrect (409,
 * details.attemptsLeft), pin_locked (423), cash_not_collected (409), validation (400).
 */

export const PIN_LENGTH = 4;
export const PIN_MAX_ATTEMPTS = 5;

/** Solo dígitos, máximo 4 (pegar "12 34" o "12-34" también funciona). */
export const sanitizePin = (raw: string): string => raw.replace(/\D/g, '').slice(0, PIN_LENGTH);

export const isCompletePin = (pin: string): boolean => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

/** "Te queda 1 intento." / "Te quedan 3 intentos." */
export function attemptsText(left: number): string {
  return left === 1 ? 'Te queda 1 intento.' : `Te quedan ${left} intentos.`;
}

export const LOCKED_MESSAGE =
  'Se acabaron los intentos y el pedido quedó bloqueado. Pídele al administrador que autorice la entrega.';

export type PinFailure =
  /** PIN equivocado: se muestran los intentos que quedan. */
  | { kind: 'incorrect'; attemptsLeft: number | null; lastChance: boolean; message: string }
  /** Sin intentos: solo administración puede cerrar la entrega. */
  | { kind: 'locked'; message: string }
  /** El API exige cobrar el efectivo antes: se vuelve al paso de cobrar. */
  | { kind: 'cash_not_collected'; message: string }
  /** El pedido pide PIN y no se mandó (datos viejos): hay que pedirlo. */
  | { kind: 'required'; message: string }
  | { kind: 'other'; message: string };

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  details?: unknown;
}

/** Convierte un error del API (ApiError) en lo que la pantalla debe mostrar. */
export function classifyPinError(error: unknown): PinFailure {
  const e: ErrorLike = error && typeof error === 'object' ? (error as ErrorLike) : {};
  const text =
    typeof e.message === 'string' && e.message ? e.message : 'Algo salió mal. Intenta de nuevo.';

  if (e.code === 'pin_locked' || e.status === 423)
    return { kind: 'locked', message: LOCKED_MESSAGE };

  if (e.code === 'pin_incorrect') {
    const raw = (e.details as { attemptsLeft?: unknown } | null | undefined)?.attemptsLeft;
    const left = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
    if (left === 0) return { kind: 'locked', message: LOCKED_MESSAGE };
    return {
      kind: 'incorrect',
      attemptsLeft: left,
      lastChance: left === 1,
      message: left === null ? text : `PIN incorrecto. ${attemptsText(left)}`,
    };
  }

  if (e.code === 'cash_not_collected') {
    return {
      kind: 'cash_not_collected',
      message: 'Primero cobra el efectivo al cliente y luego pide el PIN.',
    };
  }
  if (e.code === 'pin_required') {
    return { kind: 'required', message: 'Pídele al cliente el PIN de 4 dígitos para entregar.' };
  }
  return { kind: 'other', message: text };
}
