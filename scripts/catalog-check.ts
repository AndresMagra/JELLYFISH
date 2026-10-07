/**
 * Valida un CSV de catálogo sin tocar ninguna base de datos (prueba en seco).
 *   npm run catalog:check                      → revisa data/catalog/products.seed.csv
 *   npm run catalog:check -- ruta/inventario.csv
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatDOP } from '@jellyfish/shared';
import { groupProducts, parseCatalogCsv, publishability } from '@jellyfish/catalog';

const root = resolve(import.meta.dirname, '..');
const file = resolve(process.argv[2] ?? `${root}/data/catalog/products.seed.csv`);
const categories = (
  JSON.parse(readFileSync(`${root}/data/catalog/categories.json`, 'utf8')) as { slug: string }[]
).map((c) => c.slug);

const { items, errors, warnings } = parseCatalogCsv(readFileSync(file, 'utf8'), { categories });

const pad = (n: number | string, w = 5) => String(n).padStart(w);
console.log(`\nArchivo: ${file}`);
console.log(`Filas válidas: ${items.length}   Productos (grupos): ${groupProducts(items).length}`);

const bySource = (s: string) => items.filter((i) => i.priceSource === s).length;
console.log(
  `Precios → ancla: ${bySource('ancla')} · estimado: ${bySource('estimado')} · usuario: ${bySource('usuario')}`,
);
const publishable = items.filter((i) => publishability(i).publishable);
console.log(`Publicables hoy: ${publishable.length} de ${items.length}`);

const blockers = new Map<string, number>();
for (const i of items)
  for (const r of publishability(i).reasons) blockers.set(r, (blockers.get(r) ?? 0) + 1);
for (const [reason, n] of blockers) console.log(`  · ${pad(n)} bloqueados: ${reason}`);

if (items.length > 0) {
  const prices = items.filter((i) => i.pricingUnit === 'lb').map((i) => i.price);
  console.log(
    `Rango por libra: ${formatDOP(Math.min(...prices))} – ${formatDOP(Math.max(...prices))}`,
  );
}

for (const w of warnings) console.log(`AVISO  fila ${w.line} [${w.sku}] ${w.field}: ${w.message}`);
for (const e of errors) console.log(`ERROR  fila ${e.line} [${e.sku}] ${e.field}: ${e.message}`);
console.log(errors.length ? `\n✖ ${errors.length} error(es)\n` : '\n✔ Sin errores\n');
process.exit(errors.length ? 1 : 0);
