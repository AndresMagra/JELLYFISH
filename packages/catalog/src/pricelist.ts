import { type Bps, type Centavos, ITBIS_STANDARD_BPS, toCentavos } from '@jellyfish/shared';
import { normalizeHeader, slugify } from './import';
import type { CatalogItem, RowIssue } from './types';

/** Valor de una celda tal como lo entrega un lector de Excel. */
export type Cell = string | number | boolean | Date | null | undefined;

/** Una fila de producto del listado de precios del proveedor/dueño. */
export interface PriceListRow {
  /** Número de fila en el Excel (la primera es la 1). */
  line: number;
  section: string;
  name: string;
  /** Presentación de compra (p. ej. "CAJAS DE 20 LBS"). Dato interno, no se muestra al cliente. */
  presentation: string;
  /** Precio del listado por libra, antes del beneficio. */
  listPrice: Centavos;
  /** Marcado con asterisco: el producto paga ITBIS. */
  taxed: boolean;
}

export interface ParsedPriceList {
  rows: PriceListRow[];
  errors: RowIssue[];
  warnings: RowIssue[];
}

const text = (c: Cell): string => (c === null || c === undefined ? '' : String(c).trim());

function numberOf(c: Cell): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  const raw = text(c)
    .replace(/rd\$|\$|\s/gi, '')
    .trim();
  if (raw === '') return null;
  const s = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)
    ? raw.replaceAll(',', '')
    : raw.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lee la tabla del listado (columnas: A = asterisco, B = producto, C = presentación,
 * D = precio por libra). Las filas con texto solo en A son títulos de sección.
 */
export function parsePriceListRows(table: readonly (readonly Cell[])[]): ParsedPriceList {
  const rows: PriceListRow[] = [];
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  let section = '';
  const seen = new Map<string, number>();

  table.forEach((cells, idx) => {
    const line = idx + 1;
    const a = text(cells[0]);
    const b = text(cells[1]);
    const c = text(cells[2]);
    const price = numberOf(cells[3]);
    if (!a && !b && !c && text(cells[3]) === '') return;

    if (b === '') {
      // Título de sección: texto en A (o en otra columna) sin producto.
      const title = a !== '*' ? a || c : '';
      if (title !== '' && price === null) section = title.trim();
      return;
    }

    if (price === null) {
      errors.push({
        line,
        sku: b,
        field: 'precio',
        message: `"${b}": el precio "${text(cells[3])}" no es un número`,
      });
      return;
    }
    if (price <= 0) {
      errors.push({
        line,
        sku: b,
        field: 'precio',
        message: `"${b}": el precio debe ser mayor que 0`,
      });
      return;
    }
    if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) {
      warnings.push({
        line,
        sku: b,
        field: 'precio',
        message: `"${b}": el precio tiene más de 2 decimales; se redondea al centavo`,
      });
    }
    if (section === '') {
      warnings.push({
        line,
        sku: b,
        field: 'seccion',
        message: `"${b}" aparece antes de cualquier título de sección`,
      });
    }
    const key = normalizeHeader(b);
    if (seen.has(key)) {
      errors.push({
        line,
        sku: b,
        field: 'producto',
        message: `"${b}" está repetido (ya aparece en la fila ${seen.get(key)})`,
      });
      return;
    }
    seen.set(key, line);
    rows.push({
      line,
      section,
      name: b,
      presentation: c,
      listPrice: toCentavos(price),
      taxed: a.startsWith('*'),
    });
  });

  if (rows.length === 0 && errors.length === 0) {
    errors.push({
      line: 1,
      sku: '',
      field: '(archivo)',
      message: 'No se encontró ningún producto con precio',
    });
  }
  return { rows, errors, warnings };
}

// ───────────────────────── precio de venta ─────────────────────────

export interface PricingRule {
  /** Beneficio sobre el precio del listado, en puntos base (1500 = 15 %). */
  marginBps: Bps;
  /**
   * 'sobre': el precio del listado NO incluye ITBIS; a los productos con asterisco se les suma.
   * 'incluido': el listado ya incluye el ITBIS; solo se aplica el beneficio.
   */
  itbisMode: 'sobre' | 'incluido';
  /** ITBIS de los productos con asterisco (por defecto 1800 = 18 %). */
  itbisBps?: Bps;
}

export const DEFAULT_ITBIS_BPS: Bps = ITBIS_STANDARD_BPS;

/**
 * Precio al consumidor por libra, con ITBIS incluido (como en góndola), redondeado al
 * centavo una sola vez al final.
 */
export function consumerPrice(listPrice: Centavos, taxed: boolean, rule: PricingRule): Centavos {
  if (!Number.isInteger(rule.marginBps) || rule.marginBps < 0 || rule.marginBps > 100_000) {
    throw new RangeError('El beneficio debe estar entre 0 % y 1000 %');
  }
  const itbis = BigInt(
    taxed && rule.itbisMode === 'sobre' ? (rule.itbisBps ?? DEFAULT_ITBIS_BPS) : 0,
  );
  const num = BigInt(listPrice) * BigInt(10_000 + rule.marginBps) * (10_000n + itbis);
  const den = 100_000_000n;
  return Number((num + den / 2n) / den);
}

// ───────────────────────── ficha curada de cada producto ─────────────────────────

/** Datos que el Excel no trae (nombre comercial, variante, sinónimos, textos…). */
export interface PriceListMeta {
  /** Nombre exactamente como aparece en el Excel (se compara sin acentos ni mayúsculas). */
  lista: string;
  sku: string;
  grupo: string;
  nombre: string;
  variante?: string;
  categoria: string;
  subcategoria?: string;
  paso_lb?: number;
  minimo_lb?: number;
  peso_pieza_lb?: number | null;
  sinonimos?: string[];
  descripcion?: string;
  como_cocinar?: string;
  foto?: string;
}

/** Categoría por defecto según el título de la sección del Excel (para productos nuevos). */
const SECTION_DEFAULTS: { test: RegExp; categoria: string; subcategoria: string }[] = [
  { test: /marisco/i, categoria: 'mariscos', subcategoria: '' },
  { test: /filete.*pescado/i, categoria: 'pescados', subcategoria: 'Filete' },
  { test: /pescado/i, categoria: 'pescados', subcategoria: 'Entero' },
  { test: /res\b/i, categoria: 'res', subcategoria: '' },
  { test: /cerdo/i, categoria: 'cerdo', subcategoria: '' },
  { test: /ave|pollo|pavo/i, categoria: 'aves', subcategoria: '' },
];

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{L}/u, (c) => c.toUpperCase());

export interface ConvertOptions {
  rule: PricingRule;
  /** Fecha del listado (texto libre) para la nota de precio. */
  listDate: string;
  /** true = guarda el precio del listado como costo y lo detalla en la nota (dato interno). */
  includeCost: boolean;
}

export interface ConvertResult {
  items: CatalogItem[];
  warnings: RowIssue[];
  /** Productos del Excel que no tenían ficha: se importaron con valores por defecto. */
  withoutMeta: PriceListRow[];
  /** Fichas que ya no aparecen en el Excel (producto descontinuado o renombrado). */
  unusedMeta: PriceListMeta[];
}

export function priceListToCatalog(
  rows: readonly PriceListRow[],
  meta: readonly PriceListMeta[],
  options: ConvertOptions,
): ConvertResult {
  const byKey = new Map(meta.map((m) => [normalizeHeader(m.lista), m]));
  const used = new Set<string>();
  const warnings: RowIssue[] = [];
  const withoutMeta: PriceListRow[] = [];
  const items: CatalogItem[] = [];

  for (const row of rows) {
    const key = normalizeHeader(row.name);
    const m = byKey.get(key);
    const price = consumerPrice(row.listPrice, row.taxed, options.rule);
    const itbisBps: Bps = row.taxed ? (options.rule.itbisBps ?? DEFAULT_ITBIS_BPS) : 0;
    const note = options.includeCost
      ? `Listado del ${options.listDate}: RD$${(row.listPrice / 100).toFixed(2)}/lb (${row.presentation || 'sin presentación'})`
      : `Precio definido por el dueño (listado del ${options.listDate})`;

    let item: CatalogItem;
    if (m) {
      used.add(key);
      item = {
        sku: m.sku,
        group: m.grupo,
        name: m.nombre,
        variant: m.variante ?? '',
        category: m.categoria,
        subcategory: m.subcategoria ?? '',
        pricingUnit: 'lb',
        stepCentilb: Math.round((m.paso_lb ?? 0.5) * 100),
        minCentilb: Math.round((m.minimo_lb ?? 1) * 100),
        pieceCentilb: m.peso_pieza_lb ? Math.round(m.peso_pieza_lb * 100) : null,
        price,
        priceSource: 'usuario',
        priceNote: note,
        cost: options.includeCost ? row.listPrice : null,
        stock: 0,
        itbisBps,
        variableWeight: true,
        frozen: true,
        synonyms: m.sinonimos ?? [],
        description: m.descripcion ?? '',
        cookingTip: m.como_cocinar ?? '',
        photo: m.foto ?? '',
        active: true,
      };
    } else {
      withoutMeta.push(row);
      const def = SECTION_DEFAULTS.find((d) => d.test.test(row.section));
      if (!def) {
        warnings.push({
          line: row.line,
          sku: row.name,
          field: 'seccion',
          message: `No sé en qué categoría poner "${row.name}" (sección "${row.section}"): quedó en "otros"`,
        });
      }
      const slug = slugify(row.name);
      item = {
        sku: `JF-NEW-${slug.toUpperCase().slice(0, 24)}`,
        group: slug,
        name: titleCase(row.name),
        variant: '',
        category: def?.categoria ?? 'otros',
        subcategory: def?.subcategoria ?? '',
        pricingUnit: 'lb',
        stepCentilb: 50,
        minCentilb: 100,
        pieceCentilb: null,
        price,
        priceSource: 'usuario',
        priceNote: note,
        cost: options.includeCost ? row.listPrice : null,
        stock: 0,
        itbisBps,
        variableWeight: true,
        frozen: true,
        synonyms: [],
        description: '',
        cookingTip: '',
        photo: '',
        active: true,
      };
      warnings.push({
        line: row.line,
        sku: item.sku,
        field: 'ficha',
        message: `"${row.name}" es nuevo: se importó sin descripción, sinónimos ni foto`,
      });
    }
    items.push(item);
  }

  const unusedMeta = meta.filter((m) => !used.has(normalizeHeader(m.lista)));
  return { items, warnings, withoutMeta, unusedMeta };
}
