import { describe, expect, it } from 'vitest';
import {
  ITBIS_EXEMPT_BPS,
  ITBIS_STANDARD_BPS,
  allocateProportionally,
  authorizationAmount,
  computeOrderTotals,
  formatDOP,
  formatLb,
  itbisIncluded,
  lbToCentilb,
  priceForWeight,
  toCentavos,
  type PricedLineInput,
} from '../src';

describe('dinero', () => {
  it('convierte pesos a centavos sin error de coma flotante', () => {
    expect(toCentavos(174.95)).toBe(17495);
    expect(toCentavos(0.1 + 0.2)).toBe(30);
    expect(toCentavos(879.95)).toBe(87995);
  });

  it('formatea en RD$', () => {
    expect(formatDOP(17495)).toBe('RD$ 174.95');
    expect(formatDOP(123450)).toBe('RD$ 1,234.50');
  });

  it('extrae el ITBIS incluido en un precio de góndola', () => {
    // 118.00 incluye 18.00 de ITBIS
    expect(itbisIncluded(11800, ITBIS_STANDARD_BPS)).toBe(1800);
    expect(itbisIncluded(11800, ITBIS_EXEMPT_BPS)).toBe(0);
  });

  it('rechaza montos no enteros', () => {
    expect(() => formatDOP(10.5)).toThrow(RangeError);
  });
});

describe('peso', () => {
  it('maneja libras como centilibras', () => {
    expect(lbToCentilb(1.5)).toBe(150);
    expect(formatLb(150)).toBe('1.5 lb');
    expect(formatLb(200)).toBe('2 lb');
    expect(formatLb(25)).toBe('0.25 lb');
  });

  it('calcula el precio por peso', () => {
    // 2.5 lb a RD$ 174.95/lb = 437.375 → 437.38 (redondeo half-up sobre centavos)
    expect(priceForWeight(17495, 250)).toBe(43738);
    expect(priceForWeight(29500, 100)).toBe(29500);
  });
});

describe('totales del pedido', () => {
  const pechuga: PricedLineInput = {
    id: 'pechuga',
    pricingUnit: 'lb',
    unitPrice: 17495,
    itbisBps: ITBIS_EXEMPT_BPS,
    quantity: 200,
    variableWeight: true,
  };
  const combo: PricedLineInput = {
    id: 'combo-sancocho',
    pricingUnit: 'unit',
    unitPrice: 118000,
    itbisBps: ITBIS_STANDARD_BPS,
    quantity: 2,
    variableWeight: false,
  };

  it('suma líneas por libra y por unidad', () => {
    const t = computeOrderTotals([pechuga, combo], { deliveryFee: 15000 });
    expect(t.subtotal).toBe(34990 + 236000);
    expect(t.total).toBe(34990 + 236000 + 15000);
    expect(t.itbis).toBe(itbisIncluded(236000, ITBIS_STANDARD_BPS));
    expect(t.variableWeightNet).toBe(34990);
  });

  it('reparte el descuento sin perder centavos y recalcula el ITBIS', () => {
    const t = computeOrderTotals([pechuga, combo], { discount: 10000 });
    expect(t.discount).toBe(10000);
    expect(t.lines.reduce((a, l) => a + l.discount, 0)).toBe(10000);
    expect(t.total).toBe(t.subtotal - 10000);
  });

  it('limita el descuento al subtotal', () => {
    const t = computeOrderTotals([pechuga], { discount: 99_999_999 });
    expect(t.discount).toBe(t.subtotal);
    expect(t.total).toBe(0);
  });

  it('allocateProportionally conserva el total exacto', () => {
    const parts = allocateProportionally(100, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('autoriza un colchón solo sobre la parte de peso variable', () => {
    const t = computeOrderTotals([pechuga, combo]);
    // colchón 10 % de 349.90 = 34.99
    expect(authorizationAmount(t)).toBe(t.total + 3499);
    const fixed = computeOrderTotals([combo]);
    expect(authorizationAmount(fixed)).toBe(fixed.total);
  });

  it('rechaza cantidades inválidas', () => {
    expect(() => computeOrderTotals([{ ...pechuga, quantity: 0 }])).toThrow(RangeError);
  });
});
