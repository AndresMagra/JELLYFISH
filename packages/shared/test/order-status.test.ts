import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  ORDER_STATUSES,
  assertTransition,
  canTransition,
  holdsStock,
  isTerminal,
  es,
} from '../src';

describe('máquina de estados del pedido', () => {
  it('permite el camino feliz completo', () => {
    const path = [
      'pending_payment',
      'confirmed',
      'picking',
      'packed',
      'out_for_delivery',
      'delivered',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('bloquea saltos y retrocesos', () => {
    expect(canTransition('pending_payment', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'picking')).toBe(false);
    expect(() => assertTransition('cancelled', 'confirmed')).toThrow(InvalidTransitionError);
  });

  it('permite reintentar una entrega fallida', () => {
    expect(canTransition('out_for_delivery', 'delivery_failed')).toBe(true);
    expect(canTransition('delivery_failed', 'out_for_delivery')).toBe(true);
  });

  it('marca estados terminales y de reserva de stock', () => {
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('delivered')).toBe(false);
    expect(holdsStock('picking')).toBe(true);
    expect(holdsStock('cancelled')).toBe(false);
    expect(holdsStock('delivered')).toBe(false);
  });

  it('tiene texto en español para cada estado', () => {
    for (const s of ORDER_STATUSES) {
      expect(es.orderStatusLabel[s]).toBeTruthy();
      expect(es.orderStatusHint[s]).toBeTruthy();
    }
  });
});
