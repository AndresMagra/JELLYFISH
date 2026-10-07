/**
 * Vuelca el manifiesto de fotos en el CSV del catálogo: escribe la URL en `foto` y `si`/`no` en
 * `foto_ilustrativa`. No toca precios ni ningún otro campo y se puede repetir sin efecto.
 *
 *   npm run photos:apply                    → escribe data/catalog/products.seed.csv
 *   npm run photos:apply -- --dry-run       → solo muestra qué cambiaría
 *   npm run photos:apply -- --csv x.csv --manifest y.json
 *
 * Opciones: --include-unverified (aplica también entradas sin verificar), --force (pisa fotos
 * reales), --strict (sale con error si quedan SKUs sin foto o entradas huérfanas).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { applyPhotoManifest, parsePhotoManifest } from '@jellyfish/catalog';

const root = resolve(import.meta.dirname, '..');

export interface PhotosApplyIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

/** Devuelve el código de salida (0 = bien). `io` permite capturar la salida en las pruebas. */
export function runPhotosApply(
  argv: string[],
  io: PhotosApplyIo = { log: console.log, error: console.error },
): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        csv: { type: 'string' },
        manifest: { type: 'string' },
        categories: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'include-unverified': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    io.error(`Opción no válida: ${(e as Error).message}`);
    return 2;
  }
  const csvPath = resolve(values.csv ?? `${root}/data/catalog/products.seed.csv`);
  const manifestPath = resolve(values.manifest ?? `${root}/data/catalog/photos.manifest.json`);
  const categoriesPath = resolve(values.categories ?? `${root}/data/catalog/categories.json`);
  const dryRun = values['dry-run'] === true;

  let manifestJson: unknown;
  let categories: string[];
  let csv: string;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
    categories = (JSON.parse(readFileSync(categoriesPath, 'utf8')) as { slug: string }[]).map(
      (c) => c.slug,
    );
    csv = readFileSync(csvPath, 'utf8');
  } catch (e) {
    io.error(`No se pudo leer un archivo de entrada: ${(e as Error).message}`);
    return 1;
  }

  const manifest = parsePhotoManifest(manifestJson);
  if (!manifest.ok) {
    io.error(`Manifiesto inválido (${manifestPath}):`);
    for (const m of manifest.errors) io.error(`  · ${m}`);
    return 1;
  }

  const result = applyPhotoManifest(csv, manifest.manifest, {
    categories,
    includeUnverified: values['include-unverified'],
    force: values.force,
  });
  if (result.errors.length > 0) {
    io.error(`El CSV tiene errores; no se escribió nada (${csvPath}):`);
    for (const e of result.errors) io.error(`  fila ${e.line} [${e.sku}] ${e.field}: ${e.message}`);
    return 1;
  }

  const r = result.report;
  io.log(`CSV: ${csvPath}`);
  io.log(`Manifiesto: ${manifestPath} (${manifest.manifest.items.length} entradas)`);
  io.log(
    `Actualizadas: ${r.updated.length} · Ya estaban al día: ${r.unchanged.length} · Sin foto: ${r.withoutPhoto.length}`,
  );
  const list = (title: string, skus: string[]) => {
    if (skus.length > 0) io.log(`  ${title} (${skus.length}): ${skus.join(', ')}`);
  };
  list('SKUs sin foto', r.withoutPhoto);
  list('Entradas huérfanas (el SKU no está en el CSV)', r.orphans);
  list('Omitidas por no estar verificadas', r.skippedUnverified);
  list('Fotos reales conservadas (usa --force para pisarlas)', r.keptReal);

  if (!result.csvChanged) {
    io.log('Sin cambios: el CSV ya refleja el manifiesto.');
  } else if (dryRun) {
    io.log('Prueba en seco (--dry-run): no se escribió nada.');
  } else {
    writeFileSync(csvPath, result.csv);
    io.log('CSV actualizado.');
  }

  if (values.strict && (r.withoutPhoto.length > 0 || r.orphans.length > 0)) {
    io.error('--strict: hay SKUs sin foto o entradas huérfanas.');
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runPhotosApply(process.argv.slice(2)));
}
