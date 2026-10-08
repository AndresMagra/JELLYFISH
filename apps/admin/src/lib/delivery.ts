import type { OrderDTO } from '@jellyfish/shared';
import { dateTime } from './format';

/** Los mismos límites que el API para entregar sin el PIN del cliente. */
export const PIN_OVERRIDE_MIN_CHARS = 8;
export const PIN_OVERRIDE_MAX_CHARS = 300;

export interface OverrideReasonCheck {
  /** El motivo ya recortado: es lo que se envía. */
  reason: string;
  length: number;
  /** Cuántos caracteres faltan para llegar al mínimo (0 si ya llega). */
  missing: number;
  valid: boolean;
}

export function checkOverrideReason(text: string): OverrideReasonCheck {
  const reason = text.trim();
  const length = reason.length;
  return {
    reason,
    length,
    missing: Math.max(0, PIN_OVERRIDE_MIN_CHARS - length),
    valid: length >= PIN_OVERRIDE_MIN_CHARS && length <= PIN_OVERRIDE_MAX_CHARS,
  };
}

export function overrideCounterText(text: string): string {
  const c = checkOverrideReason(text);
  if (c.length > PIN_OVERRIDE_MAX_CHARS) {
    return `${c.length} / ${PIN_OVERRIDE_MAX_CHARS} caracteres: es demasiado largo`;
  }
  if (c.missing > 0) {
    return `${c.length} de ${PIN_OVERRIDE_MIN_CHARS} caracteres como mínimo (faltan ${c.missing})`;
  }
  return `${c.length} / ${PIN_OVERRIDE_MAX_CHARS} caracteres`;
}

/**
 * ¿Se ofrece "Entregar sin PIN" en lugar de "Marcar entregado"? Solo personal o administrador,
 * con un pedido que exige PIN, aún sin verificar, y al que el flujo permite pasar a entregado.
 */
export function canOfferPinOverride(
  order: Pick<OrderDTO, 'pinRequired' | 'pinVerifiedAt' | 'next'>,
  role: string | undefined,
): boolean {
  return (
    (role === 'admin' || role === 'staff') &&
    order.pinRequired &&
    !order.pinVerifiedAt &&
    order.next.includes('delivered')
  );
}

export const pinRequiredText = (required: boolean) => (required ? 'Sí' : 'No');

/** Intentos de PIN que le quedan al repartidor: 0 = bloqueado; null = el pedido no usa PIN. */
export function pinAttemptsText(left: number | null): string {
  if (left === null) return 'No aplica';
  if (left <= 0) return 'Bloqueado';
  return left === 1 ? '1 intento' : `${left} intentos`;
}

export function pinVerifiedText(
  order: Pick<OrderDTO, 'pinRequired' | 'pinVerifiedAt' | 'pinOverrideReason'>,
): string {
  if (!order.pinRequired) return 'No aplica';
  if (order.pinVerifiedAt) return `Verificado el ${dateTime(order.pinVerifiedAt)}`;
  if (order.pinOverrideReason) return 'No verificado: se entregó sin PIN';
  return 'Aún sin verificar';
}
