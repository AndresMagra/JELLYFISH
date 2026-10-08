import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { testConfig } from '../../api/src/config';
import {
  EXPIRING_SOON_DAYS as SERVER_EXPIRING_SOON_DAYS,
  MAX_DAYS_FUTURE as SERVER_MAX_DAYS_FUTURE,
  MAX_DAYS_PAST as SERVER_MAX_DAYS_PAST,
  classifyLot,
  daysBetween as serverDaysBetween,
  isCalendarDate as serverIsCalendarDate,
  localDate,
} from '../../api/src/services/lots';
import {
  EXPIRING_SOON_DAYS,
  EXPIRING_WINDOWS,
  LOT_STATUS,
  MAX_DAYS_FUTURE,
  MAX_DAYS_PAST,
  checkExpiresOn,
  checkLotForm,
  daysBetween,
  daysLeftText,
  expiryAlertText,
  expiryDateLabel,
  isCalendarDate,
  LOTS_LIMIT,
  MATCH_LIMIT,
  lotsLimitNote,
  matchVariants,
  parseLotCost,
  parseLotQuantity,
  searchVariants,
  todayInRD,
  truncatedMatchText,
  type LotFormInput,
} from '../src/lib/lots';

const TODAY = '2026-10-08';

describe('fechas de RD', () => {
  it('todayInRD usa UTC-4: de madrugada en UTC todavía es el día anterior', () => {
    expect(todayInRD(new Date('2026-10-08T03:59:00Z'))).toBe('2026-10-07');
    expect(todayInRD(new Date('2026-10-08T04:00:00Z'))).toBe('2026-10-08');
    expect(todayInRD(new Date('2026-10-08T23:59:00Z'))).toBe('2026-10-08');
  });
  it('isCalendarDate rechaza formatos y fechas imposibles', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true); // bisiesto
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-5')).toBe(false);
    expect(isCalendarDate('05/11/2026')).toBe(false);
    expect(isCalendarDate('')).toBe(false);
  });
  it('daysBetween cuenta días calendario, también al cruzar mes y año', () => {
    expect(daysBetween('2026-10-08', '2026-10-08')).toBe(0);
    expect(daysBetween('2026-10-08', '2026-10-11')).toBe(3);
    expect(daysBetween('2026-10-08', '2026-10-06')).toBe(-2);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
  it('expiryDateLabel da una fecha corta en español', () => {
    expect(expiryDateLabel('2026-11-05')).toBe('5 nov 2026');
    expect(expiryDateLabel('2027-01-31')).toBe('31 ene 2027');
    expect(expiryDateLabel(null)).toBe('—');
    expect(expiryDateLabel('mañana')).toBe('—');
  });
});

describe('daysLeftText', () => {
  it('hoy, mañana y ayer tienen su palabra', () => {
    expect(daysLeftText(0)).toBe('vence hoy');
    expect(daysLeftText(1)).toBe('vence mañana');
    expect(daysLeftText(-1)).toBe('venció ayer');
  });
  it('varios días en plural', () => {
    expect(daysLeftText(3)).toBe('vence en 3 días');
    expect(daysLeftText(7)).toBe('vence en 7 días');
    expect(daysLeftText(-2)).toBe('venció hace 2 días');
    expect(daysLeftText(-30)).toBe('venció hace 30 días');
  });
  it('sin fecha o con un valor raro no inventa un número', () => {
    expect(daysLeftText(null)).toBe('sin vencimiento');
    expect(daysLeftText(Number.NaN)).toBe('sin vencimiento');
  });
});

describe('estado y alertas', () => {
  it('cada estado del API tiene etiqueta y tono', () => {
    expect(LOT_STATUS.expired).toEqual({ label: 'Vencido', tone: 'danger' });
    expect(LOT_STATUS.expiring.tone).toBe('warning');
    expect(LOT_STATUS.ok.tone).toBe('success');
    expect(LOT_STATUS.no_expiry.tone).toBe('neutral');
  });
  it('los textos de alerta concuerdan en singular y plural', () => {
    expect(expiryAlertText('expiring', 1)).toBe('1 lote vence en 7 días o menos');
    expect(expiryAlertText('expiring', 3)).toBe('3 lotes vencen en 7 días o menos');
    expect(expiryAlertText('expired', 1)).toBe('1 lote vencido con existencias');
    expect(expiryAlertText('expired', 12)).toBe('12 lotes vencidos con existencias');
  });
  it('la ventana de "por vencer" es la del API (importada del servidor)', () => {
    expect(EXPIRING_SOON_DAYS).toBe(SERVER_EXPIRING_SOON_DAYS);
    // El Resumen y el selector del panel arrancan en la misma ventana que usa el servidor.
    expect(EXPIRING_WINDOWS[0]).toBe(SERVER_EXPIRING_SOON_DAYS);
    expect(Math.max(...EXPIRING_WINDOWS)).toBeLessThanOrEqual(365); // tope de GET /expiring
  });
  it('un lote con exactamente EXPIRING_SOON_DAYS días ya cuenta como por vencer en el servidor', () => {
    const today = '2026-10-08';
    const edge = (n: number) => {
      const d = new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000);
      return d.toISOString().slice(0, 10);
    };
    expect(classifyLot(edge(EXPIRING_SOON_DAYS), today).status).toBe('expiring');
    expect(classifyLot(edge(EXPIRING_SOON_DAYS + 1), today).status).toBe('ok');
    expect(classifyLot(edge(-1), today).status).toBe('expired');
  });
});

describe('cantidad según la unidad', () => {
  it('por libra: libras con decimales → centilibras', () => {
    expect(parseLotQuantity('25', 'lb')).toBe(2500);
    expect(parseLotQuantity('12.5', 'lb')).toBe(1250);
    expect(parseLotQuantity('12,5', 'lb')).toBe(1250);
    expect(parseLotQuantity('0.25', 'lb')).toBe(25);
    expect(parseLotQuantity('1.15', 'lb')).toBe(115); // sin error de coma flotante
    expect(parseLotQuantity(' 3 ', 'lb')).toBe(300);
  });
  it('por libra: rechaza cero, tres decimales, texto y negativos', () => {
    expect(parseLotQuantity('0', 'lb')).toBeNull();
    expect(parseLotQuantity('0.00', 'lb')).toBeNull();
    expect(parseLotQuantity('1.234', 'lb')).toBeNull();
    expect(parseLotQuantity('-2', 'lb')).toBeNull();
    expect(parseLotQuantity('dos', 'lb')).toBeNull();
    expect(parseLotQuantity('', 'lb')).toBeNull();
  });
  it('por unidad: solo enteros, sin multiplicar', () => {
    expect(parseLotQuantity('24', 'unit')).toBe(24);
    expect(parseLotQuantity(' 6 ', 'unit')).toBe(6);
    expect(parseLotQuantity('2.5', 'unit')).toBeNull();
    expect(parseLotQuantity('0', 'unit')).toBeNull();
    expect(parseLotQuantity('-1', 'unit')).toBeNull();
    expect(parseLotQuantity('', 'unit')).toBeNull();
  });
  it('respeta el tope del API (1 000 000 000)', () => {
    expect(parseLotQuantity('1000000000', 'unit')).toBe(1_000_000_000);
    expect(parseLotQuantity('1000000001', 'unit')).toBeNull();
    expect(parseLotQuantity('10000000', 'lb')).toBe(1_000_000_000); // 10 millones de lb
    expect(parseLotQuantity('10000001', 'lb')).toBeNull();
  });
});

describe('costo opcional', () => {
  it('vacío = sin costo; con monto = centavos', () => {
    expect(parseLotCost('')).toBeNull();
    expect(parseLotCost('   ')).toBeNull();
    expect(parseLotCost('85')).toBe(8500);
    expect(parseLotCost('85.5')).toBe(8550);
    expect(parseLotCost('RD$ 1,250.75')).toBe(125_075);
    expect(parseLotCost('0')).toBe(0);
  });
  it('inválido = undefined (distinto de "sin costo")', () => {
    expect(parseLotCost('abc')).toBeUndefined();
    expect(parseLotCost('-5')).toBeUndefined();
    expect(parseLotCost('1.234')).toBeUndefined();
    expect(parseLotCost('85,50')).toBeUndefined(); // la coma separa miles: no son 85 500 pesos
    expect(parseLotCost('12,5')).toBeUndefined();
    expect(parseLotCost('1,250')).toBe(125_000);
    expect(parseLotCost('1000000.01')).toBeUndefined(); // pasa de 100 000 000 centavos
    expect(parseLotCost('1000000')).toBe(100_000_000);
  });
});

describe('fecha de vencimiento', () => {
  it('acepta hoy, el pasado reciente y el futuro razonable', () => {
    expect(checkExpiresOn(TODAY, TODAY)).toBeNull();
    expect(checkExpiresOn('2026-09-08', TODAY)).toBeNull(); // hace 30 días justos
    expect(checkExpiresOn('2027-03-01', TODAY)).toBeNull();
  });
  it('rechaza vacío, mal formato y fechas imposibles', () => {
    expect(checkExpiresOn('', TODAY)).toMatch(/Elige/);
    expect(checkExpiresOn('2026-02-30', TODAY)).toMatch(/válida/);
    expect(checkExpiresOn('08/10/2026', TODAY)).toMatch(/válida/);
  });
  it('los bordes del pasado y del futuro son los del servidor (importados de él)', () => {
    expect(MAX_DAYS_PAST).toBe(SERVER_MAX_DAYS_PAST);
    expect(MAX_DAYS_FUTURE).toBe(SERVER_MAX_DAYS_FUTURE);
    const day = (n: number) =>
      new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    // Justo en el borde vale; un día más allá, no: con los topes del servidor, no con números copiados.
    expect(checkExpiresOn(day(-SERVER_MAX_DAYS_PAST), TODAY)).toBeNull();
    expect(checkExpiresOn(day(-SERVER_MAX_DAYS_PAST - 1), TODAY)).toMatch(
      new RegExp(`más de ${SERVER_MAX_DAYS_PAST} días`),
    );
    expect(checkExpiresOn(day(SERVER_MAX_DAYS_FUTURE), TODAY)).toBeNull();
    expect(checkExpiresOn(day(SERVER_MAX_DAYS_FUTURE + 1), TODAY)).toMatch(/demasiado lejos/);
  });
  it('las fechas se leen igual que en el servidor', () => {
    for (const v of ['2026-02-28', '2028-02-29', '2026-02-29', '2026-13-01', '2026-1-5', '', 'x']) {
      expect(isCalendarDate(v), v).toBe(serverIsCalendarDate(v));
    }
    for (const [a, b] of [
      ['2026-10-08', '2026-10-08'],
      ['2026-10-08', '2026-11-05'],
      ['2026-12-30', '2027-01-02'],
      ['2028-02-28', '2028-03-01'],
      ['2026-10-08', '2026-09-07'],
    ] as const) {
      expect(daysBetween(a, b)).toBe(serverDaysBetween(a, b));
    }
    // "hoy" en RD: el servidor usa el desfase de su configuración
    const { utcOffsetMinutes } = testConfig();
    for (const iso of ['2026-10-08T03:59:00Z', '2026-10-08T04:00:00Z', '2026-12-31T23:59:00Z']) {
      expect(todayInRD(new Date(iso))).toBe(localDate(new Date(iso), utcOffsetMinutes));
    }
  });
});

describe('buscar el artículo', () => {
  const items = [
    { productName: 'Camarón', variant: 'Pelado 16/20', sku: 'JF-MAR-001' },
    { productName: 'Pechuga de pollo', variant: 'Sin hueso', sku: 'JF-AVE-001' },
    { productName: 'Muslo de pollo', variant: '', sku: 'JF-AVE-002' },
    { productName: 'Chuleta de cerdo', variant: 'Ahumada', sku: 'JF-CDO-001' },
  ];
  it('ignora mayúsculas y tildes', () => {
    expect(matchVariants(items, 'CAMARON').map((i) => i.sku)).toEqual(['JF-MAR-001']);
    expect(matchVariants(items, 'camarón').map((i) => i.sku)).toEqual(['JF-MAR-001']);
  });
  it('todas las palabras deben aparecer, en cualquier orden', () => {
    expect(matchVariants(items, 'pollo hueso').map((i) => i.sku)).toEqual(['JF-AVE-001']);
    expect(matchVariants(items, 'hueso pollo').map((i) => i.sku)).toEqual(['JF-AVE-001']);
    expect(matchVariants(items, 'pollo').map((i) => i.sku)).toEqual(['JF-AVE-001', 'JF-AVE-002']);
  });
  it('encuentra por SKU y no devuelve nada con la búsqueda vacía', () => {
    expect(matchVariants(items, 'jf-cdo-001').map((i) => i.sku)).toEqual(['JF-CDO-001']);
    expect(matchVariants(items, '')).toEqual([]);
    expect(matchVariants(items, '   ')).toEqual([]);
    expect(matchVariants(items, 'langosta')).toEqual([]);
  });
  it('corta en el límite', () => {
    expect(matchVariants(items, 'jf', 2)).toHaveLength(2);
  });
});

describe('la lista se corta y se avisa', () => {
  const many = Array.from({ length: 23 }, (_, i) => ({
    productName: `Corte ${i}`,
    variant: '',
    sku: `JF-${String(i).padStart(3, '0')}`,
  }));
  it('searchVariants devuelve los primeros y cuántos coinciden en total', () => {
    const r = searchVariants(many, 'corte');
    expect(MATCH_LIMIT).toBe(10);
    expect(r.shown).toHaveLength(10);
    expect(r.total).toBe(23);
    expect(searchVariants(many, 'corte 22')).toEqual({ shown: [many[22]], total: 1 });
    expect(searchVariants(many, '')).toEqual({ shown: [], total: 0 });
    expect(searchVariants(many, 'corte', 30).shown).toHaveLength(23);
  });
  it('el aviso solo sale cuando la lista se cortó', () => {
    expect(truncatedMatchText(10, 23)).toBe('Mostrando 10 de 23: afina la búsqueda');
    expect(truncatedMatchText(10, 10)).toBe('');
    expect(truncatedMatchText(3, 3)).toBe('');
  });
  it('el tope de lotes es el máximo del API y el aviso sale al llegar a él', () => {
    // El servidor lo tiene solo como literal en el esquema de la ruta: se lee de ahí.
    const route = readFileSync(new URL('../../api/src/routes/lots.ts', import.meta.url), 'utf8');
    const max = /limit:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\((\d+)\)/.exec(route)?.[1];
    expect(max, 'no se encontró el límite en routes/lots.ts').toBeDefined();
    expect(LOTS_LIMIT).toBe(Number(max));
    expect(lotsLimitNote(LOTS_LIMIT - 1)).toBe('');
    expect(lotsLimitNote(LOTS_LIMIT)).toMatch(/solo los 500 lotes/);
    expect(lotsLimitNote(0)).toBe('');
  });
});

describe('formulario de recepción', () => {
  const ok: LotFormInput = {
    variantId: 'v-1',
    pricingUnit: 'lb',
    lotCode: '  L-2410-A ',
    expiresOn: '2026-11-20',
    quantity: '25.5',
    cost: '85',
    note: ' entrega del lunes ',
  };
  it('arma el cuerpo del API: centilibras, centavos, textos recortados', () => {
    const r = checkLotForm(ok, TODAY);
    expect(r.errors).toEqual({});
    expect(r.body).toEqual({
      variantId: 'v-1',
      lotCode: 'L-2410-A',
      expiresOn: '2026-11-20',
      quantity: 2550,
      unitCostCentavos: 8500,
      note: 'entrega del lunes',
    });
  });
  it('un artículo por unidad manda unidades y el costo vacío va como null', () => {
    const r = checkLotForm({ ...ok, pricingUnit: 'unit', quantity: '24', cost: '' }, TODAY);
    expect(r.body?.quantity).toBe(24);
    expect(r.body?.unitCostCentavos).toBeNull();
  });
  it('sin artículo no hay cuerpo y se pide elegirlo', () => {
    const r = checkLotForm({ ...ok, variantId: null, pricingUnit: null }, TODAY);
    expect(r.body).toBeNull();
    expect(r.errors.variant).toBeDefined();
    expect(r.errors.quantity).toBeUndefined(); // no se sabe la unidad todavía
  });
  it('señala cada campo malo por separado', () => {
    const r = checkLotForm(
      { ...ok, lotCode: '   ', expiresOn: '', quantity: '0', cost: 'mucho', note: 'x'.repeat(301) },
      TODAY,
    );
    expect(r.body).toBeNull();
    expect(Object.keys(r.errors).sort()).toEqual([
      'cost',
      'expiresOn',
      'lotCode',
      'note',
      'quantity',
    ]);
  });
  it('el código del lote: máximo 40 y sin caracteres de control', () => {
    expect(checkLotForm({ ...ok, lotCode: 'A'.repeat(40) }, TODAY).body).not.toBeNull();
    expect(checkLotForm({ ...ok, lotCode: 'A'.repeat(41) }, TODAY).errors.lotCode).toBeDefined();
    expect(checkLotForm({ ...ok, lotCode: 'L-1\u0007' }, TODAY).errors.lotCode).toBeDefined();
  });
  it('un costo con coma decimal marca el campo en vez de multiplicarlo por cien', () => {
    const r = checkLotForm({ ...ok, cost: '85,50' }, TODAY);
    expect(r.body).toBeNull();
    expect(r.errors.cost).toMatch(/monto en pesos/);
  });
  it('el mensaje de cantidad depende de la unidad', () => {
    const lb = checkLotForm({ ...ok, quantity: 'x' }, TODAY).errors.quantity;
    const unit = checkLotForm({ ...ok, pricingUnit: 'unit', quantity: '1.5' }, TODAY).errors
      .quantity;
    expect(lb).toMatch(/libras/);
    expect(unit).toMatch(/unidades/);
  });
});
