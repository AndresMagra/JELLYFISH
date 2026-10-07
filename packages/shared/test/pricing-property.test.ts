import { describe, expect, it } from 'vitest';
import { allocateProportionally, computeOrderTotals, type PricedLineInput } from '../src';

/** Generador pseudoaleatorio con semilla: las corridas son reproducibles. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function randomCart(next: () => number): PricedLineInput[] {
  const n = 1 + Math.floor(next() * 6);
  return Array.from({ length: n }, (_, i) => {
    const byWeight = next() < 0.8;
    return {
      id: `L${i}`,
      pricingUnit: byWeight ? ('lb' as const) : ('unit' as const),
      unitPrice: 500 + Math.floor(next() * 120_000), // RD$ 5 a RD$ 1,200 por lb/unidad
      itbisBps: next() < 0.5 ? 1800 : 0,
      quantity: byWeight ? 50 * (1 + Math.floor(next() * 80)) : 1 + Math.floor(next() * 5),
      variableWeight: byWeight,
    };
  });
}

describe('totales del pedido: invariantes con carritos y descuentos aleatorios', () => {
  it('el descuento se reparte sin perder ni inventar centavos y nada queda negativo', () => {
    const next = rng(20261007);
    for (let run = 0; run < 3000; run++) {
      const cart = randomCart(next);
      const base = computeOrderTotals(cart);
      const asked = Math.floor(next() * (base.subtotal * 1.3));
      const fee = Math.floor(next() * 40_000);
      const t = computeOrderTotals(cart, { discount: asked, deliveryFee: fee });
      const label = `corrida ${run}`;

      // Nunca se descuenta más que el subtotal, y lo descontado es exactamente lo pedido (acotado).
      expect(t.discount, label).toBe(Math.min(asked, base.subtotal));
      expect(
        t.lines.reduce((a, l) => a + l.discount, 0),
        label,
      ).toBe(t.discount);
      // La aritmética del total cierra al centavo.
      expect(t.total, label).toBe(t.subtotal - t.discount + fee);
      expect(t.subtotal, label).toBe(t.lines.reduce((a, l) => a + l.gross, 0));
      for (const l of t.lines) {
        expect(l.discount, label).toBeGreaterThanOrEqual(0);
        expect(l.discount, label).toBeLessThanOrEqual(l.gross);
        expect(l.net, label).toBe(l.gross - l.discount);
        expect(l.itbis, label).toBeGreaterThanOrEqual(0);
        expect(l.itbis, label).toBeLessThanOrEqual(l.net);
        if (l.itbisBps === 0) expect(l.itbis, label).toBe(0);
      }
      expect(t.itbis, label).toBe(t.lines.reduce((a, l) => a + l.itbis, 0) + t.deliveryFeeItbis);
      // Un descuento reduce el ITBIS o lo deja igual, jamás lo aumenta.
      expect(t.itbis, label).toBeLessThanOrEqual(base.itbis);
    }
  });

  it('allocateProportionally: suma exacta, ninguna parte excede su peso y el orden manda en empates', () => {
    const next = rng(7);
    for (let run = 0; run < 3000; run++) {
      const weights = Array.from({ length: 1 + Math.floor(next() * 8) }, () =>
        Math.floor(next() * 90_000),
      );
      const total = weights.reduce((a, b) => a + b, 0);
      const amount = Math.floor(next() * (total + 500));
      const parts = allocateProportionally(amount, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total > 0 ? Math.min(amount, total) : 0);
      parts.forEach((p, i) => {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(weights[i] ?? 0);
      });
    }
    // Empate exacto: 1 centavo entre dos líneas iguales va a la primera, siempre.
    expect(allocateProportionally(1, [100, 100])).toEqual([1, 0]);
    expect(allocateProportionally(3, [100, 100])).toEqual([2, 1]);
  });
});
