import { type CatalogItem, groupProducts, parseCatalogCsv } from '@jellyfish/catalog';
import type { CategoryDTO, PricingUnit, ProductDTO, VariantDTO } from '@jellyfish/shared';
import type { CategorySeed, DemoOptions, PhotoSeed, StockRec } from './types';
import { resolvePhoto } from './photos';
import { compareText, fnv1a, normalizeText, stableUuid } from './util';

/** Un artículo vendible (una fila del CSV) con todo lo que el servidor necesita saber de él. */
export interface VariantRec {
  id: string;
  sku: string;
  productGroup: string;
  variant: string;
  pricingUnit: PricingUnit;
  price: number;
  priceSource: 'ancla' | 'estimado' | 'usuario';
  itbisBps: number | null;
  variableWeight: boolean;
  frozen: boolean;
  stepCentilb: number | null;
  minCentilb: number | null;
  pieceCentilb: number | null;
  photo: string;
  /** La foto como llegó (antes de resolverla contra la carpeta de la página): base de la huella del catálogo. */
  photoSource: string;
  photoIllustrative: boolean;
  active: boolean;
  initialStock: StockRec;
}

export interface ProductRec {
  group: string;
  name: string;
  categorySlug: string;
  subcategory: string;
  description: string;
  cookingTip: string;
  pricingUnit: PricingUnit;
  synonyms: string[];
  searchText: string;
  variants: VariantRec[];
}

export interface DemoCatalog {
  categories: CategoryDTO[];
  products: ProductRec[];
  variantsById: Map<string, VariantRec>;
  productByGroup: Map<string, ProductRec>;
  productOfVariant: Map<string, ProductRec>;
  /** Huella del contenido: cambia si cambian precios, fotos o productos. */
  signature: string;
}

function photoMap(
  photos: DemoOptions['photos'],
): Map<string, { url: string; illustrative: boolean }> {
  const map = new Map<string, { url: string; illustrative: boolean }>();
  if (!photos) return map;
  if (Array.isArray(photos)) {
    for (const p of photos as PhotoSeed[])
      map.set(p.sku, { url: p.url, illustrative: p.illustrative });
  } else {
    for (const [sku, p] of Object.entries(photos)) map.set(sku, p);
  }
  return map;
}

/** Existencias de ejemplo holgadas: 100–400 lb por artículo y 30–120 unidades, según el SKU. */
export function demoStockFor(
  item: Pick<CatalogItem, 'sku' | 'pricingUnit' | 'stock'>,
  stock: DemoOptions['stock'] = {},
): StockRec {
  const fixed = stock.bySku?.[item.sku];
  let onHand: number;
  if (fixed !== undefined) onHand = fixed;
  else if (item.pricingUnit === 'lb') {
    onHand = stock.lbCentilb ?? (100 + (fnv1a(item.sku) % 301)) * 100;
  } else {
    onHand = stock.units ?? 30 + (fnv1a(item.sku) % 91);
  }
  return { onHand, reserved: 0 };
}

export function buildCatalog(options: DemoOptions): DemoCatalog {
  const categorySeeds: CategorySeed[] = options.categories;
  const parsed = parseCatalogCsv(options.catalogCsv, {
    categories: categorySeeds.map((c) => c.slug),
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]!;
    throw new Error(
      `El catálogo de la demostración no es válido (fila ${first.line}, ${first.field}): ${first.message}`,
    );
  }
  const photos = photoMap(options.photos);
  const categoryName = new Map(categorySeeds.map((c) => [c.slug, c.name]));

  const products: ProductRec[] = [];
  const variantsById = new Map<string, VariantRec>();
  const productByGroup = new Map<string, ProductRec>();
  const productOfVariant = new Map<string, ProductRec>();

  for (const group of groupProducts(parsed.items)) {
    const variants: VariantRec[] = group.variants.map((item) => {
      const manifest = photos.get(item.sku);
      // Una foto real del dueño (foto_ilustrativa = no) vale más que la ilustración generada.
      // En la vista previa publicada (`localPhotosOnly`) la columna `foto` del CSV no cuenta: ahí solo
      // hay fotos propias, las del manifiesto que se copiaron junto a la página.
      const keepOwn =
        !options.localPhotosOnly && item.photo !== '' && item.photoIllustrative === false;
      const photoSource = options.localPhotosOnly
        ? (manifest?.url ?? '')
        : keepOwn
          ? item.photo
          : (manifest?.url ?? item.photo);
      const photo = resolvePhoto(photoSource, {
        photoBase: options.photoBase,
        localOnly: options.localPhotosOnly,
      });
      const illustrative = keepOwn
        ? false
        : (manifest?.illustrative ?? item.photoIllustrative ?? true);
      return {
        id: stableUuid(`variant:${item.sku}`),
        sku: item.sku,
        productGroup: group.group,
        variant: item.variant,
        pricingUnit: item.pricingUnit,
        price: item.price,
        priceSource: item.priceSource,
        itbisBps: item.itbisBps,
        variableWeight: item.variableWeight,
        frozen: item.frozen,
        stepCentilb: item.stepCentilb,
        minCentilb: item.minCentilb,
        pieceCentilb: item.pieceCentilb,
        photo,
        photoSource,
        photoIllustrative: illustrative,
        active: item.active,
        initialStock: demoStockFor(item, options.stock),
      };
    });
    const searchParts = [categoryName.get(group.category) ?? ''];
    for (const i of group.variants)
      searchParts.push(i.name, i.variant, i.subcategory, ...i.synonyms);
    const product: ProductRec = {
      group: group.group,
      name: group.name,
      categorySlug: group.category,
      subcategory: group.subcategory,
      description: group.description,
      cookingTip: group.cookingTip,
      pricingUnit: group.pricingUnit,
      synonyms: [...new Set(group.variants.flatMap((v) => v.synonyms))],
      searchText: normalizeText(searchParts.join(' ')),
      variants,
    };
    products.push(product);
    productByGroup.set(product.group, product);
    for (const v of variants) {
      variantsById.set(v.id, v);
      productOfVariant.set(v.id, product);
    }
  }

  const categories: CategoryDTO[] = categorySeeds
    .map((c) => ({ slug: c.slug, name: c.name, tagline: c.tagline ?? '', sort: c.sort ?? 0 }))
    .sort((a, b) => a.sort - b.sort || compareText(a.name, b.name));

  const signature = String(
    fnv1a(
      JSON.stringify([
        // La foto va sin resolver: si la página cambia de carpeta, el estado guardado no debe perderse.
        products.map((p) => [
          p.group,
          p.name,
          p.variants.map((v) => [v.sku, v.price, v.photoSource]),
        ]),
        categories,
      ]),
    ),
  );
  return { categories, products, variantsById, productByGroup, productOfVariant, signature };
}

// ───────────────────────── reglas de publicación ─────────────────────────

/**
 * Regla de publicación del modo demo (igual que `variantBlockers(…, demo = true)` del API):
 * activo y con precio. Los precios estimados o el ITBIS sin confirmar SÍ se muestran.
 */
export function publishable(v: VariantRec, productActive = true): boolean {
  return productActive && v.active && v.price > 0;
}

export interface StockView {
  get(variantId: string): StockRec;
}

function toVariantDTO(v: VariantRec, stock: StockRec): VariantDTO {
  const available = Math.max(0, stock.onHand - stock.reserved);
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
    photoIllustrative: v.photoIllustrative,
    unconfirmed: v.priceSource === 'estimado' || v.itbisBps === null,
  };
}

function sortedPublishable(p: ProductRec): VariantRec[] {
  return p.variants
    .filter((v) => publishable(v))
    .sort((a, b) => a.price - b.price || compareText(a.sku, b.sku));
}

function toProductDTO(p: ProductRec, vs: VariantRec[], stock: StockView): ProductDTO {
  const dtos = vs.map((v) => toVariantDTO(v, stock.get(v.id)));
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

/** Solo las categorías con al menos un producto publicable, en orden de menú. */
export function listCategories(catalog: DemoCatalog): CategoryDTO[] {
  return catalog.categories
    .filter((c) =>
      catalog.products.some((p) => p.categorySlug === c.slug && sortedPublishable(p).length > 0),
    )
    .map((c) => ({ ...c }));
}

export interface ListProductsQuery {
  category?: string | undefined;
  subcategory?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function listProducts(
  catalog: DemoCatalog,
  stock: StockView,
  query: ListProductsQuery = {},
): { items: ProductDTO[]; total: number } {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const rawQuery = (query.q ?? '').trim();
  const tokens = normalizeText(rawQuery).split(' ').filter(Boolean);
  // Búsqueda vacía = todo el catálogo; solo símbolos ("%", "_") = sin resultados.
  if (rawQuery !== '' && tokens.length === 0) return { items: [], total: 0 };

  const sortOf = new Map(catalog.categories.map((c) => [c.slug, c.sort]));
  const matches = catalog.products
    .filter((p) => sortedPublishable(p).length > 0)
    .filter((p) => !query.category || p.categorySlug === query.category)
    .filter((p) => !query.subcategory || p.subcategory === query.subcategory)
    .filter((p) => tokens.every((t) => p.searchText.includes(t)))
    .sort(
      (a, b) =>
        (sortOf.get(a.categorySlug) ?? 0) - (sortOf.get(b.categorySlug) ?? 0) ||
        compareText(a.name, b.name),
    );

  const page = matches.slice(offset, offset + limit);
  return {
    items: page.map((p) => toProductDTO(p, sortedPublishable(p), stock)),
    total: matches.length,
  };
}

export function getProductByGroup(
  catalog: DemoCatalog,
  stock: StockView,
  group: string,
): ProductDTO | null {
  const p = catalog.productByGroup.get(group);
  if (!p) return null;
  const vs = sortedPublishable(p);
  if (vs.length === 0) return null;
  return toProductDTO(p, vs, stock);
}
