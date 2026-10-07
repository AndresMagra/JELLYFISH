/**
 * Vista previa web de la app del cliente: la MISMA app (Expo exportada a web) corriendo 100 % en el
 * navegador del teléfono, con un servidor de demostración dentro de la página (sin red hacia
 * ningún backend). Se publica como página estática; este script solo la arma en `dist-preview/`.
 *
 *   npm run preview:build                 → dist-preview/ (≈ 6 MB, ~45 archivos)
 *   npm run preview:build -- --skip-export → reutiliza la última exportación de Expo (más rápido)
 *   npm run preview:build -- --out ruta    → otra carpeta de salida
 *
 * Pasos: (1) datos del catálogo para el simulador · (2) `expo export --platform web` con
 * EXPO_PUBLIC_API_URL=https://demo.jellyfish.local y EXPO_PUBLIC_DEMO=1 · (3) simulador empaquetado
 * con esbuild · (4) parches al bundle (rutas relativas, base del router en tiempo de ejecución) ·
 * (5) index.html con cinta "VISTA PREVIA", PWA y arranque · (6) manifiesto de archivos y límites.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCatalogCsv } from '@jellyfish/catalog';
import { build as esbuild } from 'esbuild';
import sharp from 'sharp';
import {
  DEMO_BASE_URL,
  type FontUsage,
  keepAssetFile,
  patchAppBundle,
  renderIndexHtml,
  renderServiceWorker,
  renderWebManifest,
  scanFontUsage,
} from './preview-shell';

const root = resolve(import.meta.dirname, '..');
const customerDir = `${root}/apps/customer`;
const catalogDir = `${root}/data/catalog`;

/** Límites de publicación de una página privada. */
export const LIMITS = { maxFiles: 255, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };

const log = (m: string) => console.log(`• ${m}`);
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', fail);
    p.on('exit', (code) => {
      if (code === 0) ok();
      else fail(new Error(`${cmd} ${args.join(' ')} falló (${code}):\n${out.split('\n').slice(-25).join('\n')}`));
    });
  });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// ───────────────────────── 1. datos del catálogo ─────────────────────────

interface DemoData {
  baseUrl: string;
  catalogCsv: string;
  categories: unknown[];
  photos: { sku: string; url: string; illustrative: boolean }[];
  buildId: string;
}

function readCatalogData(): { data: Omit<DemoData, 'buildId'>; notes: string[] } {
  const catalogCsv = readFileSync(`${catalogDir}/products.seed.csv`, 'utf8');
  const categories = JSON.parse(readFileSync(`${catalogDir}/categories.json`, 'utf8')) as {
    slug: string;
  }[];
  const parsed = parseCatalogCsv(catalogCsv, { categories: categories.map((c) => c.slug) });
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0]!;
    throw new Error(`products.seed.csv no es válido (fila ${e.line}, ${e.field}): ${e.message}`);
  }
  const notes: string[] = [];
  const skus = new Set(parsed.items.map((i) => i.sku));

  const photos: DemoData['photos'] = [];
  const manifestPath = `${catalogDir}/photos.manifest.json`;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      items: { sku: string; rawUrl: string; minUrl: string; illustrative: boolean; verified: boolean }[];
    };
    let skipped = 0;
    for (const m of manifest.items) {
      if (!skus.has(m.sku)) continue;
      if (m.verified === false) {
        skipped++;
        continue;
      }
      // La variante liviana para listas y tarjetas; si falta, la imagen completa.
      photos.push({ sku: m.sku, url: m.minUrl || m.rawUrl, illustrative: m.illustrative !== false });
    }
    if (skipped > 0) notes.push(`${skipped} fotos sin verificar omitidas`);
  } else {
    notes.push('sin photos.manifest.json: se usa la columna foto del CSV');
  }
  const withoutPhoto = parsed.items.filter((i) => !photos.some((p) => p.sku === i.sku) && !i.photo);
  if (withoutPhoto.length > 0) notes.push(`${withoutPhoto.length} artículos sin foto (se verán con su ícono)`);
  return {
    data: { baseUrl: DEMO_BASE_URL, catalogCsv, categories, photos },
    notes,
  };
}

// ───────────────────────── 2. exportación de Expo ─────────────────────────

async function exportExpo(outDir: string): Promise<void> {
  await run(
    'npx',
    ['expo', 'export', '--platform', 'web', '--clear', '--output-dir', outDir],
    customerDir,
    {
      EXPO_PUBLIC_API_URL: DEMO_BASE_URL,
      EXPO_PUBLIC_DEMO: '1',
      EXPO_NO_TELEMETRY: '1',
      CI: '1',
    },
  );
}

// ───────────────────────── 3. simulador ─────────────────────────

async function bundleSimulator(): Promise<string> {
  const result = await esbuild({
    entryPoints: [`${root}/packages/demo-backend/src/browser.ts`],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return result.outputFiles[0]!.text;
}

// ───────────────────────── 4-5. ensamblado ─────────────────────────

function sourcesForFontScan(): string[] {
  const roots = [`${customerDir}/app`, `${customerDir}/src`, `${root}/packages/mobile-core/src`];
  const out: string[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const f of walk(r)) if (/\.(ts|tsx)$/.test(f)) out.push(readFileSync(f, 'utf8'));
  }
  return out;
}

async function makeIcons(outDir: string): Promise<void> {
  const icon = `${customerDir}/assets/icon.png`;
  mkdirSync(`${outDir}/icons`, { recursive: true });
  const png = (size: number) => sharp(icon).resize(size, size).png({ compressionLevel: 9 });
  await png(192).toFile(`${outDir}/icons/icon-192.png`);
  await png(512).toFile(`${outDir}/icons/icon-512.png`);
  // El dibujo ya cabe en el 80 % central: sirve tal cual como ícono "maskable" de Android.
  await png(512).toFile(`${outDir}/icons/icon-maskable-512.png`);
  await png(180).toFile(`${outDir}/icons/apple-touch-icon.png`);
  await png(32).toFile(`${outDir}/icons/favicon-32.png`);
}

export interface FileEntry {
  path: string;
  bytes: number;
}

export interface PreviewManifest {
  buildId: string;
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  largestFile: FileEntry;
  limits: typeof LIMITS;
  withinLimits: boolean;
  notes: string[];
  files: FileEntry[];
}

function listFiles(outDir: string): FileEntry[] {
  return walk(outDir)
    .map((f) => ({ path: relative(outDir, f).split('\\').join('/'), bytes: statSync(f).size }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Escribe preview-manifest.json contándose a sí mismo (punto fijo: su tamaño no cambia el conteo). */
function writeManifest(outDir: string, buildId: string, notes: string[]): PreviewManifest {
  const target = `${outDir}/preview-manifest.json`;
  let size = 0;
  let manifest!: PreviewManifest;
  for (let i = 0; i < 4; i++) {
    const others = listFiles(outDir).filter((f) => f.path !== 'preview-manifest.json');
    const files = [...others, { path: 'preview-manifest.json', bytes: size }].sort((a, b) =>
      a.path < b.path ? -1 : 1,
    );
    const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
    const largestFile = files.reduce((m, f) => (f.bytes > m.bytes ? f : m), files[0]!);
    manifest = {
      buildId,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      totalBytes,
      largestFile,
      limits: LIMITS,
      withinLimits:
        files.length <= LIMITS.maxFiles &&
        largestFile.bytes <= LIMITS.maxFileBytes &&
        totalBytes <= LIMITS.maxTotalBytes,
      notes,
      files,
    };
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(target, text);
    const actual = Buffer.byteLength(text);
    if (actual === size) break;
    size = actual;
  }
  return manifest;
}

export interface BuildOptions {
  out: string;
  skipExport: boolean;
}

export async function buildPreview(options: BuildOptions): Promise<PreviewManifest> {
  const outDir = resolve(options.out);
  const work = mkdtempSync(join(tmpdir(), 'jf-preview-'));
  const exportDir = process.env.PREVIEW_EXPORT_DIR
    ? resolve(process.env.PREVIEW_EXPORT_DIR)
    : `${work}/expo`;
  try {
    log('Datos del catálogo para el simulador…');
    const { data, notes } = readCatalogData();
    log(`  ${data.photos.length} fotos del manifiesto${notes.length ? ` · ${notes.join(' · ')}` : ''}`);

    if (options.skipExport && existsSync(exportDir)) {
      log(`Reutilizando la exportación de Expo en ${exportDir}`);
    } else {
      log('Exportando la app del cliente a web (expo export)…');
      await exportExpo(exportDir);
    }

    const entryRel = walk(`${exportDir}/_expo/static/js/web`)
      .map((f) => relative(exportDir, f).split('\\').join('/'))
      .find((f) => /entry-.*\.js$/.test(f));
    if (!entryRel) throw new Error('La exportación de Expo no produjo el bundle de la app (entry-*.js).');

    log('Empaquetando el servidor de demostración (esbuild)…');
    const demoJs = await bundleSimulator();

    log('Parcheando el bundle de la app (rutas relativas y base del router)…');
    const patched = patchAppBundle(readFileSync(`${exportDir}/${entryRel}`, 'utf8'));
    log(
      `  assets ${patched.report.assets} · stripBaseUrl ${patched.report.stripBaseUrl} · ` +
        `concessions ${patched.report.concessions} · appendBaseUrl ${patched.report.appendBaseUrl}`,
    );
    if (/EXPO_PUBLIC_DEMO|demo\.jellyfish\.local/.test(patched.js) === false) {
      throw new Error('El bundle no trae la URL de demostración: ¿se exportó sin EXPO_PUBLIC_API_URL?');
    }

    const buildId = sha(`${patched.js}\n${demoJs}\n${data.catalogCsv}\n${JSON.stringify(data.photos)}`).slice(0, 10);
    const dataJs = `window.__JF_DEMO_DATA__=${JSON.stringify({ ...data, buildId })};\n`;

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(`${outDir}/js`, { recursive: true });
    const files = {
      data: `js/demo-data.${buildId}.js`,
      demo: `js/demo.${buildId}.js`,
      app: `js/app.${buildId}.js`,
    };
    writeFileSync(`${outDir}/${files.data}`, dataJs);
    writeFileSync(`${outDir}/${files.demo}`, demoJs);
    writeFileSync(`${outDir}/${files.app}`, patched.js);

    // Assets de Expo (fuentes, imágenes): solo las fuentes que el código usa de verdad.
    const usage: FontUsage = scanFontUsage(sourcesForFontScan());
    let kept = 0;
    let dropped = 0;
    let droppedBytes = 0;
    if (existsSync(`${exportDir}/assets`)) {
      for (const f of walk(`${exportDir}/assets`)) {
        const rel = relative(exportDir, f).split('\\').join('/');
        if (!keepAssetFile(rel, usage)) {
          dropped++;
          droppedBytes += statSync(f).size;
          continue;
        }
        mkdirSync(dirname(`${outDir}/${rel}`), { recursive: true });
        cpSync(f, `${outDir}/${rel}`);
        kept++;
      }
    }
    log(
      `Fuentes e imágenes: ${kept} archivos publicados, ${dropped} sin usar descartados ` +
        `(${(droppedBytes / 1048576).toFixed(1)} MB)`,
    );
    if (usage.googleFonts.size + usage.iconFamilies.size > 0) {
      log(`  en uso: ${[...usage.googleFonts].sort().join(', ')} · íconos ${[...usage.iconFamilies].sort().join(', ')}`);
    }

    writeFileSync(`${outDir}/index.html`, renderIndexHtml({ buildId, files }));
    writeFileSync(`${outDir}/manifest.webmanifest`, renderWebManifest());
    writeFileSync(`${outDir}/sw.js`, renderServiceWorker());
    writeFileSync(`${outDir}/jf-probe.json`, `${JSON.stringify({ jf: buildId })}\n`);
    if (existsSync(`${exportDir}/favicon.ico`)) cpSync(`${exportDir}/favicon.ico`, `${outDir}/favicon.ico`);
    await makeIcons(outDir);

    const manifest = writeManifest(outDir, buildId, notes);
    return manifest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: `${root}/dist-preview` },
      'skip-export': { type: 'boolean', default: false },
    },
  });
  const t0 = Date.now();
  const manifest = await buildPreview({ out: values.out!, skipExport: values['skip-export'] === true });
  const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
  console.log(
    `\n✔ Vista previa lista en ${relative(root, resolve(values.out!)) || '.'} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n` +
      `  ${manifest.fileCount} archivos · ${mb(manifest.totalBytes)} en total · el más grande: ` +
      `${manifest.largestFile.path} (${mb(manifest.largestFile.bytes)})\n` +
      `  Límites de publicación: ≤ ${LIMITS.maxFiles} archivos, ≤ 16 MB por archivo, ≤ 64 MB en total → ` +
      `${manifest.withinLimits ? 'dentro de los límites' : 'EXCEDE LOS LÍMITES'}\n` +
      '  Para verla en tu computadora: npx tsx scripts/e2e-preview.ts --serve   (o publica la carpeta completa)\n',
  );
  if (!manifest.withinLimits) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-preview.ts')) {
  main().catch((e) => {
    console.error(`\n✖ ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
