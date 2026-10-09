/**
 * Descarga las fotos del manifiesto a `data/catalog/photos/` para servirlas desde el propio API
 * (GET /photos/<sku>.webp) en vez de depender del CDN de generación.
 *
 *   npm run photos:fetch                    → descarga lo que falte
 *   npm run photos:fetch -- --rewrite       → además cambia `foto` del CSV a /photos/<sku>.webp
 *   npm run photos:fetch -- --force --only JF-RES-001,JF-RES-002
 *
 * Por cada SKU deja `<sku>.webp` (ancho máx. 1168, calidad 85) y `<sku>.thumb.webp` (ancho 480).
 * Verifica el tipo de contenido y las dimensiones antes de guardar y omite lo ya descargado.
 * Detrás de un proxy usa NODE_USE_ENV_PROXY=1 (Node ≥ 22.21): fetch no lo lee por sí solo.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type PhotoManifestItem,
  catalogToCsv,
  parseCatalogCsv,
  parsePhotoManifest,
} from '@jellyfish/catalog';
import sharp from 'sharp';

// En Windows la caché de archivos de sharp deja abierto el .webp leído y `rename` sobre él falla con EPERM
// (al repetir con --force o al rehacer una descarga truncada).
sharp.cache(false);

const root = resolve(import.meta.dirname, '..');

export const FULL_MAX_WIDTH = 1168;
export const FULL_QUALITY = 85;
export const THUMB_WIDTH = 480;
export const THUMB_QUALITY = 80;
/** Tope de descarga: una foto de catálogo jamás pesa esto; protege la memoria ante una URL equivocada. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED_FORMATS = new Set(['png', 'jpeg', 'webp']);

export type PhotoFetchStatus = 'downloaded' | 'skipped' | 'failed';

export interface PhotoFetchResult {
  sku: string;
  status: PhotoFetchStatus;
  /** Por qué falló, o un aviso (p. ej. relación de aspecto distinta a la del manifiesto). */
  detail?: string;
  width?: number;
  height?: number;
}

export interface FetchPhotosOptions {
  items: readonly PhotoManifestItem[];
  outDir: string;
  /** Vuelve a descargar aunque los archivos ya existan. */
  force?: boolean;
  /** Descargas simultáneas. */
  concurrency?: number;
  /** Intentos ante errores de red o respuestas 5xx. */
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const fileNames = (sku: string) => ({ full: `${sku}.webp`, thumb: `${sku}.thumb.webp` });

/** El SKU entra en un nombre de archivo: solo caracteres seguros, sin barras ni puntos. */
const SAFE_SKU = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

class FetchFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ¿Ya hay una descarga completa y legible de este SKU? Un archivo truncado no cuenta. */
async function alreadyDownloaded(
  outDir: string,
  sku: string,
): Promise<{ width: number; height: number } | null> {
  const names = fileNames(sku);
  const full = join(outDir, names.full);
  const thumb = join(outDir, names.thumb);
  if (!existsSync(full) || !existsSync(thumb)) return null;
  try {
    const [f, t] = await Promise.all([sharp(full).metadata(), sharp(thumb).metadata()]);
    const ok =
      f.format === 'webp' &&
      t.format === 'webp' &&
      !!f.width &&
      !!f.height &&
      f.width <= FULL_MAX_WIDTH &&
      t.width === Math.min(THUMB_WIDTH, f.width);
    return ok ? { width: f.width!, height: f.height! } : null;
  } catch {
    return null;
  }
}

async function download(url: string, opts: Required<FetchPhotosOptions>): Promise<Buffer> {
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new FetchFailure(`sin respuesta (${(e as Error).message})`, true);
  }
  if (!res.ok) throw new FetchFailure(`HTTP ${res.status}`, res.status >= 500);
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!type.startsWith('image/')) {
    throw new FetchFailure(`no es una imagen (content-type: ${type || 'ausente'})`);
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new FetchFailure('la imagen pesa demasiado');
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) throw new FetchFailure('respuesta vacía');
  if (body.length > MAX_DOWNLOAD_BYTES) throw new FetchFailure('la imagen pesa demasiado');
  return body;
}

/** Escribe a un temporal y renombra: un corte a mitad nunca deja un `.webp` truncado. */
async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

function aspectOf(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(label.trim());
  return m ? Number(m[1]) / Number(m[2]) : null;
}

async function fetchOne(
  item: PhotoManifestItem,
  opts: Required<FetchPhotosOptions>,
): Promise<PhotoFetchResult> {
  const { sku } = item;
  if (!SAFE_SKU.test(sku)) {
    return { sku, status: 'failed', detail: 'el SKU no sirve como nombre de archivo' };
  }
  if (!opts.force) {
    const existing = await alreadyDownloaded(opts.outDir, sku);
    if (existing) return { sku, status: 'skipped', ...existing };
  }

  let body: Buffer | undefined;
  let lastError = '';
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      body = await download(item.rawUrl, opts);
      break;
    } catch (e) {
      lastError = (e as Error).message;
      if (!(e instanceof FetchFailure && e.retryable) || attempt === opts.attempts) break;
      await sleep(opts.retryDelayMs * attempt);
    }
  }
  if (!body) return { sku, status: 'failed', detail: lastError };

  try {
    const meta = await sharp(body).metadata();
    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
      return {
        sku,
        status: 'failed',
        detail: `formato no admitido (${meta.format ?? 'ilegible'})`,
      };
    }
    const { width, height } = meta;
    if (!width || !height) return { sku, status: 'failed', detail: 'sin dimensiones' };
    // Sin esto la miniatura saldría ampliada y borrosa: una foto tan chica no sirve para el catálogo.
    if (width < THUMB_WIDTH) {
      return {
        sku,
        status: 'failed',
        detail: `imagen muy pequeña (${width}×${height}); mínimo ${THUMB_WIDTH} px de ancho`,
      };
    }

    const full = await sharp(body)
      .rotate()
      .resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true })
      .webp({ quality: FULL_QUALITY })
      .toBuffer();
    const thumb = await sharp(body)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();

    // Se comprueba lo que quedó escrito, no lo que se pidió.
    const [fm, tm] = await Promise.all([sharp(full).metadata(), sharp(thumb).metadata()]);
    if (
      fm.format !== 'webp' ||
      !fm.width ||
      fm.width > FULL_MAX_WIDTH ||
      tm.width !== THUMB_WIDTH
    ) {
      return { sku, status: 'failed', detail: 'el redimensionado dejó dimensiones inesperadas' };
    }

    try {
      await mkdir(opts.outDir, { recursive: true });
      const names = fileNames(sku);
      await writeAtomic(join(opts.outDir, names.full), full);
      await writeAtomic(join(opts.outDir, names.thumb), thumb);
    } catch (e) {
      return { sku, status: 'failed', detail: `no se pudo guardar (${(e as Error).message})` };
    }

    const expected = aspectOf(item.aspect);
    const actual = (fm.width ?? 1) / (fm.height ?? 1);
    const skewed = expected !== null && Math.abs(actual - expected) / expected > 0.03;
    return {
      sku,
      status: 'downloaded',
      width: fm.width,
      height: fm.height,
      detail: skewed
        ? `aviso: el aspecto real es ${actual.toFixed(2)} y el manifiesto dice ${item.aspect}`
        : undefined,
    };
  } catch (e) {
    return { sku, status: 'failed', detail: `imagen ilegible (${(e as Error).message})` };
  }
}

/** Descarga las entradas con un máximo de `concurrency` a la vez; devuelve un resultado por SKU, en orden. */
export async function fetchPhotos(options: FetchPhotosOptions): Promise<PhotoFetchResult[]> {
  // Una opción presente pero `undefined` (p. ej. venida de la línea de comandos) no pisa el valor por defecto.
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts: Required<FetchPhotosOptions> = {
    force: false,
    concurrency: 4,
    attempts: 3,
    retryDelayMs: 500,
    timeoutMs: 30_000,
    fetchImpl: fetch,
    ...given,
  } as Required<FetchPhotosOptions>;
  const results: PhotoFetchResult[] = new Array(opts.items.length);
  let next = 0;
  const worker = async () => {
    while (next < opts.items.length) {
      const i = next++;
      results[i] = await fetchOne(opts.items[i]!, opts);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.items.length)) }, worker),
  );
  return results;
}

export interface RewriteResult {
  csv: string;
  csvChanged: boolean;
  /** SKUs cuya foto pasó a /photos/<sku>.webp. */
  rewritten: string[];
  /** SKUs con la foto ya local. */
  alreadyLocal: string[];
  /** SKUs cuya foto en el CSV no es la del manifiesto (p. ej. una foto real): no se tocan. */
  kept: string[];
  errors: string[];
}

/**
 * Cambia `foto` a la ruta pública solo en las filas cuyo archivo local ya existe y cuya foto
 * actual es la del manifiesto. Lo demás del CSV queda igual (pasa por parse/catalogToCsv).
 */
export function rewritePhotoPaths(
  csv: string,
  categories: readonly string[],
  localSkus: ReadonlySet<string>,
  manifestItems: readonly PhotoManifestItem[],
): RewriteResult {
  const parsed = parseCatalogCsv(csv, { categories });
  if (parsed.errors.length > 0) {
    return {
      csv,
      csvChanged: false,
      rewritten: [],
      alreadyLocal: [],
      kept: [],
      errors: parsed.errors.map((e) => `fila ${e.line} [${e.sku}] ${e.field}: ${e.message}`),
    };
  }
  const bySku = new Map(manifestItems.map((m) => [m.sku, m]));
  const rewritten: string[] = [];
  const alreadyLocal: string[] = [];
  const kept: string[] = [];
  const items = parsed.items.map((item) => {
    const entry = bySku.get(item.sku);
    if (!entry || !localSkus.has(item.sku)) return item;
    const local = `/photos/${item.sku}.webp`;
    if (item.photo === local) {
      alreadyLocal.push(item.sku);
      return item;
    }
    if (item.photo !== entry.rawUrl) {
      kept.push(item.sku);
      return item;
    }
    rewritten.push(item.sku);
    return { ...item, photo: local };
  });
  const out = catalogToCsv(items);
  return { csv: out, csvChanged: out !== csv, rewritten, alreadyLocal, kept, errors: [] };
}

export interface PhotosFetchIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export async function runPhotosFetch(
  argv: string[],
  io: PhotosFetchIo = { log: console.log, error: console.error },
  deps: { fetchImpl?: typeof fetch; retryDelayMs?: number } = {},
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        manifest: { type: 'string' },
        out: { type: 'string' },
        csv: { type: 'string' },
        categories: { type: 'string' },
        only: { type: 'string' },
        concurrency: { type: 'string' },
        rewrite: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    io.error(`Opción no válida: ${(e as Error).message}`);
    return 2;
  }
  const manifestPath = resolve(values.manifest ?? `${root}/data/catalog/photos.manifest.json`);
  const outDir = resolve(values.out ?? `${root}/data/catalog/photos`);
  const csvPath = resolve(values.csv ?? `${root}/data/catalog/products.seed.csv`);
  const categoriesPath = resolve(values.categories ?? `${root}/data/catalog/categories.json`);
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    io.error('--concurrency debe ser un entero entre 1 y 16');
    return 2;
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    io.error(`No se pudo leer el manifiesto (${manifestPath}): ${(e as Error).message}`);
    return 1;
  }
  const manifest = parsePhotoManifest(manifestJson);
  if (!manifest.ok) {
    io.error(`Manifiesto inválido (${manifestPath}):`);
    for (const m of manifest.errors) io.error(`  · ${m}`);
    return 1;
  }

  const only = values.only
    ? new Set(
        values.only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const items = manifest.manifest.items.filter((i) => !only || only.has(i.sku));
  if (only) {
    const unknown = [...only].filter((s) => !manifest.manifest.items.some((i) => i.sku === s));
    if (unknown.length > 0) {
      io.error(`--only: SKUs que no están en el manifiesto: ${unknown.join(', ')}`);
      return 1;
    }
  }

  const results = await fetchPhotos({
    items,
    outDir,
    force: values.force,
    concurrency,
    fetchImpl: deps.fetchImpl,
    retryDelayMs: deps.retryDelayMs,
  });
  for (const r of results) {
    const size = r.width ? ` ${r.width}×${r.height}` : '';
    const note = r.detail ? ` — ${r.detail}` : '';
    io.log(`${r.status === 'failed' ? 'ERROR' : 'ok   '} ${r.sku} ${r.status}${size}${note}`);
  }
  const count = (s: PhotoFetchStatus) => results.filter((r) => r.status === s).length;
  io.log(
    `Descargadas: ${count('downloaded')} · Ya estaban: ${count('skipped')} · Fallidas: ${count('failed')}`,
  );
  io.log(`Carpeta: ${outDir}`);

  if (values.rewrite) {
    try {
      const categories = (
        JSON.parse(readFileSync(categoriesPath, 'utf8')) as { slug: string }[]
      ).map((c) => c.slug);
      const csv = readFileSync(csvPath, 'utf8');
      const local = new Set(results.filter((r) => r.status !== 'failed').map((r) => r.sku));
      const out = rewritePhotoPaths(csv, categories, local, manifest.manifest.items);
      if (out.errors.length > 0) {
        io.error(`El CSV tiene errores; no se reescribió (${csvPath}):`);
        for (const e of out.errors) io.error(`  ${e}`);
        return 1;
      }
      if (out.csvChanged) writeFileSync(csvPath, out.csv);
      io.log(
        `CSV ${out.csvChanged ? 'actualizado' : 'sin cambios'}: ${out.rewritten.length} fotos pasaron a /photos/<sku>.webp, ${out.alreadyLocal.length} ya eran locales.`,
      );
      if (out.kept.length > 0) {
        io.log(`  Conservadas (su foto no es la del manifiesto): ${out.kept.join(', ')}`);
      }
    } catch (e) {
      io.error(`No se pudo reescribir el CSV: ${(e as Error).message}`);
      return 1;
    }
  }
  return count('failed') > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhotosFetch(process.argv.slice(2)).then((code) => process.exit(code));
}
