import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { photoRefError } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import {
  CSV_COLUMNS,
  catalogToCsv,
  groupProducts,
  parseCatalogCsv,
  parseCsv,
  publishability,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '../../../data/catalog');
const categories = (
  JSON.parse(readFileSync(join(catalogDir, 'categories.json'), 'utf8')) as { slug: string }[]
).map((c) => c.slug);

const HEADER = 'sku,nombre,categoria,unidad,precio';
const parse = (csv: string) => parseCatalogCsv(csv, { categories });

describe('importador de catálogo', () => {
  it('importa una fila mínima con valores por defecto', () => {
    const r = parse(`${HEADER}\nPOL-1,Pechuga,aves,lb,174.95\n`);
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    const [item] = r.items;
    expect(item).toMatchObject({
      sku: 'POL-1',
      group: 'pechuga',
      pricingUnit: 'lb',
      price: 17495,
      priceSource: 'usuario',
      stepCentilb: 50,
      minCentilb: 100,
      variableWeight: true,
      frozen: true,
      active: true,
      itbisBps: null,
    });
  });

  it('acepta cabeceras con acentos, alias y punto y coma con coma decimal', () => {
    const csv =
      'SKU;Nombre;Categoría;Unidad;Precio_lb;ITBIS\nA-1;Chillo;pescados;libra;"429,95";exento\n';
    const r = parse(csv);
    expect(r.errors).toEqual([]);
    expect(r.items[0]).toMatchObject({ price: 42995, itbisBps: 0, pricingUnit: 'lb' });
  });

  it('interpreta ITBIS en distintas formas', () => {
    const csv = `${HEADER},itbis\nA,A,res,lb,300,18\nB,B,res,lb,300,18%\nC,C,res,lb,300,0\nD,D,res,lb,300,gravado\nE,E,res,lb,300,\n`;
    const r = parse(csv);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.itbisBps)).toEqual([1800, 1800, 0, 1800, null]);
  });

  it('reporta errores con fila, SKU y campo en español', () => {
    const csv = [
      HEADER,
      'A,Pollo,aves,lb,100',
      'A,Repetido,aves,lb,100',
      ',Sin sku,aves,lb,100',
      'C,Sin precio,aves,lb,',
      'D,Cat mala,frutas,lb,100',
      'E,Unidad mala,aves,caja,100',
      'F,Precio negativo,aves,lb,-5',
      'G,Decimales,aves,lb,10.555',
    ].join('\n');
    const r = parse(csv);
    expect(r.items.map((i) => i.sku)).toEqual(['A']);
    const byField = (field: string) => r.errors.filter((e) => e.field === field);
    expect(byField('sku').map((e) => e.line)).toEqual([3, 4]);
    expect(byField('precio').map((e) => e.sku)).toEqual(['C', 'F', 'G']);
    expect(byField('categoria')[0]?.message).toMatch(/Categoría desconocida/);
    expect(byField('unidad')[0]?.message).toMatch(/lb|unit/);
  });

  it('exige las columnas obligatorias', () => {
    const r = parse('sku,nombre\nA,Pollo\n');
    expect(r.items).toEqual([]);
    expect(r.errors.map((e) => e.field).sort()).toEqual(['categoria', 'precio', 'unidad']);
  });

  it('advierte de costo mayor al precio y de precios sospechosos', () => {
    const r = parse(
      `${HEADER},costo\nA,Pollo,aves,lb,100,150\nB,Caro,aves,lb,9000,\nC,Barato,aves,lb,5,\n`,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => `${w.sku}:${w.field}`).sort()).toEqual([
      'A:costo',
      'B:precio',
      'C:precio',
    ]);
  });

  it('valida que un grupo no mezcle productos distintos', () => {
    const csv = `${HEADER},grupo\nA,Camarón,mariscos,lb,300,cam\nB,Langosta,mariscos,lb,900,cam\n`;
    expect(parse(csv).errors.some((e) => e.field === 'grupo')).toBe(true);
  });

  it('convierte stock según la unidad', () => {
    const r = parse(`${HEADER},stock\nA,Pollo,aves,lb,100,12.5\nB,Combo,combos,unit,1500,7\n`);
    expect(r.items.map((i) => i.stock)).toEqual([1250, 7]);
    expect(parse(`${HEADER},stock\nB,Combo,combos,unit,1500,7.5\n`).errors[0]?.field).toBe('stock');
  });

  it('no permite publicar estimados ni ITBIS sin confirmar', () => {
    const csv = `${HEADER},precio_fuente,itbis\nA,A,res,lb,100,estimado,0\nB,B,res,lb,100,usuario,\nC,C,res,lb,100,usuario,0\nD,D,res,lb,100,ancla,18\n`;
    const r = parse(csv);
    expect(r.items.map((i) => publishability(i).publishable)).toEqual([false, false, true, true]);
    expect(publishability(r.items[0]!).reasons[0]).toMatch(/estimado/);
    expect(publishability(r.items[1]!).reasons[0]).toMatch(/ITBIS/);
  });

  it('exporta y reimporta sin pérdida', () => {
    const original = parse(
      `${HEADER},grupo,variante,peso_pieza_lb,itbis,sinonimos,stock\nA,Pollo entero,aves,lb,105.5,pollo,,4,0,"pollo;gallina",8.25\n`,
    );
    expect(original.errors).toEqual([]);
    const again = parse(catalogToCsv(original.items));
    expect(again.errors).toEqual([]);
    expect(again.items).toEqual(original.items);
  });

  it('exporta y reimporta sin pérdida también la foto y si es ilustrativa o real', () => {
    const original = parse(
      `${HEADER},foto,foto_ilustrativa\nA,Pollo,aves,lb,100,/photos/A.webp,no\nB,Res,res,lb,200,https://cdn.example.com/b.webp,si\nC,Cerdo,cerdo,lb,150,,\n`,
    );
    expect(original.errors).toEqual([]);
    expect(original.items.map((i) => i.photoIllustrative)).toEqual([false, true, true]);
    const again = parse(catalogToCsv(original.items));
    expect(again.errors).toEqual([]);
    expect(again.items).toEqual(original.items);
    expect(again.items.map((i) => [i.photo, i.photoIllustrative])).toEqual([
      ['/photos/A.webp', false],
      ['https://cdn.example.com/b.webp', true],
      ['', true],
    ]);
  });
});

describe('columna foto: solo se guarda una referencia válida', () => {
  /** Entre comillas: una URL `data:` lleva coma y partiría la fila. */
  const withPhoto = (photo: string, extra = '') =>
    parse(`${HEADER},foto${extra}\nA,Pollo,aves,lb,100,"${photo.replaceAll('"', '""')}"\n`);

  it('acepta vacía, una ruta local con una sola "/" y una URL http(s); recorta espacios', () => {
    const good = [
      '',
      '/photos/A.webp',
      'https://d8j0ntlcm91z4.cloudfront.net/user_x/hf_1.png',
      'http://localhost:3000/a.png',
    ];
    for (const photo of good) {
      const r = withPhoto(photo);
      expect(r.errors, photo).toEqual([]);
      expect(r.items[0]!.photo).toBe(photo);
    }
    const padded = withPhoto('   /photos/A.webp \t');
    expect(padded.errors).toEqual([]);
    expect(padded.items[0]!.photo).toBe('/photos/A.webp');
  });

  it('rechaza javascript:, data:, //host, rutas sueltas y espacios con un error de fila en "foto"', () => {
    const bad = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:image/png;base64,AAAA',
      '//evil.example/x.png',
      'fotos/x.jpg',
      'x.jpg',
      'ftp://host/x.png',
      'file:///etc/passwd',
      '/photos/con espacio.webp',
      'https://cdn.example.com/con espacio.png',
      `/${'a'.repeat(300)}`,
    ];
    for (const photo of bad) {
      const r = withPhoto(photo);
      expect(r.items, photo).toEqual([]);
      expect(r.errors, photo).toEqual([
        { line: 2, sku: 'A', field: 'foto', message: photoRefError(photo)! },
      ]);
    }
    expect(withPhoto('javascript:alert(1)').errors[0]!.message).toMatch(
      /^Escribe una ruta que empiece con \//,
    );
    expect(withPhoto(`/${'a'.repeat(300)}`).errors[0]!.message).toBe('Máximo 300 caracteres');
  });

  it('el error no echa el valor (puede ser enorme) y una fila mala no esconde las demás', () => {
    const csv = [
      `${HEADER},foto`,
      'A,Pollo,aves,lb,100,/photos/A.webp',
      'B,Res,res,lb,100,javascript:alert(1)',
      'C,Cerdo,cerdo,lb,100,https://cdn.example.com/c.webp',
    ].join('\n');
    const r = parse(csv);
    expect(r.items.map((i) => i.sku)).toEqual(['A', 'C']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 3, sku: 'B', field: 'foto' });
    expect(r.errors[0]!.message).not.toContain('alert');
  });

  it('también se valida con punto y coma y con el encabezado en mayúsculas', () => {
    const r = parseCatalogCsv(
      'SKU;Nombre;Categoría;Unidad;Precio;Foto\nA;Pollo;aves;lb;"174,95";fotos/a.jpg\n',
      { categories },
    );
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, sku: 'A', field: 'foto' })]);
  });

  it('el catálogo semilla trae solo fotos válidas', () => {
    const seed = parse(readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8'));
    expect(seed.errors.filter((e) => e.field === 'foto')).toEqual([]);
    expect(seed.items.every((i) => photoRefError(i.photo) === null)).toBe(true);
  });
});

describe('columna foto_ilustrativa', () => {
  it('es la última columna canónica y va después de "foto"', () => {
    expect(CSV_COLUMNS.at(-1)).toBe('foto_ilustrativa');
    expect(CSV_COLUMNS.indexOf('foto_ilustrativa')).toBeGreaterThan(CSV_COLUMNS.indexOf('foto'));
    expect(catalogToCsv([]).split('\n', 1)[0]).toBe(CSV_COLUMNS.join(','));
  });

  it('sin la columna, o vacía, la foto es ilustrativa (no se promete una foto real)', () => {
    const sin = parse(`${HEADER},foto\nA,Pollo,aves,lb,100,/photos/A.webp\n`);
    expect(sin.errors).toEqual([]);
    expect(sin.items[0]!.photoIllustrative).toBe(true);
    const vacia = parse(`${HEADER},foto,foto_ilustrativa\nA,Pollo,aves,lb,100,/photos/A.webp,\n`);
    expect(vacia.items[0]!.photoIllustrative).toBe(true);
  });

  it('entiende si/no con o sin acentos y mayúsculas, y sus variantes', () => {
    const csv = `${HEADER},foto,foto_ilustrativa\n${[
      'A,A,res,lb,100,/photos/A.webp,si',
      'B,B,res,lb,100,/photos/B.webp,Sí',
      'C,C,res,lb,100,/photos/C.webp,NO',
      'D,D,res,lb,100,/photos/D.webp,false',
      'E,E,res,lb,100,/photos/E.webp,0',
      'F,F,res,lb,100,/photos/F.webp,true',
    ].join('\n')}\n`;
    const r = parse(csv);
    expect(r.errors).toEqual([]);
    expect(r.items.map((i) => i.photoIllustrative)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it('acepta la cabecera con acentos y alias, también en CSV de Excel (; y coma decimal)', () => {
    for (const header of [
      'Foto ilustrativa',
      'FOTO_ILUSTRATIVA',
      'Ilustrativa',
      'Imagen ilustrativa',
    ]) {
      const r = parse(
        `SKU;Nombre;Categoría;Unidad;Precio;Foto;${header}\nA;Pollo;aves;lb;"174,95";/photos/A.webp;No\n`,
      );
      expect(r.errors, header).toEqual([]);
      expect(r.items[0]!.photoIllustrative, header).toBe(false);
    }
  });

  it('rechaza un valor que no es si/no, indicando fila, SKU y campo', () => {
    const r = parse(
      `${HEADER},foto_ilustrativa\nA,Pollo,aves,lb,100,quizás\nB,Res,res,lb,100,si\n`,
    );
    expect(r.items.map((i) => i.sku)).toEqual(['B']);
    expect(r.errors).toEqual([
      expect.objectContaining({ line: 2, sku: 'A', field: 'foto_ilustrativa' }),
    ]);
    expect(r.errors[0]!.message).toMatch(/si.*no/);
  });

  it('avisa si se marca como foto real una fila que no tiene foto', () => {
    const r = parse(
      `${HEADER},foto,foto_ilustrativa\nA,Pollo,aves,lb,100,,no\nB,Res,res,lb,100,/photos/B.webp,no\nC,Cerdo,cerdo,lb,100,,si\n`,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.field === 'foto_ilustrativa').map((w) => w.sku)).toEqual([
      'A',
    ]);
  });

  it('el CSV exportado marca "no" solo cuando la foto es real', () => {
    const [base] = parse(`${HEADER}\nA,Pollo,aves,lb,100\n`).items;
    const rows = parseCsv(
      catalogToCsv([
        { ...base!, sku: 'A', photo: '/photos/A.webp', photoIllustrative: false },
        { ...base!, sku: 'B', photo: '/photos/B.webp', photoIllustrative: true },
        { ...base!, sku: 'C', photo: '/photos/C.webp' },
      ]),
    );
    const col = rows[0]!.indexOf('foto_ilustrativa');
    expect(rows.slice(1).map((r) => r[col])).toEqual(['no', 'si', 'si']);
  });
});

describe('catálogo semilla del negocio', () => {
  const seed = readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8');
  const parsed = parse(seed);

  it('no tiene errores de validación', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('trae solo columnas canónicas y en su orden (las opcionales nuevas pueden faltar)', () => {
    const header = seed.split('\n', 1)[0]!.split(',');
    const canonical = CSV_COLUMNS.filter((c) => header.includes(c));
    expect(header).toEqual(canonical);
    // Las columnas del orden original (todas las anteriores a foto_ilustrativa) siguen presentes.
    const original = CSV_COLUMNS.slice(0, CSV_COLUMNS.indexOf('foto_ilustrativa'));
    expect(header.slice(0, original.length)).toEqual(original);
  });

  it('cubre las categorías del negocio con volumen razonable', () => {
    expect(parsed.items.length).toBeGreaterThanOrEqual(30);
    for (const slug of ['res', 'cerdo', 'aves', 'pescados', 'mariscos', 'otros']) {
      expect(
        parsed.items.some((i) => i.category === slug),
        slug,
      ).toBe(true);
    }
  });

  it('usa SKUs únicos y agrupa variantes de camarón por calibre', () => {
    expect(new Set(parsed.items.map((i) => i.sku)).size).toBe(parsed.items.length);
    const camaron = groupProducts(parsed.items).find((p) => p.group === 'camaron');
    expect(camaron?.variants.map((v) => v.variant).sort()).toEqual([
      '16/20',
      '21/25',
      '51/60 crudo',
      '8/12',
    ]);
  });

  it('todos los precios son confirmados por el dueño y el ITBIS está definido', () => {
    expect(parsed.items.every((i) => i.priceSource === 'usuario')).toBe(true);
    expect(parsed.items.every((i) => i.itbisBps === 0 || i.itbisBps === 1800)).toBe(true);
    expect(parsed.items.every((i) => publishability(i).publishable)).toBe(true);
  });

  it('NO guarda costos: el repositorio es público y el listado del dueño es interno', () => {
    expect(parsed.items.every((i) => i.cost === null)).toBe(true);
    expect(parsed.items.every((i) => !/RD\$/.test(i.priceNote))).toBe(true);
  });

  it('todos los productos traen descripción y consejo de cocina', () => {
    for (const i of parsed.items) {
      expect(i.description, i.sku).not.toBe('');
      expect(i.cookingTip, i.sku).not.toBe('');
    }
  });
});
