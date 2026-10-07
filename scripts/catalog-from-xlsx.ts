/**
 * Convierte el listado de precios del dueño (Excel) en el CSV del catálogo de JELLYFISH.
 *
 *   npm run catalog:from-xlsx -- --xlsx data/private/lista.xlsx --margen 15
 *
 * Opciones:
 *   --xlsx    Excel del listado (A = asterisco, B = producto, C = presentación, D = precio/lb)
 *   --margen  Beneficio sobre el precio del listado, en % (obligatorio)
 *   --itbis   sobre (por defecto): el listado NO incluye ITBIS, se suma 18 % a los que llevan asterisco
 *             incluido: el listado ya incluye el ITBIS
 *   --fecha   Fecha del listado (por defecto, la del nombre del archivo)
 *   --con-costo  Guarda el precio del listado como costo. ES UN DATO INTERNO: no lo subas a Git.
 *   --out     Archivo de salida (por defecto data/catalog/products.seed.csv)
 *
 * No escribe nada si hay errores.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSheet } from 'read-excel-file/node';
import {
  type PriceListMeta,
  catalogToCsv,
  consumerPrice,
  parseCatalogCsv,
  parsePriceListRows,
  priceListToCatalog,
} from '@jellyfish/catalog';

const root = fileURLToPath(new URL('../', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const xlsx = resolve(arg('xlsx') ?? `${root}data/private/lista-de-precios.xlsx`);
const out = resolve(arg('out') ?? `${root}data/catalog/products.seed.csv`);
const marginPct = Number(arg('margen'));
const mode = (arg('itbis') ?? 'sobre') as 'sobre' | 'incluido';
const includeCost = flag('con-costo');

if (!Number.isFinite(marginPct) || marginPct < 0) {
  console.error('Falta --margen (porcentaje de beneficio sobre el listado, p. ej. --margen 15).');
  process.exit(2);
}
if (mode !== 'sobre' && mode !== 'incluido') {
  console.error('--itbis debe ser "sobre" o "incluido".');
  process.exit(2);
}
const listDate =
  arg('fecha') ?? /\d{2}-\d{2}-\d{4}/.exec(xlsx)?.[0] ?? new Date().toISOString().slice(0, 10);

const categories = (
  JSON.parse(readFileSync(`${root}data/catalog/categories.json`, 'utf8')) as { slug: string }[]
).map((c) => c.slug);
const meta = JSON.parse(
  readFileSync(arg('meta') ?? `${root}data/catalog/lista-proveedor.meta.json`, 'utf8'),
) as PriceListMeta[];

const table = await readSheet(xlsx);
const parsed = parsePriceListRows(table);
for (const w of parsed.warnings) console.warn(`  aviso fila ${w.line}: ${w.message}`);
if (parsed.errors.length > 0) {
  for (const e of parsed.errors) console.error(`  ERROR fila ${e.line}: ${e.message}`);
  console.error('\nNo se escribió nada.');
  process.exit(1);
}

const rule = { marginBps: Math.round(marginPct * 100), itbisMode: mode } as const;
const { items, warnings, withoutMeta, unusedMeta } = priceListToCatalog(parsed.rows, meta, {
  rule,
  listDate,
  includeCost,
});
for (const w of warnings) console.warn(`  aviso fila ${w.line}: ${w.message}`);
for (const m of unusedMeta) console.warn(`  aviso: la ficha "${m.lista}" ya no está en el Excel`);

// Verifica que el CSV resultante lo acepta el mismo importador que usa el panel.
const csv = catalogToCsv(items);
const check = parseCatalogCsv(csv, { categories });
if (check.errors.length > 0) {
  for (const e of check.errors) console.error(`  ERROR ${e.sku} (${e.field}): ${e.message}`);
  console.error('\nEl CSV generado no pasa el importador. No se escribió nada.');
  process.exit(1);
}

writeFileSync(out, csv);
const taxed = parsed.rows.filter((r) => r.taxed).length;
console.log(
  `\n${items.length} productos escritos en ${out}\n` +
    `  con ITBIS (asterisco): ${taxed} · exentos: ${items.length - taxed}\n` +
    `  beneficio ${marginPct} % · listado ${mode === 'sobre' ? 'SIN' : 'CON'} ITBIS incluido · ` +
    `costo ${includeCost ? 'GUARDADO (no subir a Git)' : 'no guardado'}\n` +
    `  productos sin ficha: ${withoutMeta.length}`,
);
console.log('\n  listado → venta (RD$/lb)');
for (const r of parsed.rows) {
  const p = consumerPrice(r.listPrice, r.taxed, rule);
  console.log(
    `  ${r.taxed ? '*' : ' '} ${r.name.padEnd(34)} ${(r.listPrice / 100).toFixed(2).padStart(8)} → ${(p / 100).toFixed(2).padStart(8)}`,
  );
}
