import { describe, expect, it } from 'vitest';
import { clampQuantity, stepDown, stepUp, type QuantityRules } from '../src';

const pollo: QuantityRules = { pricingUnit: 'lb', stepCentilb: 50, minCentilb: 100 };
const camaron: QuantityRules = { pricingUnit: 'lb', stepCentilb: 100, minCentilb: 100 };
const pavo: QuantityRules = { pricingUnit: 'lb', stepCentilb: 100, minCentilb: 800 };
const combo: QuantityRules = { pricingUnit: 'unit', stepCentilb: null, minCentilb: null };

describe('stepper de cantidad', () => {
  it('la primera pulsación de + parte del mínimo', () => {
    expect(stepUp(0, pollo)).toBe(100);
    expect(stepUp(0, pavo)).toBe(800); // pavo: mínimo 8 lb
    expect(stepUp(0, combo)).toBe(1);
  });

  it('sube y baja por el paso del artículo', () => {
    expect(stepUp(100, pollo)).toBe(150);
    expect(stepUp(100, camaron)).toBe(200);
    expect(stepDown(250, pollo)).toBe(200);
    expect(stepDown(3, combo)).toBe(2);
  });

  it('al bajar del mínimo la línea se quita', () => {
    expect(stepDown(100, pollo)).toBe(0);
    expect(stepDown(800, pavo)).toBe(0);
    expect(stepDown(1, combo)).toBe(0);
  });

  it('no pasa el máximo ni lo disponible', () => {
    expect(stepUp(10_000, pollo)).toBe(10_000);
    expect(stepUp(20, combo)).toBe(20);
    expect(stepUp(300, pollo, 320)).toBe(300); // 3.5 lb no cabe: solo hay 3.2
    expect(stepUp(250, pollo, 320)).toBe(300);
    expect(stepUp(0, pollo, 50)).toBe(0); // hay menos que el mínimo
  });

  it('ajusta cantidades arbitrarias a un múltiplo válido', () => {
    expect(clampQuantity(137, pollo)).toBe(100);
    expect(clampQuantity(40, pollo)).toBe(0);
    expect(clampQuantity(999_999, pollo)).toBe(10_000);
    expect(clampQuantity(250, pollo, 220)).toBe(200);
    expect(clampQuantity(-5, pollo)).toBe(0);
    expect(clampQuantity(Number.NaN, pollo)).toBe(0);
  });
});
