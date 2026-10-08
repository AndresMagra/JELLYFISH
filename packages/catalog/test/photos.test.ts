import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type PhotoManifest,
  type PhotoManifestItem,
  applyPhotoManifest,
  catalogToCsv,
  parseCatalogCsv,
  parseCsv,
  parsePhotoManifest,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const catalogDir = join(here, '../../../data/catalog');
const categories = (
  JSON.parse(readFileSync(join(catalogDir, 'categories.json'), 'utf8')) as { slug: string }[]
).map((c) => c.slug);
const seed = readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8');

const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/user_x';
const entry = (sku: string, over: Partial<PhotoManifestItem> = {}): PhotoManifestItem => ({
  sku,
  jobId: `job-${sku}`,
  rawUrl: `${CDN}/hf_${sku}.png`,
  minUrl: `${CDN}/hf_${sku}_min.webp`,
  illustrative: true,
  model: 'm',
  quality: 'high',
  aspect: '4:3',
  attempts: 1,
  verified: true,
  notes: '',
  ...over,
});
const manifestOf = (...items: PhotoManifestItem[]): PhotoManifest => ({
  generatedWith: 'prueba',
  items,
});

const HEADER = 'sku,nombre,categoria,unidad,precio,costo,stock,itbis,foto,foto_ilustrativa';
const SMALL = [
  HEADER,
  'A-1,Pechuga,aves,lb,174.95,100.5,12,0,,',
  'B-2,Camarón,mariscos,lb,879.95,,3,18,/photos/B-2.webp,no',
  'C-3,Combo,combos,unidad,2450,,5,18,,',
].join('\n');

const apply = (csv: string, m: PhotoManifest, extra = {}) =>
  applyPhotoManifest(csv, m, { categories, ...extra });

describe('parsePhotoManifest', () => {
  it('acepta el manifiesto real del repositorio', () => {
    const real = JSON.parse(readFileSync(join(catalogDir, 'photos.manifest.json'), 'utf8'));
    const r = parsePhotoManifest(real);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.items.length).toBeGreaterThan(0);
  });

  it('rechaza SKUs repetidos: dos fotos para un mismo artículo es ambiguo', () => {
    const r = parsePhotoManifest(manifestOf(entry('A-1'), entry('A-1', { jobId: 'otro' })));
    expect(r).toEqual({ ok: false, errors: ['SKU repetido en el manifiesto: A-1'] });
  });

  it('rechaza campos que faltan, URLs que no son http(s) y SKUs vacíos', () => {
    const bad = parsePhotoManifest({
      generatedWith: 'x',
      items: [{ sku: ' ', rawUrl: 'ftp://x/y.png', illustrative: 'si' }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join('\n');
      expect(text).toMatch(/items\.0\.sku/);
      expect(text).toMatch(/items\.0\.rawUrl/);
      expect(text).toMatch(/items\.0\.illustrative/);
    }
    expect(parsePhotoManifest('no es un objeto').ok).toBe(false);
  });

  it('rechaza URLs de más de 300 caracteres: el importador las rechazaría después', () => {
    const long = entry('A-1', { rawUrl: `${CDN}/hf_${'x'.repeat(300)}.png` });
    const r = parsePhotoManifest(manifestOf(long));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/items\.0\.rawUrl/);
  });
});

describe('applyPhotoManifest', () => {
  it('escribe la URL en foto y foto_ilustrativa=si según el manifiesto', () => {
    const r = apply(SMALL, manifestOf(entry('A-1'), entry('C-3')));
    expect(r.errors).toEqual([]);
    const items = parseCatalogCsv(r.csv, { categories }).items;
    const by = Object.fromEntries(items.map((i) => [i.sku, i]));
    expect(by['A-1']).toMatchObject({ photo: `${CDN}/hf_A-1.png`, photoIllustrative: true });
    expect(by['C-3']).toMatchObject({ photo: `${CDN}/hf_C-3.png`, photoIllustrative: true });
    expect(r.report.updated).toEqual(['A-1', 'C-3']);
  });

  it('respeta illustrative:false del manifiesto (foto real)', () => {
    const r = apply(SMALL, manifestOf(entry('A-1', { illustrative: false })));
    const a = parseCatalogCsv(r.csv, { categories }).items.find((i) => i.sku === 'A-1')!;
    expect(a.photoIllustrative).toBe(false);
    expect(
      parseCsv(r.csv)
        .find((row) => row[0] === 'A-1')!
        .at(-1),
    ).toBe('no');
  });

  it('NO toca precios ni ningún otro campo: todo lo demás queda idéntico celda por celda', () => {
    const r = apply(seed, parsePhotoManifestOrThrow(join(catalogDir, 'photos.manifest.json')));
    expect(r.errors).toEqual([]);
    const before = parseCsv(seed);
    const after = parseCsv(r.csv);
    expect(after).toHaveLength(before.length);
    const changed = new Set(['foto', 'foto_ilustrativa']);
    let compared = 0;
    for (let c = 0; c < before[0]!.length; c++) {
      const col = before[0]![c]!;
      if (changed.has(col)) continue;
      const k = after[0]!.indexOf(col);
      expect(k, `columna ${col}`).toBeGreaterThanOrEqual(0);
      for (let row = 1; row < before.length; row++) {
        expect(after[row]![k], `${col} fila ${row}`).toBe(before[row]![c]);
        compared++;
      }
    }
    // Además de comparar celdas, los artículos reimportados salen iguales salvo la foto.
    const strip = (csv: string) =>
      parseCatalogCsv(csv, { categories }).items.map(
        ({ photo: _p, photoIllustrative: _i, ...rest }) => rest,
      );
    expect(strip(r.csv)).toEqual(strip(seed));
    expect(compared).toBeGreaterThan(38 * 15);
  });

  it('con el manifiesto real, las 38 filas del catálogo semilla quedan con su URL y sin huérfanas', () => {
    const manifest = parsePhotoManifestOrThrow(join(catalogDir, 'photos.manifest.json'));
    const r = apply(seed, manifest);
    const items = parseCatalogCsv(r.csv, { categories }).items;
    const bySku = new Map(manifest.items.map((m) => [m.sku, m]));
    for (const item of items) {
      expect(item.photo, item.sku).toBe(bySku.get(item.sku)!.rawUrl);
      expect(item.photoIllustrative, item.sku).toBe(true);
    }
    expect(r.report).toMatchObject({ withoutPhoto: [], orphans: [], skippedUnverified: [] });
    // La semilla ya trae las fotos aplicadas: cada fila queda "sin cambios" (o "actualizada" si no).
    const touched = [...r.report.updated, ...r.report.unchanged].sort();
    expect(touched).toEqual(items.map((i) => i.sku).sort());
    expect(touched).toHaveLength(manifest.items.length);
  });

  it('es idempotente: aplicarlo dos veces deja el mismo texto y no reporta cambios', () => {
    const m = manifestOf(entry('A-1'), entry('C-3'));
    const first = apply(SMALL, m);
    expect(first.csvChanged).toBe(true);
    const second = apply(first.csv, m);
    expect(second.csv).toBe(first.csv);
    expect(second.csvChanged).toBe(false);
    expect(second.report.updated).toEqual([]);
    expect(second.report.unchanged).toEqual(['A-1', 'C-3']);
  });

  it('reporta los SKUs que quedan sin foto y las entradas huérfanas', () => {
    const r = apply(SMALL, manifestOf(entry('A-1'), entry('Z-9')));
    expect(r.report.orphans).toEqual(['Z-9']);
    // C-3 no tiene entrada; B-2 ya traía su propia foto.
    expect(r.report.withoutPhoto).toEqual(['C-3']);
    expect(r.report.updated).toEqual(['A-1']);
  });

  it('omite entradas sin verificar, salvo que se pida incluirlas', () => {
    const m = manifestOf(entry('A-1', { verified: false }));
    const skipped = apply(SMALL, m);
    expect(skipped.report.skippedUnverified).toEqual(['A-1']);
    expect(skipped.report.updated).toEqual([]);
    expect(skipped.report.withoutPhoto).toContain('A-1');
    const forced = apply(SMALL, m, { includeUnverified: true });
    expect(forced.report.updated).toEqual(['A-1']);
    expect(forced.report.skippedUnverified).toEqual([]);
  });

  it('conserva una foto real del dueño (foto_ilustrativa=no) salvo con force', () => {
    const m = manifestOf(entry('B-2'));
    const kept = apply(SMALL, m);
    expect(kept.report.keptReal).toEqual(['B-2']);
    const b = parseCatalogCsv(kept.csv, { categories }).items.find((i) => i.sku === 'B-2')!;
    expect(b).toMatchObject({ photo: '/photos/B-2.webp', photoIllustrative: false });

    const forced = apply(SMALL, m, { force: true });
    const b2 = parseCatalogCsv(forced.csv, { categories }).items.find((i) => i.sku === 'B-2')!;
    expect(b2).toMatchObject({ photo: `${CDN}/hf_B-2.png`, photoIllustrative: true });
  });

  it('si el CSV tiene errores no devuelve un CSV nuevo y lo dice con fila y SKU', () => {
    const broken = `${HEADER}\nA-1,Pechuga,aves,lb,gratis,,,,,\n`;
    const r = apply(broken, manifestOf(entry('A-1')));
    expect(r.csv).toBe(broken);
    expect(r.csvChanged).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ line: 2, sku: 'A-1', field: 'precio' })]);
    expect(r.report.updated).toEqual([]);
  });

  it('agrega la columna foto_ilustrativa a un CSV que no la tenía, sin perder datos', () => {
    const legacy = 'sku,nombre,categoria,unidad,precio,foto\nA-1,Pechuga,aves,lb,174.95,\n';
    const r = apply(legacy, manifestOf(entry('A-1')));
    expect(parseCsv(r.csv)[0]).toContain('foto_ilustrativa');
    expect(parseCatalogCsv(r.csv, { categories }).items[0]).toMatchObject({
      sku: 'A-1',
      price: 17495,
      photo: `${CDN}/hf_A-1.png`,
    });
  });

  it('lo que escribe coincide con lo que produce catalogToCsv sobre los mismos artículos', () => {
    const r = apply(SMALL, manifestOf(entry('A-1')));
    const items = parseCatalogCsv(r.csv, { categories }).items;
    expect(catalogToCsv(items)).toBe(r.csv);
  });
});

function parsePhotoManifestOrThrow(path: string): PhotoManifest {
  const r = parsePhotoManifest(JSON.parse(readFileSync(path, 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.manifest;
}
