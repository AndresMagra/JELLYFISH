import { describe, expect, it } from 'vitest';
import { centavosToPesos, lbToCentilb, pesosToCentavos } from '../src/lib/format';

// Cifras inventadas: ningún dato real del negocio.
describe('pesosToCentavos: la coma separa miles y el punto los decimales', () => {
  it.each([
    ['150', 15_000],
    ['150.5', 15_050],
    ['150.50', 15_050],
    ['0', 0],
    ['0.01', 1],
    ['174.95', 17_495], // 174.95 * 100 en coma flotante da 17494.999…
    ['1,234.50', 123_450],
    ['1,234', 123_400], // miles, no 1 peso con 234 milésimas
    ['12,345', 1_234_500],
    ['123,456.7', 12_345_670],
    ['1,234,567.89', 123_456_789],
    ['1234567', 123_456_700], // sin separadores también vale
    ['RD$ 90', 9_000],
    ['rd$90', 9_000],
    ['RD$ 1,250.75', 125_075],
    ['  150  ', 15_000],
    ['1 234', 123_400], // los espacios se ignoran, como con RD$
  ])('%j son %i centavos', (text, centavos) => {
    expect(pesosToCentavos(text)).toBe(centavos);
  });

  it.each([
    ['150,50', 'sería 15 050 pesos, no 150.50'],
    ['12,5', 'una coma decimal'],
    ['85,50', 'el costo de un lote con coma decimal'],
    [',5', 'sin dígitos antes de la coma'],
    ['1,23', 'grupo de dos'],
    ['1,2345', 'grupo de cuatro'],
    ['1,234,56', 'último grupo incompleto'],
    ['12,34,567', 'grupos al estilo indio'],
    ['1234,567', 'el primer grupo se pasa de tres dígitos'],
    ['0,500', 'un cero antes de la coma de miles'],
    ['01,234', 'un cero a la izquierda en el primer grupo'],
    ['1,234,', 'coma al final'],
    ['1,,234', 'comas seguidas'],
    ['1,234.567', 'tres decimales'],
    ['1.234,50', 'estilo europeo'],
    ['1,234,5', 'miles y un dígito suelto'],
  ])('rechaza %j (%s)', (text) => {
    expect(pesosToCentavos(text)).toBeNull();
  });

  it.each(['', '   ', 'RD$', 'abc', '-5', '+5', '1e3', '.5', '5.', '1.234', '10 %', '1..5'])(
    'rechaza %j',
    (text) => {
      expect(pesosToCentavos(text)).toBeNull();
    },
  );

  it('lo que el panel escribe en un campo vuelve a leerse igual', () => {
    for (const centavos of [0, 1, 99, 15_050, 17_495, 123_450, 100_000_000]) {
      expect(pesosToCentavos(centavosToPesos(centavos))).toBe(centavos);
    }
  });
});

describe('lbToCentilb', () => {
  it('acepta coma o punto decimal en las libras', () => {
    expect(lbToCentilb('2.5')).toBe(250);
    expect(lbToCentilb('2,5')).toBe(250);
    expect(lbToCentilb(' 10 ')).toBe(1000);
    expect(lbToCentilb('1.15')).toBe(115);
  });
  it('rechaza más de dos decimales y lo que no es número', () => {
    expect(lbToCentilb('1.234')).toBeNull();
    expect(lbToCentilb('')).toBeNull();
    expect(lbToCentilb('-1')).toBeNull();
    expect(lbToCentilb('dos')).toBeNull();
  });
});
