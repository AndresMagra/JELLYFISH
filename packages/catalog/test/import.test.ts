import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, catalogToCsv, groupProducts, parseCatalogCsv, publishability } from '../src';

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
});

describe('catálogo semilla de RD', () => {
  const seed = readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8');
  const parsed = parse(seed);

  it('no tiene errores de validación', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('trae las columnas canónicas', () => {
    const header = seed.split('\n', 1)[0]!.split(',');
    expect(header).toEqual([...CSV_COLUMNS]);
  });

  it('cubre todas las categorías con volumen razonable', () => {
    expect(parsed.items.length).toBeGreaterThanOrEqual(100);
    for (const slug of categories) {
      expect(parsed.items.some((i) => i.category === slug)).toBe(true);
    }
  });

  it('usa SKUs únicos y agrupa variantes de camarón por calibre', () => {
    expect(new Set(parsed.items.map((i) => i.sku)).size).toBe(parsed.items.length);
    const crudo = groupProducts(parsed.items).find((p) => p.group === 'camaron-crudo');
    expect(crudo?.variants.map((v) => v.variant)).toEqual([
      '16/20',
      '21/25',
      '26/30',
      '31/40',
      '41/50',
      '51/60',
    ]);
  });

  it('conserva los precios ancla encontrados en la investigación', () => {
    const price = (sku: string) => parsed.items.find((i) => i.sku === sku)?.price;
    const byName = (name: string, variant: string) =>
      parsed.items.find((i) => i.name === name && i.variant === variant);
    expect(byName('Camarón precocido congelado', '26/30')?.price).toBe(34995);
    expect(byName('Camarón crudo congelado', '16/20')?.price).toBe(87995);
    expect(byName('Pechuga de pollo deshuesada', '')?.price).toBe(17495);
    expect(byName('Carne molida de res', '96/4 Baja en grasa')?.price).toBe(29995);
    expect(byName('Carne de res para guisar', 'En cuadritos')?.price).toBe(29500);
    expect(price('RES-001')).toBeGreaterThan(0);
  });

  it('marca como ancla solo los precios hallados y deja el resto como estimado', () => {
    const anchors = parsed.items.filter((i) => i.priceSource === 'ancla');
    // 13 = precios hallados en la investigación. Subir este número es una decisión consciente.
    expect(anchors).toHaveLength(13);
    expect(anchors.every((i) => i.priceNote.startsWith('Ancla:'))).toBe(true);
    expect(parsed.items.every((i) => i.priceSource !== 'usuario')).toBe(true);
  });

  it('nada del catálogo semilla es publicable hasta confirmar precio e ITBIS', () => {
    expect(parsed.items.some((i) => publishability(i).publishable)).toBe(false);
  });

  it('todos los productos traen descripción y consejo de cocina', () => {
    for (const i of parsed.items) {
      expect(i.description, i.sku).not.toBe('');
      expect(i.cookingTip, i.sku).not.toBe('');
    }
  });
});
