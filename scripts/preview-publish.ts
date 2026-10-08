/**
 * Lo que decide QUÉ se publica de la vista previa y si cabe: fotos propias, límites de la plataforma,
 * mapa de archivos para la herramienta de publicación y limpieza de los datos embebidos en la página.
 * Sin construir nada (no toca Expo ni esbuild): las usa scripts/build-preview.ts y las prueban las
 * pruebas de packages/demo-backend/test/preview-publish.test.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { detectDelimiter, normalizeHeader, parseCsv, toCsv } from '@jellyfish/catalog';
import sharp from 'sharp';

// ───────────────────────── límites de la plataforma ─────────────────────────

/** Límites de una publicación (herramienta de Artifacts): por archivo, por publicación y archivos binarios. */
export const LIMITS = {
  /** Archivos por publicación (el archivo principal cuenta como uno). */
  maxFiles: 255,
  /** Archivo principal y cada archivo de texto. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Cada archivo binario (fuentes, imágenes). */
  maxBinaryFileBytes: 15 * 1024 * 1024,
  /** Todo lo que viaja en una sola publicación. */
  maxTotalBytes: 64 * 1024 * 1024,
};

const TEXT_EXT = /\.(html?|js|mjs|css|json|txt|svg|xml|csv|md)$/i;
/** ¿Se cuenta como archivo de texto (límite de 16 MB) o binario (15 MB)? */
export const isTextFile = (path: string) => TEXT_EXT.test(path);

export interface FileEntry {
  path: string;
  bytes: number;
}

/** Archivos del build que NO se publican junto a la página (son para probar en local o describen el build). */
export const NOT_PUBLISHED = new Set([
  'artifact.html',
  'index.html',
  'favicon.ico',
  'preview-manifest.json',
  'publish-files.json',
]);

export const isPublishedAttachment = (path: string) =>
  !NOT_PUBLISHED.has(path) && !path.startsWith('icons/');

export interface LimitsCheck {
  fileCount: number;
  totalBytes: number;
  largestFile: FileEntry;
  withinLimits: boolean;
  problems: string[];
}

const mb = (n: number) => (n / 1048576).toFixed(1);

/** Ruta publicada válida: relativa, sin "..", sin barra inicial y sin caracteres raros. */
export function publishedPathProblem(path: string): string | null {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('//'))
    return `la ruta "${path}" no es relativa`;
  if (path.split('/').some((part) => part === '..' || part === '.' || part === ''))
    return `la ruta "${path}" sale de la carpeta de la página`;
  if (!/^[A-Za-z0-9._/-]+$/.test(path))
    return `la ruta "${path}" tiene caracteres que conviene evitar en una dirección web (usa letras, números, . _ - /)`;
  return null;
}

/**
 * Comprueba los límites de UNA publicación: el archivo principal cuenta como un archivo más. Pura (recibe
 * la lista de archivos), así se prueba con tamaños inventados.
 */
export function checkLimits(main: FileEntry, attachments: FileEntry[]): LimitsCheck {
  const all = [main, ...attachments];
  const totalBytes = all.reduce((a, f) => a + f.bytes, 0);
  const largestFile = all.reduce((m, f) => (f.bytes > m.bytes ? f : m), all[0]!);
  const problems: string[] = [];
  if (all.length > LIMITS.maxFiles)
    problems.push(`${all.length} archivos (el máximo por publicación es ${LIMITS.maxFiles})`);
  for (const f of all) {
    const limit = isTextFile(f.path) ? LIMITS.maxFileBytes : LIMITS.maxBinaryFileBytes;
    if (f.bytes > limit)
      problems.push(`${f.path} pesa ${mb(f.bytes)} MB (el máximo por archivo es ${mb(limit)} MB)`);
  }
  if (totalBytes > LIMITS.maxTotalBytes)
    problems.push(`${mb(totalBytes)} MB en total (el máximo por publicación es ${mb(LIMITS.maxTotalBytes)} MB)`);
  for (const f of attachments) {
    const bad = publishedPathProblem(f.path);
    if (bad) problems.push(bad);
  }
  return { fileCount: all.length, totalBytes, largestFile, withinLimits: problems.length === 0, problems };
}

/**
 * Reparte los archivos en grupos que caben cada uno en una publicación (el primero lleva también el
 * archivo principal). Con una carga normal sale un solo grupo; solo se divide si hace falta.
 */
export function splitForPublishing(main: FileEntry, attachments: FileEntry[]): FileEntry[][] {
  const groups: FileEntry[][] = [[]];
  let count = 1;
  let bytes = main.bytes;
  for (const f of [...attachments].sort((a, b) => b.bytes - a.bytes)) {
    if (count + 1 > LIMITS.maxFiles || bytes + f.bytes > LIMITS.maxTotalBytes) {
      groups.push([]);
      count = 0;
      bytes = 0;
    }
    groups[groups.length - 1]!.push(f);
    count++;
    bytes += f.bytes;
  }
  return groups.map((g) => g.sort((a, b) => (a.path < b.path ? -1 : 1)));
}

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function listFiles(outDir: string): FileEntry[] {
  return walk(outDir)
    .map((f) => ({ path: relative(outDir, f).split('\\').join('/'), bytes: statSync(f).size }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface PublishFiles {
  /** Archivo principal de la página: el fragmento. Va en `file_path` de la herramienta de publicación. */
  main: string;
  /** Mapa exacto para el parámetro `files`: {"ruta publicada": "ruta local absoluta"} (sin el archivo principal). */
  files: Record<string, string>;
  /** Todo cuenta el archivo principal. */
  fileCount: number;
  attachmentCount: number;
  totalBytes: number;
  largestFile: FileEntry;
  withinLimits: boolean;
  limits: typeof LIMITS;
  /** Solo si NO cabe en una publicación: cada grupo es un mapa para una publicación (la primera lleva `main`). */
  parts?: Record<string, string>[];
  notes: string[];
}

export interface PreviewManifest {
  buildId: string;
  generatedAt: string;
  publish: Omit<PublishFiles, 'files' | 'parts'> & { parts?: number };
  notes: string[];
  /** Todo lo que hay en la carpeta de salida (incluido lo que no se publica). */
  files: FileEntry[];
}

/** Escribe publish-files.json y preview-manifest.json a partir de lo que hay en la carpeta de salida. */
export function writePublishManifests(outDir: string, buildId: string, notes: string[]): PublishFiles {
  const all = listFiles(outDir);
  const sizeOf = (path: string) => statSync(`${outDir}/${path}`).size;
  const main: FileEntry = { path: 'artifact.html', bytes: sizeOf('artifact.html') };
  const attachments = all.filter((f) => isPublishedAttachment(f.path));
  const check = checkLimits(main, attachments);
  const local = (path: string) => `${outDir}/${path}`;
  const toMap = (list: FileEntry[]) =>
    Object.fromEntries(list.map((f) => [f.path, local(f.path)])) as Record<string, string>;

  const publishNotes = [...notes];
  let parts: Record<string, string>[] | undefined;
  if (!check.withinLimits) {
    const groups = splitForPublishing(main, attachments);
    // Dividir solo arregla "demasiados archivos / demasiado total", no un archivo suelto que no cabe ni una ruta mala.
    const splittable = check.problems.every((p) => /archivos \(el máximo|en total/.test(p));
    if (groups.length > 1 && splittable) {
      parts = groups.map(toMap);
      publishNotes.push(
        `NO cabe en una sola publicación (${check.problems.join('; ')}): se divide en ${groups.length} mapas en "parts"; la primera publicación lleva artifact.html y las siguientes se publican a la misma dirección (cada una agrega sus archivos).`,
      );
    } else {
      publishNotes.push(`EXCEDE LOS LÍMITES: ${check.problems.join('; ')}`);
    }
  }
  const publish: PublishFiles = {
    main: local('artifact.html'),
    files: toMap(attachments),
    fileCount: check.fileCount,
    attachmentCount: attachments.length,
    totalBytes: check.totalBytes,
    largestFile: check.largestFile,
    withinLimits: check.withinLimits,
    limits: LIMITS,
    ...(parts ? { parts } : {}),
    notes: publishNotes,
  };
  writeFileSync(`${outDir}/publish-files.json`, `${JSON.stringify(publish, null, 2)}\n`);

  // preview-manifest.json se cuenta a sí mismo (punto fijo: su tamaño no cambia lo que ya está medido).
  const manifest: PreviewManifest = {
    buildId,
    generatedAt: new Date().toISOString(),
    publish: {
      main: publish.main,
      fileCount: publish.fileCount,
      attachmentCount: publish.attachmentCount,
      totalBytes: publish.totalBytes,
      largestFile: publish.largestFile,
      withinLimits: publish.withinLimits,
      limits: LIMITS,
      ...(parts ? { parts: parts.length } : {}),
      notes: publishNotes,
    },
    notes: publishNotes,
    files: [...listFiles(outDir), { path: 'preview-manifest.json', bytes: 0 }],
  };
  writeFileSync(`${outDir}/preview-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  return publish;
}

// ───────────────────────── fotos propias ─────────────────────────

/** Miniaturas del catálogo (480×360, WebP): se copian a `data/catalog/photos/<sku>.thumb.webp`. */
export const THUMB_SIZE = { width: 480, height: 360 } as const;

export interface PhotoPlan {
  /** Fotos que el simulador sirve (ruta relativa a la página). */
  seeds: { sku: string; url: string; illustrative: boolean }[];
  /** Archivos a copiar a dist-preview/photos. */
  copy: { from: string; to: string; bytes: number }[];
  notes: string[];
}

/**
 * Qué fotos lleva la vista previa. Solo fotos PROPIAS (la página publicada no puede pedir nada a otro
 * servidor, así que no se usa el CDN): por cada SKU del manifiesto, si existe su miniatura local
 * `<sku>.thumb.webp`, la variante sirve `photos/<sku>.thumb.webp`; si no existe, queda sin foto y la app
 * muestra el degradado de su categoría.
 */
export async function planPhotos(opts: {
  skus: Set<string>;
  manifestPath: string;
  photosDir: string;
}): Promise<PhotoPlan> {
  const notes: string[] = [];
  const seeds: PhotoPlan['seeds'] = [];
  const copy: PhotoPlan['copy'] = [];
  if (!existsSync(opts.manifestPath)) {
    notes.push('sin photos.manifest.json: ningún artículo lleva foto');
    return { seeds, copy, notes };
  }
  const manifest = JSON.parse(readFileSync(opts.manifestPath, 'utf8')) as {
    items: { sku: string; illustrative?: boolean; verified?: boolean }[];
  };
  let unverified = 0;
  const missing: string[] = [];
  const odd: string[] = [];
  const unreadable: string[] = [];
  for (const m of manifest.items) {
    if (!opts.skus.has(m.sku)) continue;
    if (m.verified === false) {
      unverified++;
      continue;
    }
    const file = `${opts.photosDir}/${m.sku}.thumb.webp`;
    if (!existsSync(file)) {
      missing.push(m.sku);
      continue;
    }
    try {
      const meta = await sharp(file).metadata();
      if (meta.format !== 'webp') throw new Error(`no es WebP (${meta.format ?? 'desconocido'})`);
      if (meta.width !== THUMB_SIZE.width || meta.height !== THUMB_SIZE.height)
        odd.push(`${m.sku} ${meta.width}×${meta.height}`);
    } catch (e) {
      unreadable.push(`${m.sku} (${(e as Error).message})`);
      continue;
    }
    seeds.push({
      sku: m.sku,
      url: `photos/${m.sku}.thumb.webp`,
      illustrative: m.illustrative !== false,
    });
    copy.push({ from: file, to: `photos/${m.sku}.thumb.webp`, bytes: statSync(file).size });
  }
  if (unverified > 0) notes.push(`${unverified} fotos sin verificar omitidas`);
  if (unreadable.length > 0)
    notes.push(`miniaturas que no se pudieron leer (quedan sin foto): ${unreadable.join(', ')}`);
  if (missing.length > 0)
    notes.push(
      `${missing.length} artículos sin miniatura local (se ven con el degradado de su categoría): ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`,
    );
  if (odd.length > 0)
    notes.push(`miniaturas que no miden ${THUMB_SIZE.width}×${THUMB_SIZE.height}: ${odd.slice(0, 4).join(', ')}`);
  return { seeds, copy, notes };
}

// ───────────────────────── datos embebidos ─────────────────────────

/**
 * Columnas del CSV del catálogo que son del NEGOCIO y no tienen por qué viajar dentro de la página (aunque
 * hoy vengan vacías): el costo y las notas de cómo se fijó el precio. El repositorio es público y la
 * página se comparte: lo interno no se embebe.
 */
export const INTERNAL_CSV_COLUMNS = ['costo', 'notas_precio'] as const;

/** El CSV del catálogo sin las columnas internas (se conservan las columnas, vacías: el formato no cambia). */
export function sanitizeCatalogCsv(csv: string): string {
  const rows = parseCsv(csv, detectDelimiter(csv));
  const header = rows[0];
  if (!header) return csv;
  const internal = new Set(
    header.flatMap((h, i) => ((INTERNAL_CSV_COLUMNS as readonly string[]).includes(normalizeHeader(h)) ? [i] : [])),
  );
  return toCsv(rows.map((r, n) => (n === 0 ? r : r.map((cell, i) => (internal.has(i) ? '' : cell)))));
}
