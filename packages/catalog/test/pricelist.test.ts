import { describe, expect, it } from 'vitest';
import {
  LARGE_CHANGE_PCT,
  catalogToCsv,
  consumerPrice,
  mergePriceListIntoCatalog,
  parseCatalogCsv,
  parseCatalogExport,
  parsePercentToBps,
  parsePriceListRows,
  priceListToCatalog,
  type CatalogItem,
  type Cell,
  type PriceListMeta,
  type PriceListRow,
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

// ───────────── actualizar un catálogo que ya existe ─────────────

/** Un artículo del servidor con todo lo que el dueño pudo haber editado a mano. */
const stored = (over: Partial<CatalogItem>): CatalogItem => ({
  sku: 'X-0',
  group: 'g-0',
  name: 'Producto',
  variant: '',
  category: 'mariscos',
  subcategory: 'Camarones',
  pricingUnit: 'lb',
  stepCentilb: 50,
  minCentilb: 100,
  pieceCentilb: 250,
  price: 9_999,
  priceSource: 'estimado',
  priceNote: 'nota vieja',
  cost: null,
  stock: 12_345,
  itbisBps: null,
  variableWeight: true,
  frozen: true,
  synonyms: ['gambas', 'shrimp'],
  description: 'Descripción que el dueño editó a mano',
  cookingTip: 'Su propio consejo',
  photo: '/photos/ya-subida.webp',
  photoIllustrative: true,
  active: true,
  ...over,
});

const row = (over: Partial<PriceListRow>): PriceListRow => ({
  line: 3,
  section: 'MARISCOS IMPORTADOS',
  name: 'CAMARON 10/20',
  presentation: 'CAJAS DE 20 LBS',
  listPrice: 10_000,
  taxed: true,
  ...over,
});

describe('mergePriceListIntoCatalog', () => {
  const rule = { marginBps: 2000, itbisMode: 'sobre' } as const;
  const opts = { rule, listDate: '02-02-2026' };
  const FIELDS_THAT_CHANGE = ['price', 'priceSource', 'priceNote', 'itbisBps', 'cost'] as const;

  const camaron = stored({ sku: 'T-1', group: 'camaron', name: 'Camarón', variant: '10/20' });
  const ribeye = stored({
    sku: 'T-3',
    group: 'ribeye',
    name: 'Ribeye',
    category: 'res',
    subcategory: 'Parrilla',
    priceSource: 'usuario',
    price: 20_000,
    itbisBps: 0,
    stock: 777,
    photo: '/photos/ribeye.webp',
  });
  const huerfano = stored({ sku: 'OLD-1', group: 'viejo', name: 'Ya no se vende', stock: 4_000 });
  const apagado = stored({ sku: 'OLD-2', group: 'apagado', name: 'Apagado', active: false });
  const current = [camaron, ribeye, huerfano, apagado];
  const { rows } = parsePriceListRows(TABLE);
  const merged = mergePriceListIntoCatalog(current, rows, META, opts);

  it('el export del servidor sobrevive al viaje por CSV (base de la garantía de no destruir)', () => {
    const back = parseCatalogExport(catalogToCsv(current));
    expect(back.errors).toEqual([]);
    expect(back.items).toEqual(current);
  });

  it('solo cambia precio, fuente, nota, ITBIS y costo; fotos, existencias y textos se conservan', () => {
    const cam = merged.items.find((i) => i.sku === 'T-1')!;
    expect(cam).toMatchObject({
      price: 14_160, // 100 × 1.20 × 1.18
      priceSource: 'usuario',
      itbisBps: 1800,
      cost: 10_000,
    });
    expect(cam.priceNote).toContain('02-02-2026');
    expect(cam.priceNote).toContain('CAJAS DE 20 LBS');
    for (const [before, after] of [
      [camaron, cam],
      [ribeye, merged.items.find((i) => i.sku === 'T-3')!],
    ] as const) {
      const rest = (i: CatalogItem) =>
        Object.fromEntries(
          Object.entries(i).filter(([k]) => !FIELDS_THAT_CHANGE.includes(k as never)),
        );
      expect(rest(after)).toEqual(rest(before));
    }
    expect(cam).toMatchObject({
      stock: 12_345,
      photo: '/photos/ya-subida.webp',
      description: 'Descripción que el dueño editó a mano',
      cookingTip: 'Su propio consejo',
      synonyms: ['gambas', 'shrimp'],
      variant: '10/20',
      pieceCentilb: 250,
    });
    expect(merged.items.find((i) => i.sku === 'T-3')).toMatchObject({
      price: 24_000,
      itbisBps: 0,
      stock: 777,
      photo: '/photos/ribeye.webp',
    });
  });

  it('lo que sale del importador del servidor (CSV) sigue teniendo fotos, existencias y textos', () => {
    const viaCsv = parseCatalogExport(catalogToCsv(merged.items));
    expect(viaCsv.errors).toEqual([]);
    const cam = viaCsv.items.find((i) => i.sku === 'T-1')!;
    expect(cam).toMatchObject({
      price: 14_160,
      stock: 12_345,
      photo: '/photos/ya-subida.webp',
      description: 'Descripción que el dueño editó a mano',
      synonyms: ['gambas', 'shrimp'],
    });
  });

  it('no modifica los arreglos de entrada', () => {
    expect(camaron.price).toBe(9_999);
    expect(camaron.priceSource).toBe('estimado');
    expect(current).toHaveLength(4);
  });

  it('lo que el listado no trae no se borra ni se toca, solo se lista', () => {
    expect(merged.items.find((i) => i.sku === 'OLD-1')).toEqual(huerfano);
    expect(merged.items.find((i) => i.sku === 'OLD-2')).toEqual(apagado);
    expect(merged.missing.map((i) => i.sku)).toEqual(['OLD-1']); // el apagado no se vuelve a ofrecer
    expect(merged.missingInactive).toBe(1);
    expect(merged.counts).toMatchObject({ missing: 1, deactivated: 0 });
  });

  it('con "desactivar" solo cambia activo, y solo en lo activo que ya no viene', () => {
    const off = mergePriceListIntoCatalog(current, rows, META, {
      ...opts,
      deactivateMissing: true,
    });
    expect(off.items.find((i) => i.sku === 'OLD-1')).toEqual({ ...huerfano, active: false });
    expect(off.items.find((i) => i.sku === 'OLD-2')).toEqual(apagado);
    expect(off.items.find((i) => i.sku === 'T-1')!.active).toBe(true);
    expect(off.counts.deactivated).toBe(1);
  });

  it('un artículo desactivado que sí viene en el listado recibe precio pero no se reactiva solo', () => {
    const r = mergePriceListIntoCatalog([{ ...camaron, active: false }], [row({})], META, opts);
    expect(r.items[0]).toMatchObject({ active: false, price: 14_160 });
    expect(r.rows[0]?.notes.join(' ')).toMatch(/desactivado/);
  });

  it('agrega lo nuevo al final, con su ficha o con valores por defecto, y con existencia 0', () => {
    const added = merged.items.slice(current.length);
    expect(added.map((i) => i.sku)).toEqual([
      expect.stringMatching(/^T-2$/),
      expect.stringMatching(/^JF-NEW-/),
    ]);
    expect(added.every((i) => i.stock === 0 && i.active && i.priceSource === 'usuario')).toBe(true);
    expect(added[0]).toMatchObject({ name: 'Anillas', price: 4_720, itbisBps: 1800 });
    expect(added[1]).toMatchObject({ name: 'Producto nuevo', category: 'res', price: 6_060 });
    expect(merged.rows.map((r) => r.status)).toEqual(['cambia', 'nuevo', 'cambia', 'sin-ficha']);
    expect(merged.counts).toMatchObject({ rows: 4, nuevo: 1, sinFicha: 1, cambia: 2, igual: 0 });
  });

  it('una variante nueva de un grupo que ya existe hereda los textos del grupo', () => {
    const meta = [
      ...META,
      {
        lista: 'CAMARON 99/99',
        sku: 'T-NEW',
        grupo: 'camaron',
        nombre: 'Camarón (texto de la ficha)',
        variante: '99/99',
        categoria: 'mariscos',
        descripcion: 'Descripción genérica de la ficha',
        sinonimos: ['otro'],
      },
    ];
    const r = mergePriceListIntoCatalog(
      [camaron],
      [row({}), row({ line: 4, name: 'CAMARON 99/99' })],
      meta,
      opts,
    );
    const nueva = r.items.find((i) => i.sku === 'T-NEW')!;
    expect(nueva).toMatchObject({
      group: 'camaron',
      name: 'Camarón',
      description: 'Descripción que el dueño editó a mano',
      synonyms: ['gambas', 'shrimp'],
      variant: '99/99',
      stock: 0,
    });
    // y el grupo sigue siendo coherente para el importador
    const check = parseCatalogExport(catalogToCsv(r.items));
    expect(check.errors).toEqual([]);
  });

  it('aplicar el mismo listado dos veces no cambia nada la segunda vez', () => {
    const second = mergePriceListIntoCatalog(merged.items, rows, META, opts);
    expect(second.items).toEqual(merged.items);
    expect(second.rows.map((r) => r.status)).toEqual(['igual', 'igual', 'igual', 'igual']);
    expect(second.counts).toMatchObject({ nuevo: 0, sinFicha: 0, cambia: 0, igual: 4 });
  });

  it('calcula el cambio en % contra el precio actual y resalta solo lo mayor que el límite', () => {
    expect(LARGE_CHANGE_PCT).toBe(25);
    const at = (listPrice: number, price: number) =>
      mergePriceListIntoCatalog(
        [stored({ sku: 'T-1', group: 'camaron', priceSource: 'usuario', price, itbisBps: 1800 })],
        [row({ listPrice })],
        META,
        { rule: { marginBps: 0, itbisMode: 'incluido' }, listDate: 'x', includeCost: false },
      ).rows[0]!;
    expect(at(12_500, 10_000)).toMatchObject({ changeBps: 2500, largeChange: false }); // +25 % justo
    expect(at(12_501, 10_000)).toMatchObject({ changeBps: 2501, largeChange: true });
    expect(at(7_500, 10_000)).toMatchObject({ changeBps: -2500, largeChange: false });
    expect(at(7_499, 10_000)).toMatchObject({ changeBps: -2501, largeChange: true });
    expect(at(10_000, 10_000)).toMatchObject({ status: 'igual', changeBps: 0, changed: [] });
  });

  it('un precio igual pero con ITBIS, costo o confirmación distintos cuenta como cambio', () => {
    const base = {
      sku: 'T-1',
      group: 'camaron',
      priceSource: 'usuario' as const,
      price: 14_160,
      itbisBps: 1800,
      cost: 10_000,
    };
    const go = (over: Partial<CatalogItem>) =>
      mergePriceListIntoCatalog([stored({ ...base, ...over })], [row({})], META, opts).rows[0]!;
    expect(go({})).toMatchObject({ status: 'igual', changed: [] });
    expect(go({ itbisBps: null })).toMatchObject({ status: 'cambia', changed: ['itbis'] });
    expect(go({ cost: 9_000 })).toMatchObject({ status: 'cambia', changed: ['costo'] });
    expect(go({ priceSource: 'estimado' })).toMatchObject({
      status: 'cambia',
      changed: ['origen'],
    });
    expect(go({ itbisBps: 0 }).notes.join(' ')).toContain('ITBIS de 0 % a 18 %');
  });

  it('sin guardar costo, el costo que ya tenía el artículo se respeta', () => {
    const r = mergePriceListIntoCatalog(
      [stored({ sku: 'T-1', group: 'camaron', cost: 5_555 })],
      [row({})],
      META,
      { ...opts, includeCost: false },
    );
    expect(r.items[0]?.cost).toBe(5_555);
    expect(r.items[0]?.priceNote).not.toContain('RD$');
  });

  it('dos filas que quedarían con el mismo SKU, o un artículo por unidad, impiden aplicar', () => {
    const dupMeta: PriceListMeta[] = [
      { lista: 'A', sku: 'DUP', grupo: 'a', nombre: 'A', categoria: 'res' },
      { lista: 'B', sku: 'DUP', grupo: 'b', nombre: 'B', categoria: 'res' },
    ];
    const dup = mergePriceListIntoCatalog(
      [],
      [row({ line: 5, name: 'A' }), row({ line: 6, name: 'B' })],
      dupMeta,
      opts,
    );
    expect(dup.errors).toEqual([expect.objectContaining({ line: 6, sku: 'DUP', field: 'ficha' })]);
    expect(dup.rows).toHaveLength(1);

    const unit = mergePriceListIntoCatalog(
      [
        stored({
          sku: 'T-1',
          group: 'camaron',
          pricingUnit: 'unit',
          stepCentilb: null,
          minCentilb: null,
        }),
      ],
      [row({})],
      META,
      opts,
    );
    expect(unit.errors).toEqual([expect.objectContaining({ sku: 'T-1', field: 'unidad' })]);
    expect(unit.items[0]?.price).toBe(9_999);
    expect(unit.missing).toEqual([]); // no lo da por "ya no viene"
  });

  it('con el catálogo vacío todo es nuevo y el resultado pasa por el importador', () => {
    const r = mergePriceListIntoCatalog([], rows, META, opts);
    expect(r.counts).toMatchObject({ nuevo: 3, sinFicha: 1, cambia: 0, igual: 0 });
    const again = parseCatalogCsv(catalogToCsv(r.items), { categories: ['mariscos', 'res'] });
    expect(again.errors).toEqual([]);
  });

  it('un título de sección desconocido cae en "otros" y avisa; "vegetales y otros" no avisa', () => {
    const go = (section: string) =>
      mergePriceListIntoCatalog([], [row({ section, name: 'COSA RARA' })], [], opts);
    const veg = go('VEGETALES Y OTROS');
    expect(veg.items[0]?.category).toBe('otros');
    expect(veg.warnings).toEqual([]);
    const cave = go('PRODUCTOS DE LA CAVE');
    expect(cave.items[0]?.category).toBe('otros');
    expect(cave.warnings.map((w) => w.field)).toEqual(['seccion']);
    expect(go('CORTE DE AVES IMPORTADOS').items[0]?.category).toBe('aves');
  });
});

describe('parseCatalogExport', () => {
  it('acepta las categorías que el propio archivo trae (aunque no estén publicadas)', () => {
    const csv = catalogToCsv([stored({ category: 'combos' }), stored({ sku: 'X-2', group: 'g2' })]);
    const r = parseCatalogExport(csv);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.category)).toEqual(['combos', 'mariscos']);
  });

  it('un catálogo vacío (solo cabecera) es válido; un archivo roto, un error claro', () => {
    const empty = parseCatalogExport(catalogToCsv([]));
    expect(empty).toMatchObject({ items: [], errors: [] });
    expect(parseCatalogExport('').errors[0]?.field).toBe('(archivo)');
    expect(parseCatalogExport('a,b\n"sin cerrar').errors[0]?.field).toBe('(archivo)');
  });
});

describe('parsePercentToBps', () => {
  it('entiende coma o punto, con o sin %', () => {
    expect(parsePercentToBps('12')).toBe(1200);
    expect(parsePercentToBps(' 12,5 % ')).toBe(1250);
    expect(parsePercentToBps('7.25')).toBe(725);
    expect(parsePercentToBps('0')).toBe(0);
    expect(parsePercentToBps('1000')).toBe(100_000);
  });

  it('rechaza vacío, texto, negativos, demasiados decimales y más de 1000 %', () => {
    for (const bad of [
      '',
      '  ',
      'abc',
      '-5',
      '1.234',
      '1,2,3',
      '1000.01',
      '1001',
      '12 por ciento',
    ]) {
      expect(parsePercentToBps(bad)).toBeNull();
    }
  });
});
