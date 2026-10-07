import { describe, expect, it } from 'vitest';
import {
  catalogToCsv,
  consumerPrice,
  parseCatalogCsv,
  parsePriceListRows,
  priceListToCatalog,
  type Cell,
  type PriceListMeta,
} from '../src';

// Cifras inventadas: el listado real del dueño es interno y no va en el repositorio.
const TABLE: Cell[][] = [
  [null, null, null, null],
  ['MARISCOS IMPORTADOS', null, null, 'PRECIOS'],
  ['*', 'CAMARON 10/20', 'CAJAS DE 20 LBS', 100],
  ['*', 'ANILLA DE CALAMAR', 'CAJAS DE 20 LBS', '33.33'],
  ['CORTE DE RES IMPORTADOS', null, null, null],
  [null, 'RIBEYE TEST ', 'CAJAS DE 60 LBS', 200],
  [' ', 'PRODUCTO NUEVO', 'CAJAS', 50.5],
];

const META: PriceListMeta[] = [
  {
    lista: 'camaron 10/20',
    sku: 'T-1',
    grupo: 'camaron',
    nombre: 'Camarón',
    variante: '10/20',
    categoria: 'mariscos',
  },
  {
    lista: 'ANILLA DE CALAMAR',
    sku: 'T-2',
    grupo: 'anillas',
    nombre: 'Anillas',
    categoria: 'mariscos',
  },
  { lista: 'Ribeye test', sku: 'T-3', grupo: 'ribeye', nombre: 'Ribeye', categoria: 'res' },
  { lista: 'YA NO EXISTE', sku: 'T-9', grupo: 'x', nombre: 'X', categoria: 'res' },
];

describe('consumerPrice', () => {
  const sobre = { marginBps: 1500, itbisMode: 'sobre' } as const;

  it('suma el beneficio y, a los gravados, el ITBIS encima', () => {
    expect(consumerPrice(10_000, true, sobre)).toBe(13_570); // 100 × 1.15 × 1.18
    expect(consumerPrice(10_000, false, sobre)).toBe(11_500); // exento: solo beneficio
  });

  it('con el listado ya con ITBIS incluido solo aplica el beneficio', () => {
    expect(consumerPrice(10_000, true, { marginBps: 1500, itbisMode: 'incluido' })).toBe(11_500);
  });

  it('redondea una sola vez, al centavo más cercano', () => {
    expect(consumerPrice(3_333, true, sobre)).toBe(4_523); // 4 522.881
    expect(consumerPrice(3_333, false, sobre)).toBe(3_833); // 3 832.95
    expect(consumerPrice(1, false, sobre)).toBe(1); // 1.15
    expect(consumerPrice(10_000, true, { marginBps: 0, itbisMode: 'sobre' })).toBe(11_800);
  });

  it('rechaza beneficios absurdos', () => {
    expect(() => consumerPrice(10_000, false, { marginBps: -1, itbisMode: 'sobre' })).toThrow();
    expect(() => consumerPrice(10_000, false, { marginBps: 0.5, itbisMode: 'sobre' })).toThrow();
  });
});

describe('parsePriceListRows', () => {
  const parsed = parsePriceListRows(TABLE);

  it('detecta secciones, asterisco, presentación y precio', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.name, r.section, r.taxed, r.listPrice])).toEqual([
      ['CAMARON 10/20', 'MARISCOS IMPORTADOS', true, 10_000],
      ['ANILLA DE CALAMAR', 'MARISCOS IMPORTADOS', true, 3_333],
      ['RIBEYE TEST', 'CORTE DE RES IMPORTADOS', false, 20_000],
      ['PRODUCTO NUEVO', 'CORTE DE RES IMPORTADOS', false, 5_050],
    ]);
    expect(parsed.rows[0]?.presentation).toBe('CAJAS DE 20 LBS');
    expect(parsed.rows[0]?.line).toBe(3);
  });

  it('reporta precios inválidos y productos repetidos con su fila', () => {
    const bad = parsePriceListRows([
      ['TITULO', null, null, null],
      ['*', 'A', 'CAJA', 'mucho'],
      [null, 'B', 'CAJA', 0],
      [null, 'b', 'CAJA', 10],
      [null, 'B ', 'CAJA', 11],
    ]);
    expect(bad.errors.map((e) => [e.line, e.field])).toEqual([
      [2, 'precio'],
      [3, 'precio'],
      [5, 'producto'],
    ]);
    expect(bad.rows).toHaveLength(1);
  });

  it('un archivo sin productos es un error, no un catálogo vacío', () => {
    expect(parsePriceListRows([[null, null, null, null]]).errors[0]?.field).toBe('(archivo)');
  });

  it('acepta precios con coma decimal o separador de miles', () => {
    const r = parsePriceListRows([
      ['T', null, null, null],
      [null, 'A', '', '1,250.50'],
      [null, 'B', '', '99,5'],
    ]);
    expect(r.rows.map((x) => x.listPrice)).toEqual([125_050, 9_950]);
  });
});

describe('priceListToCatalog', () => {
  const { rows } = parsePriceListRows(TABLE);
  const rule = { marginBps: 1500, itbisMode: 'sobre' } as const;
  const result = priceListToCatalog(rows, META, {
    rule,
    listDate: '01-01-2026',
    includeCost: false,
  });

  it('combina cada fila con su ficha (sin acentos ni mayúsculas) y fija precio e ITBIS', () => {
    const [camaron, anillas, ribeye] = result.items;
    expect(camaron).toMatchObject({
      sku: 'T-1',
      group: 'camaron',
      variant: '10/20',
      price: 13_570,
      itbisBps: 1800,
      priceSource: 'usuario',
      stock: 0,
    });
    expect(anillas).toMatchObject({ sku: 'T-2', price: 4_523, itbisBps: 1800 });
    expect(ribeye).toMatchObject({ sku: 'T-3', price: 23_000, itbisBps: 0 });
  });

  it('no guarda costo ni el precio del listado salvo que se pida', () => {
    expect(result.items.every((i) => i.cost === null)).toBe(true);
    expect(result.items.every((i) => !i.priceNote.includes('RD$'))).toBe(true);
    const withCost = priceListToCatalog(rows, META, { rule, listDate: 'x', includeCost: true });
    expect(withCost.items[0]?.cost).toBe(10_000);
    expect(withCost.items[0]?.priceNote).toContain('RD$100.00');
  });

  it('un producto nuevo se importa con valores por defecto y avisa', () => {
    const nuevo = result.items[3]!;
    expect(result.withoutMeta.map((r) => r.name)).toEqual(['PRODUCTO NUEVO']);
    expect(nuevo).toMatchObject({
      name: 'Producto nuevo',
      category: 'res',
      price: 5_808,
      itbisBps: 0,
    });
    expect(nuevo.sku).toMatch(/^JF-NEW-/);
    expect(result.warnings.some((w) => w.field === 'ficha')).toBe(true);
  });

  it('avisa de las fichas que ya no aparecen en el Excel', () => {
    expect(result.unusedMeta.map((m) => m.sku)).toEqual(['T-9']);
  });

  it('lo generado pasa por el mismo importador CSV que usa el panel', () => {
    const csv = catalogToCsv(result.items);
    const again = parseCatalogCsv(csv, { categories: ['mariscos', 'res'] });
    expect(again.errors).toEqual([]);
    expect(again.items.map((i) => i.price)).toEqual(result.items.map((i) => i.price));
  });
});
