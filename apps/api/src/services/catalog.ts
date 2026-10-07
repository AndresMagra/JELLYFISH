import {
  type CatalogItem,
  type RowIssue,
  catalogToCsv,
  groupProducts,
  parseCatalogCsv,
} from '@jellyfish/catalog';
import type { PricingUnit } from '@jellyfish/shared';
import { and, asc, eq, exists, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { categories, inventoryMovements, products, variants } from '../db/schema';
import { invalid, notFound } from '../errors';
import { adjustStock } from './inventory';
import { normalizeText } from '../text';

export interface CategoryInput {
  slug: string;
  name: string;
  tagline?: string;
  sort?: number;
}

export async function syncCategories(db: Db, items: readonly CategoryInput[]): Promise<void> {
  for (const c of items) {
    await db
      .insert(categories)
      .values({ slug: c.slug, name: c.name, tagline: c.tagline ?? '', sort: c.sort ?? 0 })
      .onConflictDoUpdate({
        target: categories.slug,
        set: { name: c.name, tagline: c.tagline ?? '', sort: c.sort ?? 0 },
      });
  }
}

/**
 * Categorías en orden de menú. Con `visibleOnly`, solo las que tienen al menos un producto
 * activo y publicable (los clientes no deben ver categorías vacías).
 */
export async function listCategories(db: Db, opts: { visibleOnly?: boolean; demo?: boolean } = {}) {
  const visible = exists(
    db
      .select({ one: sql`1` })
      .from(products)
      .where(
        and(
          eq(products.categorySlug, categories.slug),
          eq(products.active, true),
          exists(
            db
              .select({ one: sql`1` })
              .from(variants)
              .where(
                and(
                  eq(variants.productId, products.id),
                  publishableVariantOnly(opts.demo ?? false),
                ),
              ),
          ),
        ),
      ),
  );
  return db
    .select()
    .from(categories)
    .where(opts.visibleOnly ? visible : undefined)
    .orderBy(asc(categories.sort), asc(categories.name));
}

// ───────────────────────── publicación ─────────────────────────

interface PublishFields {
  active: boolean;
  price: number;
  priceSource: 'ancla' | 'estimado' | 'usuario';
  itbisBps: number | null;
}

/**
 * Regla de publicación: activo, precio no estimado e ITBIS confirmado.
 * En modo demo se permite vender estimados/ITBIS sin confirmar (la app lo señala).
 */
export function variantBlockers(v: PublishFields, productActive: boolean, demo: boolean): string[] {
  const reasons: string[] = [];
  if (!productActive) reasons.push('Producto inactivo');
  if (!v.active) reasons.push('Inactivo');
  if (v.price <= 0) reasons.push('Sin precio');
  if (!demo) {
    if (v.priceSource === 'estimado') reasons.push('Precio estimado: confirmar antes de publicar');
    if (v.itbisBps === null) reasons.push('ITBIS por confirmar con el contador');
  }
  return reasons;
}

// ───────────────────────── importación ─────────────────────────

export interface ImportOptions {
  /** Valida y calcula el resultado sin guardar nada. */
  dryRun?: boolean;
  /** Aplica el stock del CSV también a artículos que ya existen (por defecto solo a los nuevos). */
  applyStockToExisting?: boolean;
  /** Permite que un CSV con `estimado`/`ancla` pise un precio ya confirmado por el dueño. */
  overwriteConfirmed?: boolean;
  actorId?: string | null;
}

export interface ImportResult {
  ok: boolean;
  dryRun: boolean;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  /** Precios confirmados por el dueño que el CSV intentó pisar y se conservaron. */
  keptConfirmedPrices: string[];
  errors: RowIssue[];
  warnings: RowIssue[];
}

class Rollback extends Error {}

function searchTextFor(items: CatalogItem[], categoryName: string): string {
  const parts = [categoryName];
  for (const i of items) {
    parts.push(i.name, i.variant, i.subcategory, ...i.synonyms);
  }
  return normalizeText(parts.join(' '));
}

export async function importCatalog(
  db: Db,
  csv: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const cats = await listCategories(db);
  const catName = new Map(cats.map((c) => [c.slug, c.name]));
  const { items, errors, warnings } = parseCatalogCsv(csv, { categories: [...catName.keys()] });

  const result: ImportResult = {
    ok: errors.length === 0,
    dryRun: options.dryRun ?? false,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    keptConfirmedPrices: [],
    errors,
    warnings,
  };
  if (errors.length > 0) return result;

  const groups = groupProducts(items);
  try {
    await db.transaction(async (tx) => {
      for (const group of groups) {
        const values = {
          group: group.group,
          name: group.name,
          categorySlug: group.category,
          subcategory: group.subcategory,
          description: group.description,
          cookingTip: group.cookingTip,
          pricingUnit: group.pricingUnit,
          synonyms: [...new Set(group.variants.flatMap((v) => v.synonyms))],
          searchText: searchTextFor(group.variants, catName.get(group.category) ?? ''),
          updatedAt: new Date(),
        };
        const [existingProduct] = await tx
          .select({ id: products.id })
          .from(products)
          .where(eq(products.group, group.group));
        let productId: string;
        if (existingProduct) {
          productId = existingProduct.id;
          await tx.update(products).set(values).where(eq(products.id, productId));
          result.productsUpdated++;
        } else {
          const [row] = await tx.insert(products).values(values).returning({ id: products.id });
          productId = row!.id;
          result.productsCreated++;
        }

        for (const item of group.variants) {
          const [existing] = await tx.select().from(variants).where(eq(variants.sku, item.sku));
          const common = {
            productId,
            variant: item.variant,
            pricingUnit: item.pricingUnit as PricingUnit,
            variableWeight: item.variableWeight,
            frozen: item.frozen,
            stepCentilb: item.stepCentilb,
            minCentilb: item.minCentilb,
            pieceCentilb: item.pieceCentilb,
            photo: item.photo,
            active: item.active,
            updatedAt: new Date(),
          };
          const priceFields = {
            price: item.price,
            priceSource: item.priceSource,
            priceNote: item.priceNote,
            cost: item.cost,
            itbisBps: item.itbisBps,
          };

          if (!existing) {
            const [row] = await tx
              .insert(variants)
              .values({ sku: item.sku, ...common, ...priceFields, onHand: item.stock })
              .returning({ id: variants.id });
            if (item.stock > 0) {
              await tx.insert(inventoryMovements).values({
                variantId: row!.id,
                type: 'receive',
                qty: item.stock,
                actorId: options.actorId ?? null,
                note: 'Stock inicial (importación CSV)',
              });
            }
            result.variantsCreated++;
            continue;
          }

          const protectConfirmed =
            existing.priceSource === 'usuario' &&
            item.priceSource !== 'usuario' &&
            !options.overwriteConfirmed;
          if (protectConfirmed) result.keptConfirmedPrices.push(item.sku);

          const set: Record<string, unknown> = { ...common };
          if (!protectConfirmed) {
            Object.assign(set, priceFields);
            // Un CSV sin ITBIS no borra un ITBIS ya confirmado.
            if (item.itbisBps === null) set.itbisBps = existing.itbisBps;
            if (item.cost === null) set.cost = existing.cost;
          }
          if (options.applyStockToExisting && item.stock !== existing.onHand) {
            set.onHand = item.stock;
            await tx.insert(inventoryMovements).values({
              variantId: existing.id,
              type: 'adjust',
              qty: item.stock - existing.onHand,
              actorId: options.actorId ?? null,
              note: 'Ajuste por importación CSV',
            });
          }
          await tx.update(variants).set(set).where(eq(variants.id, existing.id));
          result.variantsUpdated++;
        }
      }
      if (options.dryRun) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result;
}

// ───────────────────────── consulta para clientes ─────────────────────────

export interface VariantDTO {
  id: string;
  sku: string;
  variant: string;
  pricingUnit: PricingUnit;
  /** Precio por libra o por unidad, con ITBIS incluido (centavos). */
  price: number;
  /** ITBIS efectivo (en demo, null → 0). */
  itbisBps: number;
  variableWeight: boolean;
  frozen: boolean;
  stepCentilb: number | null;
  minCentilb: number | null;
  pieceCentilb: number | null;
  /** Disponible para pedir (centilibras o unidades). */
  available: number;
  inStock: boolean;
  photo: string;
  /** Precio no confirmado (solo se ve en modo demo). */
  unconfirmed: boolean;
}

export interface ProductDTO {
  group: string;
  name: string;
  category: string;
  subcategory: string;
  description: string;
  cookingTip: string;
  pricingUnit: PricingUnit;
  fromPrice: number;
  variants: VariantDTO[];
}

type VariantRow = typeof variants.$inferSelect;
type ProductRow = typeof products.$inferSelect;

function toVariantDTO(v: VariantRow): VariantDTO {
  const available = Math.max(0, v.onHand - v.reserved);
  const min = v.minCentilb ?? 1;
  return {
    id: v.id,
    sku: v.sku,
    variant: v.variant,
    pricingUnit: v.pricingUnit,
    price: v.price,
    itbisBps: v.itbisBps ?? 0,
    variableWeight: v.variableWeight,
    frozen: v.frozen,
    stepCentilb: v.stepCentilb,
    minCentilb: v.minCentilb,
    pieceCentilb: v.pieceCentilb,
    available,
    inStock: v.pricingUnit === 'lb' ? available >= min : available >= 1,
    photo: v.photo,
    unconfirmed: v.priceSource === 'estimado' || v.itbisBps === null,
  };
}

function toProductDTO(p: ProductRow, vs: VariantRow[]): ProductDTO {
  const dtos = vs.map(toVariantDTO);
  return {
    group: p.group,
    name: p.name,
    category: p.categorySlug,
    subcategory: p.subcategory,
    description: p.description,
    cookingTip: p.cookingTip,
    pricingUnit: p.pricingUnit,
    fromPrice: Math.min(...dtos.map((d) => d.price)),
    variants: dtos,
  };
}

export interface ListProductsQuery {
  category?: string;
  subcategory?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export async function listProducts(
  db: Db,
  demo: boolean,
  query: ListProductsQuery = {},
): Promise<{ items: ProductDTO[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const conditions: SQL[] = [
    eq(products.active, true),
    exists(
      db
        .select({ one: sql`1` })
        .from(variants)
        .where(and(eq(variants.productId, products.id), publishableVariantOnly(demo))),
    ),
  ];
  if (query.category) conditions.push(eq(products.categorySlug, query.category));
  if (query.subcategory) conditions.push(eq(products.subcategory, query.subcategory));
  const rawQuery = (query.q ?? '').trim();
  const tokens = normalizeText(rawQuery).split(' ').filter(Boolean);
  // Búsqueda vacía = todo el catálogo; solo símbolos ("%", "_") = sin resultados.
  if (rawQuery !== '' && tokens.length === 0) return { items: [], total: 0 };
  for (const t of tokens) {
    conditions.push(sql`${products.searchText} LIKE ${'%' + escapeLike(t) + '%'} ESCAPE '\\'`);
  }
  const where = and(...conditions);

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(where);

  const productRows = await db
    .select()
    .from(products)
    .innerJoin(categories, eq(categories.slug, products.categorySlug))
    .where(where)
    .orderBy(asc(categories.sort), asc(products.name))
    .limit(limit)
    .offset(offset);

  if (productRows.length === 0) return { items: [], total: count };
  const ids = productRows.map((r) => r.products.id);
  const variantRows = await db
    .select()
    .from(variants)
    .where(
      and(
        inArray(variants.productId, ids),
        eq(variants.active, true),
        publishableVariantOnly(demo),
      ),
    )
    .orderBy(asc(variants.price));

  const byProduct = new Map<string, VariantRow[]>();
  for (const v of variantRows)
    byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);

  const items = productRows
    .map((r) => toProductDTO(r.products, byProduct.get(r.products.id) ?? []))
    .filter((p) => p.variants.length > 0);
  return { items, total: count };
}

export async function getProduct(db: Db, demo: boolean, group: string): Promise<ProductDTO> {
  const [p] = await db.select().from(products).where(eq(products.group, group));
  if (!p || !p.active) throw notFound('Producto');
  const vs = await db
    .select()
    .from(variants)
    .where(
      and(eq(variants.productId, p.id), eq(variants.active, true), publishableVariantOnly(demo)),
    )
    .orderBy(asc(variants.price));
  if (vs.length === 0) throw notFound('Producto');
  return toProductDTO(p, vs);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Condición sobre `variants` (sin unir `products`): activo + regla de precio/ITBIS. */
function publishableVariantOnly(demo: boolean): SQL {
  return demo
    ? eq(variants.active, true)
    : and(
        eq(variants.active, true),
        ne(variants.priceSource, 'estimado'),
        sql`${variants.itbisBps} IS NOT NULL`,
      )!;
}

// ───────────────────────── administración ─────────────────────────

export interface VariantPatch {
  price?: number;
  priceSource?: 'ancla' | 'estimado' | 'usuario';
  priceNote?: string;
  cost?: number | null;
  itbisBps?: number | null;
  active?: boolean;
  lowStockThreshold?: number;
  photo?: string;
}

/**
 * Edita un artículo. Si se cambia el precio sin indicar la fuente, se asume que el dueño
 * lo confirmó (`usuario`): así un precio estimado deja de bloquear la publicación.
 */
export async function patchVariant(db: Db, variantId: string, patch: VariantPatch) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.price !== undefined) {
    if (!Number.isSafeInteger(patch.price) || patch.price <= 0) {
      throw invalid('El precio debe ser un entero positivo en centavos');
    }
    set.price = patch.price;
    set.priceSource = patch.priceSource ?? 'usuario';
  } else if (patch.priceSource !== undefined) {
    set.priceSource = patch.priceSource;
  }
  if (patch.itbisBps !== undefined) {
    if (
      patch.itbisBps !== null &&
      (!Number.isInteger(patch.itbisBps) || patch.itbisBps < 0 || patch.itbisBps > 10_000)
    ) {
      throw invalid('ITBIS inválido');
    }
    set.itbisBps = patch.itbisBps;
  }
  for (const key of ['priceNote', 'cost', 'active', 'lowStockThreshold', 'photo'] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  const [row] = await db.update(variants).set(set).where(eq(variants.id, variantId)).returning();
  if (!row) throw notFound('Artículo');
  return row;
}

export interface AdminVariantRow extends VariantRow {
  productName: string;
  productGroup: string;
  category: string;
  blockers: string[];
}

export async function listCatalogAdmin(
  db: Db,
  demo: boolean,
  filter: { category?: string; blockedOnly?: boolean } = {},
): Promise<AdminVariantRow[]> {
  const rows = await db
    .select()
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(filter.category ? eq(products.categorySlug, filter.category) : undefined)
    .orderBy(asc(products.categorySlug), asc(products.name), asc(variants.price));
  const mapped = rows.map((r) => ({
    ...r.variants,
    productName: r.products.name,
    productGroup: r.products.group,
    category: r.products.categorySlug,
    blockers: variantBlockers(r.variants, r.products.active, demo),
  }));
  return filter.blockedOnly ? mapped.filter((m) => m.blockers.length > 0) : mapped;
}

/**
 * SOLO DEMO: da existencias de ejemplo (200 lb / 50 unidades) a lo que está en cero, para poder
 * probar pedidos sin cargar inventario real. Queda registrado en la bitácora de movimientos.
 */
export async function seedDemoStock(db: Db): Promise<number> {
  const empty = await db
    .select({ id: variants.id, pricingUnit: variants.pricingUnit })
    .from(variants)
    .where(eq(variants.onHand, 0));
  for (const v of empty) {
    await adjustStock(db, v.id, 'receive', v.pricingUnit === 'lb' ? 20_000 : 50, {
      note: 'Existencias de ejemplo (modo demo)',
    });
  }
  return empty.length;
}

/**
 * Exporta todo el catálogo en el mismo formato que acepta la importación. Sirve para editarlo en
 * Excel y volver a subirlo sin perder nada (incluye existencias, costos, sinónimos y notas).
 */
export async function exportCatalogCsv(db: Db): Promise<string> {
  const rows = await db
    .select()
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .orderBy(asc(products.categorySlug), asc(products.name), asc(variants.price));
  const items: CatalogItem[] = rows.map(({ variants: v, products: p }) => ({
    sku: v.sku,
    group: p.group,
    name: p.name,
    variant: v.variant,
    category: p.categorySlug,
    subcategory: p.subcategory,
    pricingUnit: v.pricingUnit,
    stepCentilb: v.stepCentilb,
    minCentilb: v.minCentilb,
    pieceCentilb: v.pieceCentilb,
    price: v.price,
    priceSource: v.priceSource,
    priceNote: v.priceNote,
    cost: v.cost,
    stock: v.onHand,
    itbisBps: v.itbisBps,
    variableWeight: v.variableWeight,
    frozen: v.frozen,
    synonyms: p.synonyms,
    description: p.description,
    cookingTip: p.cookingTip,
    photo: v.photo,
    active: v.active,
  }));
  return catalogToCsv(items);
}
