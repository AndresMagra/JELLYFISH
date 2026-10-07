import { z } from 'zod';
import { catalogToCsv, parseCatalogCsv } from './import';
import type { CatalogItem, RowIssue } from './types';

/**
 * Manifiesto de fotos (`data/catalog/photos.manifest.json`): lo deja la generación de imágenes y
 * `photos:apply` lo vuelca en el CSV del catálogo. Lógica pura (sin disco ni red) para poder
 * probarla; los scripts solo leen y escriben archivos.
 */
export interface PhotoManifestItem {
  sku: string;
  jobId: string;
  /** Imagen completa en el CDN de generación (va a la columna `foto` del CSV). */
  rawUrl: string;
  /** Variante liviana del mismo CDN (la app la deriva con `photoThumb`). */
  minUrl: string;
  /** true = imagen generada, no una foto real del producto. */
  illustrative: boolean;
  model: string;
  quality: string;
  aspect: string;
  attempts: number;
  /** Un revisor independiente aprobó la imagen. */
  verified: boolean;
  notes: string;
}

export interface PhotoManifest {
  generatedWith: string;
  items: PhotoManifestItem[];
}

const httpUrl = z
  .string()
  .trim()
  .refine((u) => /^https?:\/\/\S+$/i.test(u), 'debe ser una URL http(s)');

const manifestSchema = z.object({
  generatedWith: z.string(),
  items: z.array(
    z.object({
      sku: z.string().trim().min(1, 'el SKU no puede estar vacío'),
      jobId: z.string(),
      rawUrl: httpUrl,
      minUrl: z.string(),
      illustrative: z.boolean(),
      model: z.string(),
      quality: z.string(),
      aspect: z.string(),
      attempts: z.number().int().nonnegative(),
      verified: z.boolean(),
      notes: z.string(),
    }),
  ),
});

export type ParsedPhotoManifest =
  { ok: true; manifest: PhotoManifest } | { ok: false; errors: string[] };

/** Valida la forma del manifiesto y que no repita SKU (dos fotos para un mismo artículo es ambiguo). */
export function parsePhotoManifest(input: unknown): ParsedPhotoManifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'manifiesto'}: ${i.message}`),
    };
  }
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const item of parsed.data.items) {
    if (seen.has(item.sku)) errors.push(`SKU repetido en el manifiesto: ${item.sku}`);
    seen.add(item.sku);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest: parsed.data };
}

export interface ApplyPhotosOptions {
  /** Slugs de categoría válidos (los mismos que usa `parseCatalogCsv`). */
  categories: readonly string[];
  /** Aplica también las entradas con `verified: false` (por defecto se omiten y se reportan). */
  includeUnverified?: boolean;
  /** Pisa también una foto real (`foto_ilustrativa = no`) que ya tenga la fila. */
  force?: boolean;
}

export interface ApplyPhotosReport {
  /** SKUs cuya foto o rótulo "ilustrativa" cambió. */
  updated: string[];
  /** SKUs que ya tenían exactamente lo que dice el manifiesto. */
  unchanged: string[];
  /** Filas del CSV que quedan sin foto tras aplicar. */
  withoutPhoto: string[];
  /** Entradas del manifiesto cuyo SKU no existe en el CSV. */
  orphans: string[];
  /** Entradas omitidas por no estar verificadas. */
  skippedUnverified: string[];
  /** Filas con foto real del dueño que se conservaron (usa `force` para pisarlas). */
  keptReal: string[];
}

export interface ApplyPhotosResult {
  /** CSV resultante; si hubo errores es el de entrada, sin tocar. */
  csv: string;
  /** El texto del CSV cambió (también al añadir la columna `foto_ilustrativa`). */
  csvChanged: boolean;
  errors: RowIssue[];
  warnings: RowIssue[];
  report: ApplyPhotosReport;
}

/**
 * Escribe en `foto` la URL del manifiesto y en `foto_ilustrativa` lo que este diga. Pasa todo por
 * `parseCatalogCsv`/`catalogToCsv`, así que precios y demás campos salen exactamente iguales y
 * un CSV inválido nunca se reescribe. Es idempotente: aplicarlo dos veces no cambia nada más.
 */
export function applyPhotoManifest(
  csv: string,
  manifest: PhotoManifest,
  options: ApplyPhotosOptions,
): ApplyPhotosResult {
  const report: ApplyPhotosReport = {
    updated: [],
    unchanged: [],
    withoutPhoto: [],
    orphans: [],
    skippedUnverified: [],
    keptReal: [],
  };
  const { items, errors, warnings } = parseCatalogCsv(csv, { categories: options.categories });
  if (errors.length > 0) return { csv, csvChanged: false, errors, warnings, report };

  const bySku = new Map(manifest.items.map((m) => [m.sku, m]));
  const known = new Set(items.map((i) => i.sku));
  report.orphans = manifest.items.filter((m) => !known.has(m.sku)).map((m) => m.sku);

  const next: CatalogItem[] = items.map((item) => {
    const entry = bySku.get(item.sku);
    if (!entry) return item;
    if (!entry.verified && !options.includeUnverified) {
      report.skippedUnverified.push(item.sku);
      return item;
    }
    // Una foto real subida por el dueño vale más que una imagen ilustrativa generada.
    if (item.photo !== '' && item.photoIllustrative === false && !options.force) {
      report.keptReal.push(item.sku);
      return item;
    }
    if (item.photo === entry.rawUrl && item.photoIllustrative === entry.illustrative) {
      report.unchanged.push(item.sku);
      return item;
    }
    report.updated.push(item.sku);
    return { ...item, photo: entry.rawUrl, photoIllustrative: entry.illustrative };
  });

  report.withoutPhoto = next.filter((i) => i.photo === '').map((i) => i.sku);
  const out = catalogToCsv(next);
  return { csv: out, csvChanged: out !== csv, errors, warnings, report };
}
