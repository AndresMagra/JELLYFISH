import { type Centavos, type Centilb, photoRefError, toCentavos } from '@jellyfish/shared';
import { detectDelimiter, parseCsv, toCsv } from './csv';
import {
  PRICE_SOURCES,
  type CatalogItem,
  type ParsedCatalog,
  type Publishability,
  type PriceSource,
  type RowIssue,
} from './types';

/** Encabezados canónicos del CSV de JELLYFISH, en el orden de exportación. */
export const CSV_COLUMNS = [
  'sku',
  'grupo',
  'nombre',
  'variante',
  'categoria',
  'subcategoria',
  'unidad',
  'paso_lb',
  'minimo_lb',
  'peso_pieza_lb',
  'precio',
  'precio_fuente',
  'notas_precio',
  'costo',
  'stock',
  'itbis',
  'variable',
  'congelado',
  'sinonimos',
  'descripcion',
  'como_cocinar',
  'foto',
  'activo',
  // Columna opcional añadida al final: los CSV anteriores siguen siendo válidos.
  'foto_ilustrativa',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

const REQUIRED: CsvColumn[] = ['sku', 'nombre', 'categoria', 'unidad', 'precio'];

/** Alias aceptados (ya normalizados) → columna canónica. */
const ALIASES: Record<string, CsvColumn> = {
  precio_lb: 'precio',
  precio_por_libra: 'precio',
  unidad_precio: 'unidad',
  peso_estimado: 'peso_pieza_lb',
  stock_lb: 'stock',
  existencia: 'stock',
  existencias: 'stock',
  itbis_pct: 'itbis',
  category: 'categoria',
  name: 'nombre',
  price: 'precio',
  producto: 'nombre',
  ilustrativa: 'foto_ilustrativa',
  ilustrativo: 'foto_ilustrativa',
  foto_ilustrativo: 'foto_ilustrativa',
  imagen_ilustrativa: 'foto_ilustrativa',
  es_ilustrativa: 'foto_ilustrativa',
  foto_es_ilustrativa: 'foto_ilustrativa',
};

export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function slugify(text: string): string {
  return normalizeHeader(text).replaceAll('_', '-');
}

class CellError extends Error {}

function parseNumber(raw: string, decimalComma: boolean): number {
  let s = raw.replace(/rd\$|\$|\s/gi, '');
  if (decimalComma) s = s.replaceAll('.', '').replace(',', '.');
  else if (s.includes(',') && s.includes('.')) s = s.replaceAll(',', '');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replaceAll(',', '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  if (s === '' || !Number.isFinite(n)) throw new CellError(`"${raw}" no es un número válido`);
  return n;
}

function parseBool(raw: string, fallback: boolean): boolean {
  const s = normalizeHeader(raw);
  if (s === '') return fallback;
  if (['si', 's', 'true', '1', 'yes', 'y'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  throw new CellError(`"${raw}" debe ser "si" o "no"`);
}

function centilbOf(raw: string, decimalComma: boolean, label: string): Centilb {
  const n = parseNumber(raw, decimalComma);
  const c = Math.round(n * 100);
  if (n <= 0 || Math.abs(n * 100 - c) > 1e-6) {
    throw new CellError(`${label} debe ser mayor que 0 y con máximo 2 decimales`);
  }
  return c;
}

function moneyOf(raw: string, decimalComma: boolean, label: string): Centavos {
  const n = parseNumber(raw, decimalComma);
  const c = toCentavos(n);
  if (n < 0 || Math.abs(n * 100 - c) > 1e-6) {
    throw new CellError(`${label} debe ser un monto positivo con máximo 2 decimales`);
  }
  return c;
}

function itbisOf(raw: string, decimalComma: boolean): number | null {
  const s = normalizeHeader(raw);
  if (s === '') return null;
  if (s === 'exento') return 0;
  if (s === 'gravado') return 1800;
  const pct = parseNumber(raw.replace('%', ''), decimalComma);
  if (pct < 0 || pct > 100) throw new CellError('ITBIS debe estar entre 0 y 100');
  return Math.round(pct * 100);
}

export interface ParseOptions {
  /** Slugs de categorías válidas. */
  categories: readonly string[];
}

export function parseCatalogCsv(text: string, options: ParseOptions): ParsedCatalog {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const items: CatalogItem[] = [];

  const delimiter = detectDelimiter(text);
  const decimalComma = delimiter === ';';
  let table: string[][];
  try {
    table = parseCsv(text, delimiter);
  } catch (e) {
    errors.push({ line: 1, sku: '', field: '(archivo)', message: (e as Error).message });
    return { items, errors, warnings };
  }

  const [headerRow, ...dataRows] = table;
  if (!headerRow) {
    errors.push({ line: 1, sku: '', field: '(archivo)', message: 'El archivo está vacío' });
    return { items, errors, warnings };
  }

  const columnIndex = new Map<CsvColumn, number>();
  headerRow.forEach((raw, idx) => {
    const norm = normalizeHeader(raw);
    const col = (CSV_COLUMNS as readonly string[]).includes(norm)
      ? (norm as CsvColumn)
      : ALIASES[norm];
    if (col && !columnIndex.has(col)) columnIndex.set(col, idx);
  });
  for (const col of REQUIRED) {
    if (!columnIndex.has(col)) {
      errors.push({
        line: 1,
        sku: '',
        field: col,
        message: `Falta la columna obligatoria "${col}"`,
      });
    }
  }
  if (errors.length > 0) return { items, errors, warnings };

  const seenSkus = new Map<string, number>();
  const categories = new Set(options.categories);

  dataRows.forEach((cells, rowIdx) => {
    const line = rowIdx + 2;
    const get = (col: CsvColumn) => (cells[columnIndex.get(col) ?? -1] ?? '').trim();
    const sku = get('sku');
    const rowErrors: RowIssue[] = [];
    const fail = (field: string, message: string) => rowErrors.push({ line, sku, field, message });
    const attempt = <T>(field: CsvColumn, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof CellError) fail(field, e.message);
        else throw e;
        return fallback;
      }
    };

    if (!sku) fail('sku', 'El SKU es obligatorio');
    else if (seenSkus.has(sku)) {
      fail('sku', `SKU repetido (ya aparece en la fila ${seenSkus.get(sku)})`);
    } else seenSkus.set(sku, line);

    const name = get('nombre');
    if (!name) fail('nombre', 'El nombre es obligatorio');

    const category = slugify(get('categoria'));
    if (!category) fail('categoria', 'La categoría es obligatoria');
    else if (!categories.has(category)) {
      fail(
        'categoria',
        `Categoría desconocida "${get('categoria')}". Válidas: ${[...categories].join(', ')}`,
      );
    }

    const unitRaw = normalizeHeader(get('unidad'));
    const unit =
      unitRaw === 'lb' || unitRaw === 'libra'
        ? 'lb'
        : unitRaw === 'unit' || unitRaw === 'unidad'
          ? 'unit'
          : null;
    if (!unit) fail('unidad', `Unidad inválida "${get('unidad')}": use "lb" o "unit"`);

    const priceErrorsBefore = rowErrors.length;
    const price = attempt('precio', () => moneyOf(get('precio'), decimalComma, 'El precio'), 0);
    if (rowErrors.length === priceErrorsBefore && price <= 0) {
      fail('precio', 'El precio debe ser mayor que 0');
    }

    const sourceRaw = normalizeHeader(get('precio_fuente'));
    let priceSource: PriceSource = 'usuario';
    if (sourceRaw !== '') {
      if ((PRICE_SOURCES as readonly string[]).includes(sourceRaw))
        priceSource = sourceRaw as PriceSource;
      else
        fail(
          'precio_fuente',
          `Fuente inválida "${get('precio_fuente')}": ancla, estimado o usuario`,
        );
    }

    const stepRaw = get('paso_lb');
    const minRaw = get('minimo_lb');
    const pieceRaw = get('peso_pieza_lb');
    const stepCentilb =
      unit === 'lb'
        ? stepRaw === ''
          ? 50
          : attempt('paso_lb', () => centilbOf(stepRaw, decimalComma, 'El paso'), 50)
        : null;
    const minCentilb =
      unit === 'lb'
        ? minRaw === ''
          ? 100
          : attempt('minimo_lb', () => centilbOf(minRaw, decimalComma, 'El mínimo'), 100)
        : null;
    const pieceCentilb =
      pieceRaw === ''
        ? null
        : attempt(
            'peso_pieza_lb',
            () => centilbOf(pieceRaw, decimalComma, 'El peso por pieza'),
            null,
          );

    const costRaw = get('costo');
    const cost =
      costRaw === ''
        ? null
        : attempt('costo', () => moneyOf(costRaw, decimalComma, 'El costo'), null);

    const stockRaw = get('stock');
    let stock = 0;
    if (stockRaw !== '') {
      stock = attempt(
        'stock',
        () => {
          const n = parseNumber(stockRaw, decimalComma);
          if (n < 0) throw new CellError('El stock no puede ser negativo');
          if (unit === 'unit') {
            if (!Number.isInteger(n)) throw new CellError('El stock en unidades debe ser entero');
            return n;
          }
          const c = Math.round(n * 100);
          if (Math.abs(n * 100 - c) > 1e-6)
            throw new CellError('El stock en libras admite máximo 2 decimales');
          return c;
        },
        0,
      );
    }

    // Sin eco del valor: puede ser enorme (un data: URI) y no hace falta para encontrar la fila.
    const photoProblem = photoRefError(get('foto'));
    if (photoProblem) fail('foto', photoProblem);

    const itbisBps = attempt('itbis', () => itbisOf(get('itbis'), decimalComma), null);
    const variableWeight = attempt(
      'variable',
      () => parseBool(get('variable'), unit === 'lb'),
      unit === 'lb',
    );
    const frozen = attempt('congelado', () => parseBool(get('congelado'), true), true);
    const active = attempt('activo', () => parseBool(get('activo'), true), true);
    // Vacío = "si": sin dato explícito no se promete una foto real.
    const photoIllustrative = attempt(
      'foto_ilustrativa',
      () => parseBool(get('foto_ilustrativa'), true),
      true,
    );

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      return;
    }

    const warn = (field: string, message: string) => warnings.push({ line, sku, field, message });
    if (unit === 'lb' && (price < 2000 || price > 500_000)) {
      warn('precio', `Precio por libra poco habitual (${price / 100}). ¿Está en pesos por libra?`);
    }
    if (cost !== null && cost > price) warn('costo', 'El costo supera al precio: margen negativo');
    if (unit === 'unit' && stepRaw !== '')
      warn('paso_lb', 'paso_lb se ignora en productos por unidad');
    if (!photoIllustrative && get('foto') === '') {
      warn('foto_ilustrativa', 'Marcada como foto real, pero la fila no tiene foto');
    }

    items.push({
      sku,
      group: slugify(get('grupo')) || slugify(name),
      name,
      variant: get('variante'),
      category,
      subcategory: get('subcategoria'),
      pricingUnit: unit!,
      stepCentilb,
      minCentilb,
      pieceCentilb,
      price,
      priceSource,
      priceNote: get('notas_precio'),
      cost,
      stock,
      itbisBps,
      variableWeight,
      frozen,
      synonyms: get('sinonimos')
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean),
      description: get('descripcion'),
      cookingTip: get('como_cocinar'),
      photo: get('foto'),
      photoIllustrative,
      active,
    });
  });

  // Coherencia dentro de cada grupo de variantes.
  const byGroup = new Map<string, CatalogItem[]>();
  for (const item of items) byGroup.set(item.group, [...(byGroup.get(item.group) ?? []), item]);
  for (const [group, members] of byGroup) {
    const first = members[0]!;
    for (const m of members.slice(1)) {
      if (
        m.category !== first.category ||
        m.name !== first.name ||
        m.pricingUnit !== first.pricingUnit
      ) {
        errors.push({
          line: seenSkus.get(m.sku) ?? 0,
          sku: m.sku,
          field: 'grupo',
          message: `El grupo "${group}" mezcla nombre, categoría o unidad distintos (${first.sku} vs ${m.sku})`,
        });
      }
    }
    const variants = members.map((m) => m.variant);
    if (members.length > 1 && new Set(variants).size !== variants.length) {
      warnings.push({
        line: seenSkus.get(first.sku) ?? 0,
        sku: first.sku,
        field: 'variante',
        message: `El grupo "${group}" tiene variantes con el mismo nombre`,
      });
    }
  }

  return { items, errors, warnings };
}

/**
 * Un producto se puede mostrar a clientes solo si está activo, su precio no es un
 * estimado y su tratamiento de ITBIS ya fue confirmado.
 */
export function publishability(item: CatalogItem): Publishability {
  const reasons: string[] = [];
  if (!item.active) reasons.push('Inactivo');
  if (item.priceSource === 'estimado') reasons.push('Precio estimado: confirmar antes de publicar');
  if (item.itbisBps === null) reasons.push('ITBIS por confirmar con el contador');
  if (item.price <= 0) reasons.push('Sin precio');
  return { publishable: reasons.length === 0, reasons };
}

export interface CatalogProduct {
  group: string;
  name: string;
  category: string;
  subcategory: string;
  description: string;
  cookingTip: string;
  pricingUnit: CatalogItem['pricingUnit'];
  variants: CatalogItem[];
  /** Precio más bajo entre variantes (para "desde RD$ …"). */
  fromPrice: Centavos;
}

export function groupProducts(items: readonly CatalogItem[]): CatalogProduct[] {
  const map = new Map<string, CatalogItem[]>();
  for (const item of items) map.set(item.group, [...(map.get(item.group) ?? []), item]);
  return [...map.entries()].map(([group, variants]) => {
    const first = variants[0]!;
    return {
      group,
      name: first.name,
      category: first.category,
      subcategory: first.subcategory,
      description: first.description,
      cookingTip: first.cookingTip,
      pricingUnit: first.pricingUnit,
      variants,
      fromPrice: Math.min(...variants.map((v) => v.price)),
    };
  });
}

export function catalogToCsv(items: readonly CatalogItem[]): string {
  const pesos = (c: number | null) => (c === null ? '' : c / 100);
  const lb = (c: number | null) => (c === null ? '' : c / 100);
  const rows: (string | number)[][] = [[...CSV_COLUMNS]];
  for (const i of items) {
    rows.push([
      i.sku,
      i.group,
      i.name,
      i.variant,
      i.category,
      i.subcategory,
      i.pricingUnit,
      lb(i.stepCentilb),
      lb(i.minCentilb),
      lb(i.pieceCentilb),
      pesos(i.price),
      i.priceSource,
      i.priceNote,
      pesos(i.cost),
      i.pricingUnit === 'lb' ? i.stock / 100 : i.stock,
      i.itbisBps === null ? '' : i.itbisBps / 100,
      i.variableWeight ? 'si' : 'no',
      i.frozen ? 'si' : 'no',
      i.synonyms.join(';'),
      i.description,
      i.cookingTip,
      i.photo,
      i.active ? 'si' : 'no',
      i.photoIllustrative === false ? 'no' : 'si',
    ]);
  }
  return toCsv(rows);
}
