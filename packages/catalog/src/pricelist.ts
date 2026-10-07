import { type Bps, type Centavos, ITBIS_STANDARD_BPS, toCentavos } from '@jellyfish/shared';
import { detectDelimiter, parseCsv } from './csv';
import { normalizeHeader, parseCatalogCsv, slugify } from './import';
import type { CatalogItem, ParsedCatalog, RowIssue } from './types';

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
  /** Beneficio sobre el precio del listado, en puntos base (1000 = 10 %). */
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
  { test: /\bres\b/i, categoria: 'res', subcategoria: '' },
  { test: /cerdo/i, categoria: 'cerdo', subcategoria: '' },
  { test: /\baves?\b|pollo|pavo/i, categoria: 'aves', subcategoria: '' },
  { test: /chivo|cabr/i, categoria: 'chivo-otras', subcategoria: '' },
  { test: /vegetal|otros/i, categoria: 'otros', subcategoria: '' },
];

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\p{L}/u, (c) => c.toUpperCase());

const pesos = (c: Centavos) => (c / 100).toFixed(2);

interface BuildContext {
  rule: PricingRule;
  /** Fecha del listado (texto libre) para la nota de precio. */
  listDate: string;
  /** true = guarda el precio del listado como costo y lo detalla en la nota (dato interno). */
  includeCost: boolean;
}

const itbisOf = (row: PriceListRow, rule: PricingRule): Bps =>
  row.taxed ? (rule.itbisBps ?? DEFAULT_ITBIS_BPS) : 0;

function priceNoteOf(row: PriceListRow, ctx: BuildContext): string {
  return ctx.includeCost
    ? `Listado del ${ctx.listDate}: RD$${pesos(row.listPrice)}/lb (${row.presentation || 'sin presentación'})`
    : `Precio definido por el dueño (listado del ${ctx.listDate})`;
}

/**
 * Artículo NUEVO a partir de una fila del Excel: con su ficha si existe, o con valores por
 * defecto. `guessedCategory` es false cuando la sección del Excel no dice en qué categoría va.
 */
function newItemFromRow(
  row: PriceListRow,
  m: PriceListMeta | undefined,
  ctx: BuildContext,
): { item: CatalogItem; guessedCategory: boolean } {
  const price = consumerPrice(row.listPrice, row.taxed, ctx.rule);
  const common = {
    pricingUnit: 'lb' as const,
    price,
    priceSource: 'usuario' as const,
    priceNote: priceNoteOf(row, ctx),
    cost: ctx.includeCost ? row.listPrice : null,
    stock: 0,
    itbisBps: itbisOf(row, ctx.rule),
    variableWeight: true,
    frozen: true,
    active: true,
  };
  if (m) {
    return {
      guessedCategory: true,
      item: {
        ...common,
        sku: m.sku,
        group: m.grupo,
        name: m.nombre,
        variant: m.variante ?? '',
        category: m.categoria,
        subcategory: m.subcategoria ?? '',
        stepCentilb: Math.round((m.paso_lb ?? 0.5) * 100),
        minCentilb: Math.round((m.minimo_lb ?? 1) * 100),
        pieceCentilb: m.peso_pieza_lb ? Math.round(m.peso_pieza_lb * 100) : null,
        synonyms: m.sinonimos ?? [],
        description: m.descripcion ?? '',
        cookingTip: m.como_cocinar ?? '',
        photo: m.foto ?? '',
      },
    };
  }
  const def = SECTION_DEFAULTS.find((d) => d.test.test(row.section));
  const slug = slugify(row.name);
  return {
    guessedCategory: def !== undefined,
    item: {
      ...common,
      sku: `JF-NEW-${slug.toUpperCase().slice(0, 24)}`,
      group: slug,
      name: titleCase(row.name),
      variant: '',
      category: def?.categoria ?? 'otros',
      subcategory: def?.subcategoria ?? '',
      stepCentilb: 50,
      minCentilb: 100,
      pieceCentilb: null,
      synonyms: [],
      description: '',
      cookingTip: '',
      photo: '',
    },
  };
}

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

/** Catálogo NUEVO desde cero a partir del listado (para sembrar; no conserva nada previo). */
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
    const { item, guessedCategory } = newItemFromRow(row, m, options);
    if (m) {
      used.add(key);
    } else {
      withoutMeta.push(row);
      if (!guessedCategory) {
        warnings.push({
          line: row.line,
          sku: row.name,
          field: 'seccion',
          message: `No sé en qué categoría poner "${row.name}" (sección "${row.section}"): quedó en "otros"`,
        });
      }
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

// ───────────────────────── actualizar el catálogo que ya existe ─────────────────────────

/** Un cambio de precio de venta mayor que esto (en cualquier sentido) se resalta en la vista previa. */
export const LARGE_CHANGE_PCT = 25;

/**
 * nuevo     → no está en el catálogo; se agrega con su ficha.
 * sin-ficha → no está en el catálogo ni tiene ficha; se agrega con valores por defecto.
 * cambia    → ya está y cambia su precio, ITBIS, costo o si el precio estaba sin confirmar.
 * igual     → ya está y todo coincide (solo se actualiza la nota con la fecha del listado).
 */
export type PriceListStatus = 'nuevo' | 'sin-ficha' | 'cambia' | 'igual';
export type ChangedField = 'precio' | 'itbis' | 'costo' | 'origen';

export interface MergeOptions {
  rule: PricingRule;
  /** Fecha del listado (texto libre) para la nota de precio. */
  listDate: string;
  /** Guarda el precio del listado como costo (por defecto sí: el panel es la base privada). */
  includeCost?: boolean;
  /** Desactiva los artículos activos que el listado ya no trae (por defecto no). */
  deactivateMissing?: boolean;
}

/** Una fila del listado ya cruzada con el catálogo: lo que se mostrará en la vista previa. */
export interface PlanRow {
  /** Fila del Excel. */
  line: number;
  section: string;
  /** Nombre tal como viene en el Excel. */
  excelName: string;
  presentation: string;
  listPrice: Centavos;
  taxed: boolean;
  sku: string;
  /** Nombre y variante en el catálogo. */
  name: string;
  variant: string;
  status: PriceListStatus;
  itbisBps: Bps;
  /** Precio de venta por libra con ITBIS incluido. */
  newPrice: Centavos;
  currentPrice: Centavos | null;
  /** Cambio del precio de venta en puntos base (1000 = +10 %); null si el producto es nuevo. */
  changeBps: number | null;
  changed: ChangedField[];
  largeChange: boolean;
  notes: string[];
}

export interface MergeCounts {
  rows: number;
  nuevo: number;
  sinFicha: number;
  cambia: number;
  igual: number;
  largeChanges: number;
  /** Activos del catálogo que el listado ya no trae. */
  missing: number;
  /** De esos, cuántos quedan desactivados en este resultado. */
  deactivated: number;
}

export interface MergeResult {
  /** El catálogo completo resultante, listo para `catalogToCsv` y para el importador. */
  items: CatalogItem[];
  rows: PlanRow[];
  /** Artículos activos del catálogo que el listado ya no trae (no se borran nunca). */
  missing: CatalogItem[];
  /** Artículos que no vienen en el listado y ya estaban desactivados. */
  missingInactive: number;
  /** Impiden aplicar (p. ej. dos filas que quedarían con el mismo SKU). */
  errors: RowIssue[];
  warnings: RowIssue[];
  counts: MergeCounts;
}

const pctText = (bps: Bps | null) => (bps === null ? 'por confirmar' : `${bps / 100} %`);

/**
 * Aplica un listado de precios SOBRE el catálogo actual sin destruir nada: de cada artículo que ya
 * existe solo cambia precio, fuente del precio, nota de precio, ITBIS y costo (y `active`, solo si
 * se pide desactivar los que ya no vienen). Fotos, existencias, descripciones, sinónimos, pesos,
 * categorías y todo lo demás se conservan tal cual. Los productos que no existen se agregan con su
 * ficha (si la tienen) o con valores por defecto, y con existencia 0. Nada se borra.
 *
 * Cada fila del Excel se cruza con el catálogo por SKU: el de su ficha (`lista-proveedor.meta.json`)
 * o, si no tiene ficha, el SKU por defecto `JF-NEW-…` que se le asignó al crearlo.
 *
 * `current` debe ser el catálogo completo (p. ej. `parseCatalogExport` del export del servidor);
 * el resultado también es completo, para que el importador no pierda nada al re-escribirlo.
 */
export function mergePriceListIntoCatalog(
  current: readonly CatalogItem[],
  rows: readonly PriceListRow[],
  meta: readonly PriceListMeta[],
  options: MergeOptions,
): MergeResult {
  const ctx: BuildContext = {
    rule: options.rule,
    listDate: options.listDate,
    includeCost: options.includeCost ?? true,
  };
  const metaByKey = new Map(meta.map((m) => [normalizeHeader(m.lista), m]));
  const items: CatalogItem[] = current.map((c) => ({ ...c, synonyms: [...c.synonyms] }));
  const indexBySku = new Map(items.map((c, i) => [c.sku, i]));
  const firstOfGroup = new Map<string, CatalogItem>();
  for (const c of items) if (!firstOfGroup.has(c.group)) firstOfGroup.set(c.group, c);

  const planRows: PlanRow[] = [];
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const added: CatalogItem[] = [];
  const touched = new Map<string, number>(); // SKU → fila del Excel que lo usó

  for (const row of rows) {
    const m = metaByKey.get(normalizeHeader(row.name));
    const fresh = newItemFromRow(row, m, ctx);
    const sku = fresh.item.sku;

    const dup = touched.get(sku);
    if (dup !== undefined) {
      errors.push({
        line: row.line,
        sku,
        field: 'ficha',
        message: `"${row.name}" quedaría con el mismo SKU (${sku}) que la fila ${dup} del listado`,
      });
      continue;
    }
    touched.set(sku, row.line);

    const at = indexBySku.get(sku);
    const base = {
      line: row.line,
      section: row.section,
      excelName: row.name,
      presentation: row.presentation,
      listPrice: row.listPrice,
      taxed: row.taxed,
      sku,
      itbisBps: fresh.item.itbisBps ?? 0,
      newPrice: fresh.item.price,
    };

    if (at === undefined) {
      // Producto nuevo. Si su grupo ya existe, hereda los textos del grupo (no se pisan).
      const item = fresh.item;
      const sibling = firstOfGroup.get(item.group);
      if (sibling) {
        item.name = sibling.name;
        item.category = sibling.category;
        item.subcategory = sibling.subcategory;
        item.pricingUnit = sibling.pricingUnit;
        item.description = sibling.description;
        item.cookingTip = sibling.cookingTip;
        item.synonyms = [...sibling.synonyms];
      } else {
        firstOfGroup.set(item.group, item);
      }
      added.push(item);
      if (!m && !fresh.guessedCategory) {
        warnings.push({
          line: row.line,
          sku,
          field: 'seccion',
          message: `No sé en qué categoría poner "${row.name}" (sección "${row.section}"): quedó en "otros"`,
        });
      }
      planRows.push({
        ...base,
        name: item.name,
        variant: item.variant,
        status: m ? 'nuevo' : 'sin-ficha',
        currentPrice: null,
        changeBps: null,
        changed: [],
        largeChange: false,
        notes: [
          m
            ? 'Producto nuevo: se agrega con su ficha y existencia 0'
            : `Sin ficha: se agrega en «${item.category}» sin descripción, sinónimos ni foto, con existencia 0`,
        ],
      });
      continue;
    }

    const cur = items[at]!;
    if (cur.pricingUnit !== 'lb') {
      errors.push({
        line: row.line,
        sku,
        field: 'unidad',
        message: `"${row.name}": en el catálogo ${sku} se vende por unidad y el listado trae precio por libra`,
      });
      continue;
    }

    const changed: ChangedField[] = [];
    const notes: string[] = [];
    if (cur.price !== fresh.item.price) changed.push('precio');
    if (cur.itbisBps !== fresh.item.itbisBps) {
      changed.push('itbis');
      notes.push(`ITBIS de ${pctText(cur.itbisBps)} a ${pctText(fresh.item.itbisBps)}`);
    }
    if (ctx.includeCost && cur.cost !== fresh.item.cost) changed.push('costo');
    if (cur.priceSource !== 'usuario') {
      changed.push('origen');
      notes.push('El precio pasa a ser confirmado (antes no lo estaba)');
    }
    if (!cur.active) {
      notes.push(
        'Está desactivado en el catálogo y se queda así: actívalo allá si lo quieres vender',
      );
    }

    cur.price = fresh.item.price;
    cur.priceSource = 'usuario';
    cur.priceNote = fresh.item.priceNote;
    cur.itbisBps = fresh.item.itbisBps;
    if (ctx.includeCost) cur.cost = fresh.item.cost;

    const before = current[at]!.price;
    const diff = fresh.item.price - before;
    planRows.push({
      ...base,
      name: cur.name,
      variant: cur.variant,
      status: changed.length > 0 ? 'cambia' : 'igual',
      currentPrice: before,
      changeBps: before > 0 ? Math.round((diff * 10_000) / before) : null,
      changed,
      largeChange: before > 0 && Math.abs(diff) * 100 > LARGE_CHANGE_PCT * before,
      notes,
    });
  }

  const missing: CatalogItem[] = [];
  let missingInactive = 0;
  items.forEach((it, i) => {
    if (touched.has(it.sku)) return;
    if (!it.active) {
      missingInactive++;
      return;
    }
    missing.push(current[i]!);
    if (options.deactivateMissing) it.active = false;
  });

  const count = (s: PriceListStatus) => planRows.filter((r) => r.status === s).length;
  return {
    items: [...items, ...added],
    rows: planRows,
    missing,
    missingInactive,
    errors,
    warnings,
    counts: {
      rows: planRows.length,
      nuevo: count('nuevo'),
      sinFicha: count('sin-ficha'),
      cambia: count('cambia'),
      igual: count('igual'),
      largeChanges: planRows.filter((r) => r.largeChange).length,
      missing: missing.length,
      deactivated: options.deactivateMissing ? missing.length : 0,
    },
  };
}

// ───────────────────────── utilidades para el panel ─────────────────────────

/**
 * Lee el CSV que exporta el servidor (`GET /v1/admin/catalog/export`). Las categorías válidas
 * son las que el propio archivo trae: el servidor ya las validó, y la lista pública de
 * categorías oculta las que no tienen nada publicado.
 */
export function parseCatalogExport(csv: string): ParsedCatalog {
  let categories: string[] = [];
  try {
    const table = parseCsv(csv, detectDelimiter(csv));
    const col = (table[0] ?? []).map(normalizeHeader).indexOf('categoria');
    if (col >= 0) {
      categories = [...new Set(table.slice(1).map((r) => slugify(r[col] ?? '')))].filter(Boolean);
    }
  } catch {
    // parseCatalogCsv reporta el mismo problema como error del archivo.
  }
  return parseCatalogCsv(csv, { categories });
}

/** "12", "12.5", "12,5 %" → puntos base (1250). null si no es un porcentaje entre 0 y 1000. */
export function parsePercentToBps(text: string): Bps | null {
  const s = text.replace(/%|\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const bps = Math.round(Number(s) * 100);
  return bps <= 100_000 ? bps : null;
}
