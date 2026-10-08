/**
 * Vista previa web de la app del cliente: la MISMA app (Expo exportada a web) corriendo 100 % en el
 * navegador del teléfono, con un servidor de demostración dentro de la página (sin red hacia
 * ningún backend). Se publica como página estática; este script solo la arma en `dist-preview/`.
 *
 *   npm run preview:build                  → dist-preview/ (≈ 3 MB, ~100 archivos con las 38 fotos)
 *   npm run preview:build -- --skip-export → reutiliza la última exportación de Expo (más rápido)
 *   npm run preview:build -- --out ruta    → otra carpeta de salida
 *   npm run preview:build -- --photos ruta → otra carpeta con las miniaturas <sku>.thumb.webp
 *
 * Pasos: (1) datos del catálogo y fotos propias para el simulador · (2) `expo export --platform web` con
 * EXPO_PUBLIC_API_URL=https://demo.jellyfish.local y EXPO_PUBLIC_DEMO=1 · (3) simulador empaquetado
 * con esbuild · (4) parches al bundle (rutas de archivos y base del router en tiempo de ejecución) ·
 * (5) artifact.html (el FRAGMENTO que se publica) + index.html (documento completo para probar en local)
 * · (6) publish-files.json: el mapa exacto de archivos para la herramienta de publicación, con los
 * límites (≤ 255 archivos, ≤ 16 MB por archivo, ≤ 64 MB por publicación) verificados.
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
import { type Plugin, build as esbuild } from 'esbuild';
import sharp from 'sharp';
import {
  LIMITS,
  type PhotoPlan,
  type PublishFiles,
  planPhotos,
  sanitizeCatalogCsv,
  walk,
  writePublishManifests,
} from './preview-publish';
import {
  DEMO_BASE_URL,
  type FontUsage,
  fragmentProblems,
  iconFamilyOfFile,
  iconNamesIn,
  keepAssetFile,
  patchAppBundle,
  publishedAssetPath,
  renderFragment,
  renderIndexHtml,
  scanFontUsage,
} from './preview-shell';

const root = resolve(import.meta.dirname, '..');
const customerDir = `${root}/apps/customer`;
const catalogDir = `${root}/data/catalog`;

const log = (m: string) => console.log(`• ${m}`);
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', fail);
    p.on('exit', (code) => {
      if (code === 0) ok();
      else
        fail(
          new Error(
            `${cmd} ${args.join(' ')} falló (${code}):\n${out.split('\n').slice(-25).join('\n')}`,
          ),
        );
    });
  });
}

// ───────────────────────── 1. datos del catálogo y fotos propias ─────────────────────────

interface DemoData {
  baseUrl: string;
  catalogCsv: string;
  categories: unknown[];
  photos: { sku: string; url: string; illustrative: boolean }[];
  buildId: string;
}

const PHOTOS_DIR = `${catalogDir}/photos`;

async function readCatalogData(
  photosDir: string,
): Promise<{ data: Omit<DemoData, 'buildId'>; notes: string[]; copy: PhotoPlan['copy'] }> {
  const rawCsv = readFileSync(`${catalogDir}/products.seed.csv`, 'utf8');
  const categories = JSON.parse(readFileSync(`${catalogDir}/categories.json`, 'utf8')) as {
    slug: string;
  }[];
  // Lo interno del negocio (costo, notas de cómo se fijó el precio) no viaja dentro de la página.
  const catalogCsv = sanitizeCatalogCsv(rawCsv);
  const parsed = parseCatalogCsv(catalogCsv, { categories: categories.map((c) => c.slug) });
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0]!;
    throw new Error(`products.seed.csv no es válido (fila ${e.line}, ${e.field}): ${e.message}`);
  }
  const plan = await planPhotos({
    skus: new Set(parsed.items.map((i) => i.sku)),
    manifestPath: `${catalogDir}/photos.manifest.json`,
    photosDir,
  });
  return {
    data: { baseUrl: DEMO_BASE_URL, catalogCsv, categories, photos: plan.seeds },
    notes: plan.notes,
    copy: plan.copy,
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

/**
 * Los paquetes del monorepo (`@jellyfish/shared`, `@jellyfish/catalog`) exportan mucho más de lo que
 * el simulador usa (lector de Excel, manifiesto de fotos con zod, textos legales…). Se marcan sin
 * efectos secundarios para que el empaquetador deje fuera lo que nadie importa.
 */
const workspaceSideEffectFree: Plugin = {
  name: 'workspace-side-effect-free',
  setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.skip) return undefined;
      const resolved = await build.resolve(args.path, {
        importer: args.importer,
        kind: args.kind,
        namespace: args.namespace,
        resolveDir: args.resolveDir,
        pluginData: { skip: true },
      });
      if (resolved.errors.length > 0) return resolved;
      if (/\/packages\/(shared|catalog)\/src\//.test(resolved.path)) {
        return { ...resolved, sideEffects: false };
      }
      return resolved;
    });
  },
};

async function bundleSimulator(): Promise<string> {
  const result = await esbuild({
    plugins: [workspaceSideEffectFree],
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

/** Archivo de glifos (nombre → punto de código) de una familia de @expo/vector-icons. */
function glyphMapFor(family: string): Record<string, number> | null {
  const base = `${root}/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps`;
  for (const name of [`${family}Free.json`, `${family}.json`]) {
    if (existsSync(`${base}/${name}`))
      return JSON.parse(readFileSync(`${base}/${name}`, 'utf8')) as Record<string, number>;
  }
  return null;
}

/**
 * Recorta las fuentes de íconos a los glifos que el código usa (MaterialCommunityIcons pesa 1.3 MB y
 * la app usa unas decenas de íconos). Si `subset-font` no está instalado o algo falla, se deja la
 * fuente completa: es más pesada, nunca incorrecta.
 */
async function subsetIconFonts(
  outDir: string,
): Promise<{ notes: string[]; renames: Map<string, string> }> {
  const notes: string[] = [];
  const renames = new Map<string, string>();
  let subsetFont: (
    font: Buffer,
    text: string,
    options: { targetFormat: 'truetype' },
  ) => Promise<Buffer>;
  try {
    // Nombre en una variable: `subset-font` no trae tipos y así el verificador de TypeScript no se queja.
    const moduleName = 'subset-font';
    subsetFont = ((await import(moduleName)) as { default: typeof subsetFont }).default;
  } catch {
    notes.push(
      'subset-font no está instalado: las fuentes de íconos se publican completas (≈ 1.7 MB más)',
    );
    return { notes, renames };
  }
  const sources = sourcesForFontScan();
  for (const file of walk(`${outDir}/assets`).filter((f) => f.endsWith('.ttf'))) {
    const rel = relative(outDir, file).split('\\').join('/');
    const family = iconFamilyOfFile(rel);
    if (!family) continue;
    const map = glyphMapFor(family);
    if (!map) continue;
    const names = iconNamesIn(sources, Object.keys(map));
    if (names.size < 3) {
      notes.push(
        `${family}: casi no se encontraron íconos en el código (${names.size}); se deja la fuente completa`,
      );
      continue;
    }
    const before = statSync(file).size;
    try {
      const text = [...names].map((n) => String.fromCodePoint(map[n]!)).join('');
      const out = await subsetFont(readFileSync(file), text, { targetFormat: 'truetype' });
      // El archivo cambia de contenido: también de nombre (hash nuevo), para que ninguna caché sirva uno viejo.
      const oldName = file.slice(file.lastIndexOf('/') + 1);
      const newName = `${oldName.replace(/\.[0-9a-f]{32}\.ttf$/, '').replace(/\.ttf$/, '')}.${sha(out).slice(0, 32)}.ttf`;
      rmSync(file);
      writeFileSync(`${file.slice(0, file.lastIndexOf('/') + 1)}${newName}`, out);
      renames.set(oldName, newName);
      notes.push(
        `${family}: ${names.size} íconos, ${(before / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB`,
      );
    } catch (e) {
      notes.push(`${family}: no se pudo recortar (${(e as Error).message}); se deja completa`);
    }
  }
  return { notes, renames };
}

/** Íconos del index.html completo (pestaña del navegador y "agregar a inicio" del teléfono). La vista previa NO es instalable. */
async function makeIcons(outDir: string): Promise<void> {
  const icon = `${customerDir}/assets/icon.png`;
  mkdirSync(`${outDir}/icons`, { recursive: true });
  const png = (size: number) => sharp(icon).resize(size, size).png({ compressionLevel: 9 });
  await png(180).toFile(`${outDir}/icons/apple-touch-icon.png`);
  await png(32).toFile(`${outDir}/icons/favicon-32.png`);
}

export interface BuildOptions {
  out: string;
  skipExport: boolean;
  /** Carpeta con las miniaturas `<sku>.thumb.webp` (por defecto data/catalog/photos). */
  photos?: string;
}

export async function buildPreview(options: BuildOptions): Promise<PublishFiles> {
  const outDir = resolve(options.out);
  const work = mkdtempSync(join(tmpdir(), 'jf-preview-'));
  const exportDir = process.env.PREVIEW_EXPORT_DIR
    ? resolve(process.env.PREVIEW_EXPORT_DIR)
    : `${work}/expo`;
  try {
    log('Datos del catálogo y fotos propias para el simulador…');
    const photosDir = resolve(options.photos ?? process.env.PREVIEW_PHOTOS_DIR ?? PHOTOS_DIR);
    const { data, notes, copy: photoCopy } = await readCatalogData(photosDir);
    log(`  ${data.photos.length} fotos locales${notes.length ? ` · ${notes.join(' · ')}` : ''}`);

    if (options.skipExport && existsSync(exportDir)) {
      log(`Reutilizando la exportación de Expo en ${exportDir}`);
    } else {
      log('Exportando la app del cliente a web (expo export)…');
      await exportExpo(exportDir);
    }

    const entryRel = walk(`${exportDir}/_expo/static/js/web`)
      .map((f) => relative(exportDir, f).split('\\').join('/'))
      .find((f) => /entry-.*\.js$/.test(f));
    if (!entryRel)
      throw new Error('La exportación de Expo no produjo el bundle de la app (entry-*.js).');

    log('Empaquetando el servidor de demostración (esbuild)…');
    const demoJs = await bundleSimulator();

    log(
      'Parcheando el bundle de la app (rutas de archivos y base del router en tiempo de ejecución)…',
    );
    const patched = patchAppBundle(readFileSync(`${exportDir}/${entryRel}`, 'utf8'));
    log(
      `  assets ${patched.report.assets} · stripBaseUrl ${patched.report.stripBaseUrl} · ` +
        `concessions ${patched.report.concessions} · appendBaseUrl ${patched.report.appendBaseUrl}`,
    );
    if (/EXPO_PUBLIC_DEMO|demo\.jellyfish\.local/.test(patched.js) === false) {
      throw new Error(
        'El bundle no trae la URL de demostración: ¿se exportó sin EXPO_PUBLIC_API_URL?',
      );
    }

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(`${outDir}/js`, { recursive: true });

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
      log(
        `  en uso: ${[...usage.googleFonts].sort().join(', ')} · íconos ${[...usage.iconFamilies].sort().join(', ')}`,
      );
    }

    // Íconos: solo los glifos usados. Los archivos recortados cambian de nombre y el bundle los sigue.
    const fonts = await subsetIconFonts(outDir);
    for (const n of fonts.notes) log(`  ${n}`);
    notes.push(...fonts.notes);
    let appJs = patched.js;
    for (const [oldName, newName] of fonts.renames) appJs = appJs.split(oldName).join(newName);

    // Nombres de publicación sin "__node_modules" ni "@": assets/fonts/… y assets/img/….
    const taken = new Map<string, string>();
    let renamed = 0;
    let unreferenced = 0;
    for (const f of walk(`${outDir}/assets`)) {
      const rel = relative(outDir, f).split('\\').join('/');
      const pub = publishedAssetPath(rel);
      const clash = taken.get(pub);
      if (clash && clash !== rel)
        throw new Error(`Dos assets compiten por el nombre ${pub}: ${clash} y ${rel}`);
      taken.set(pub, rel);
      if (pub === rel) continue;
      mkdirSync(dirname(`${outDir}/${pub}`), { recursive: true });
      cpSync(f, `${outDir}/${pub}`);
      rmSync(f);
      const before = appJs;
      appJs = appJs.split(`"/${rel}"`).join(`"/${pub}"`);
      if (appJs === before) {
        // Nadie lo pide (p. ej. las variantes @2x/@3x que Metro copia y la web no usa): no se publica.
        rmSync(`${outDir}/${pub}`);
        unreferenced++;
        continue;
      }
      renamed++;
    }
    // Carpetas vacías que dejó el movimiento.
    pruneEmptyDirs(`${outDir}/assets`);
    // El bundle sigue nombrando las fuentes que se descartaron por no usarse: nadie las pide, no se publican.
    log(
      `  ${renamed} assets con nombre de publicación limpio (assets/fonts, assets/img)` +
        (unreferenced ? ` · ${unreferenced} sin referencias en la app, no se publican` : ''),
    );

    // Fotos propias: <sku>.thumb.webp → photos/ (la única fuente de fotos de la página).
    if (photoCopy.length > 0) mkdirSync(`${outDir}/photos`, { recursive: true });
    for (const c of photoCopy) cpSync(c.from, `${outDir}/${c.to}`);
    if (photoCopy.length > 0) {
      const bytes = photoCopy.reduce((a, c) => a + c.bytes, 0);
      log(
        `Fotos: ${photoCopy.length} miniaturas copiadas a photos/ (${(bytes / 1024).toFixed(0)} KB)`,
      );
    }

    const buildId = sha(
      `${appJs}\n${demoJs}\n${data.catalogCsv}\n${JSON.stringify(data.photos)}\n${photoCopy
        .map((c) => `${c.to}:${sha(readFileSync(c.from)).slice(0, 8)}`)
        .join(',')}`,
    ).slice(0, 10);
    const dataJs = `window.__JF_DEMO_DATA__=${JSON.stringify({ ...data, buildId })};\n`;
    const files = {
      data: `js/demo-data.${buildId}.js`,
      demo: `js/demo.${buildId}.js`,
      app: `js/app.${buildId}.js`,
    };
    writeFileSync(`${outDir}/${files.data}`, dataJs);
    writeFileSync(`${outDir}/${files.demo}`, demoJs);
    writeFileSync(`${outDir}/${files.app}`, appJs);

    // La página: el fragmento (lo que se publica) y el documento completo (para probar en local).
    const fragment = renderFragment({ buildId, files });
    const broken = fragmentProblems(fragment);
    if (broken.length > 0)
      throw new Error(
        `artifact.html no cumple el formato de página publicada:\n- ${broken.join('\n- ')}`,
      );
    writeFileSync(`${outDir}/artifact.html`, fragment);
    writeFileSync(`${outDir}/index.html`, renderIndexHtml({ buildId, files }));
    writeFileSync(`${outDir}/jf-probe.json`, `${JSON.stringify({ jf: buildId })}\n`);
    if (existsSync(`${exportDir}/favicon.ico`))
      cpSync(`${exportDir}/favicon.ico`, `${outDir}/favicon.ico`);
    await makeIcons(outDir);

    return writePublishManifests(outDir, buildId, notes);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Borra las carpetas que quedaron vacías (de abajo hacia arriba). */
function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: `${root}/dist-preview` },
      photos: { type: 'string' },
      'skip-export': { type: 'boolean', default: false },
    },
  });
  const t0 = Date.now();
  const publish = await buildPreview({
    out: values.out!,
    skipExport: values['skip-export'] === true,
    ...(values.photos ? { photos: values.photos } : {}),
  });
  const mb = (n: number) => `${(n / 1048576).toFixed(2)} MB`;
  console.log(
    `\n✔ Vista previa lista en ${relative(root, resolve(values.out!)) || '.'} (${((Date.now() - t0) / 1000).toFixed(0)} s)\n` +
      `  Página: artifact.html (fragmento) + ${publish.attachmentCount} archivos adjuntos · ${mb(publish.totalBytes)} en total · el más grande: ` +
      `${publish.largestFile.path} (${mb(publish.largestFile.bytes)})\n` +
      `  Límites de publicación: ≤ ${LIMITS.maxFiles} archivos, ≤ 16 MB por archivo de texto (15 MB por binario), ≤ 64 MB en total → ` +
      `${publish.withinLimits ? 'dentro de los límites' : publish.parts ? `NO cabe en una publicación: ${publish.parts.length} mapas en publish-files.json` : 'EXCEDE LOS LÍMITES'}\n` +
      '  Mapa para la herramienta de publicación: dist-preview/publish-files.json  (clave "files"; el archivo principal es "main")\n' +
      '  Para verla en tu computadora: npx tsx scripts/e2e-preview.ts --serve\n',
  );
  if (!publish.withinLimits && !publish.parts) process.exitCode = 1;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('build-preview.ts')
) {
  main().catch((e) => {
    console.error(`\n✖ ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
