import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCatalogCsv, parseCsv } from '@jellyfish/catalog';
import * as publish from '../../../scripts/preview-publish';
import { cleanMutants, expectKilled, expectKilledAsync, loadMutant } from './mutation-lib';

type Api = typeof publish;
const MB = 1024 * 1024;
const f = (path: string, bytes = 1000): publish.FileEntry => ({ path, bytes });
const many = (n: number, bytes = 1000) =>
  Array.from({ length: n }, (_, i) => f(`photos/p${i}.webp`, bytes));

function limitsSuite(api: Api): void {
  const main = f('artifact.html', 5000);
  // Dentro de los límites: exactamente 255 archivos en total (el principal cuenta) y 64 MB.
  const ok = api.checkLimits(main, many(254));
  expect(ok.withinLimits).toBe(true);
  expect(ok.fileCount).toBe(255);
  expect(ok.totalBytes).toBe(5000 + 254 * 1000);
  expect(ok.largestFile.path).toBe('artifact.html');
  // Uno más: ya no cabe.
  const tooMany = api.checkLimits(main, many(255));
  expect(tooMany.withinLimits).toBe(false);
  expect(tooMany.problems.join(' ')).toMatch(/256 archivos.*255/);
  // Un archivo de texto pasa de 16 MB; uno binario, de 15 MB.
  expect(api.checkLimits(main, [f('js/app.js', 16 * MB)]).withinLimits).toBe(true);
  expect(api.checkLimits(main, [f('js/app.js', 16 * MB + 1)]).problems.join(' ')).toMatch(
    /js\/app\.js pesa 16\.0 MB.*16\.0 MB/,
  );
  expect(api.checkLimits(main, [f('assets/fonts/a.ttf', 15 * MB)]).withinLimits).toBe(true);
  expect(api.checkLimits(main, [f('assets/fonts/a.ttf', 15 * MB + 1)]).withinLimits).toBe(false);
  expect(api.checkLimits(f('artifact.html', 16 * MB + 1), []).withinLimits).toBe(false); // el principal también
  // 64 MB en total por publicación.
  const exact = [
    f('js/g0.js', 16 * MB),
    f('js/g1.js', 16 * MB),
    f('js/g2.js', 16 * MB),
    f('js/g3.js', 16 * MB - 5000),
  ];
  expect(api.checkLimits(main, exact).totalBytes).toBe(64 * MB);
  expect(api.checkLimits(main, exact).withinLimits).toBe(true); // justo 64 MB: cabe
  const big = Array.from({ length: 4 }, (_, i) => f(`js/g${i}.js`, 16 * MB - 2000));
  expect(api.checkLimits(main, big).withinLimits).toBe(true);
  expect(api.checkLimits(main, [...big, f('photos/x.webp', 6000)]).withinLimits).toBe(false);
  expect(api.checkLimits(main, [...big, f('photos/x.webp', 6000)]).problems.join(' ')).toMatch(
    /en total/,
  );
  // El mayor archivo es el mayor.
  expect(api.checkLimits(main, [f('a.js', 10), f('b.js', 99_999)]).largestFile.path).toBe('b.js');
  // Rutas publicadas: relativas, sin salirse y con caracteres sanos.
  for (const bad of [
    '/js/a.js',
    '../a.js',
    'js/../a.js',
    'js//a.js',
    'js\\a.js',
    'js/a b.js',
    'js/ñ.js',
    'js/a.js?x=1',
    './a.js',
    '',
  ]) {
    expect(api.publishedPathProblem(bad), `"${bad}"`).not.toBeNull();
    expect(api.checkLimits(main, [f(bad)]).withinLimits, `"${bad}"`).toBe(false);
  }
  for (const good of [
    'js/app.c24763.js',
    'assets/fonts/Sora_700Bold.8569cb.ttf',
    'photos/JF-MAR-002.thumb.webp',
    'jf-probe.json',
  ])
    expect(api.publishedPathProblem(good), good).toBeNull();
}

function splitSuite(api: Api): void {
  const main = f('artifact.html', 5000);
  // Lo normal: un solo grupo, todo junto y ordenado.
  const one = api.splitForPublishing(main, [f('b.js'), f('a.js')]);
  expect(one).toHaveLength(1);
  expect(one[0]!.map((x) => x.path)).toEqual(['a.js', 'b.js']);
  // 300 archivos: el primer grupo lleva el principal (254 adjuntos) y el resto va aparte; nada se pierde ni se repite.
  const att = many(300);
  const groups = api.splitForPublishing(main, att);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toHaveLength(254);
  expect(groups[1]).toHaveLength(46);
  expect(
    groups
      .flat()
      .map((x) => x.path)
      .sort(),
  ).toEqual(att.map((x) => x.path).sort());
  // Por tamaño: tres archivos de 30 MB no caben juntos (64 MB).
  const heavy = [f('a.bin', 30 * MB), f('b.bin', 30 * MB), f('c.bin', 30 * MB)];
  const bySize = api.splitForPublishing(main, heavy);
  expect(bySize).toHaveLength(2);
  for (const g of bySize) expect(g.reduce((a, x) => a + x.bytes, 0)).toBeLessThanOrEqual(64 * MB);
  expect(bySize[0]!.reduce((a, x) => a + x.bytes, main.bytes)).toBeLessThanOrEqual(64 * MB);
}

describe('límites de publicación', () => {
  afterAll(cleanMutants);

  it('≤ 255 archivos (con el principal), ≤ 16 MB de texto / 15 MB binario, ≤ 64 MB, rutas sanas', () =>
    limitsSuite(publish));
  it('si no cabe, se reparte en publicaciones que sí caben', () => splitSuite(publish));

  it('detecta cada mutación de los límites', async () => {
    const file = new URL('../../../scripts/preview-publish.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1], (a: Api) => void][] = [
      [
        '255 archivos ya no caben',
        [['all.length > LIMITS.maxFiles', 'all.length >= LIMITS.maxFiles']],
        limitsSuite,
      ],
      [
        '256 archivos caben',
        [['all.length > LIMITS.maxFiles', 'all.length > LIMITS.maxFiles + 1']],
        limitsSuite,
      ],
      [
        'el principal no cuenta como archivo',
        [['const all = [main, ...attachments];', 'const all = [...attachments];\n  void main;']],
        limitsSuite,
      ],
      [
        'el límite de texto pasa a 15 MB',
        [['maxFileBytes: 16 * 1024 * 1024', 'maxFileBytes: 15 * 1024 * 1024']],
        limitsSuite,
      ],
      [
        'los binarios pasan de 16 MB',
        [['maxBinaryFileBytes: 15 * 1024 * 1024', 'maxBinaryFileBytes: 16 * 1024 * 1024']],
        limitsSuite,
      ],
      [
        'todo se mide con el límite de texto',
        [
          [
            'isTextFile(f.path) ? LIMITS.maxFileBytes : LIMITS.maxBinaryFileBytes',
            'LIMITS.maxFileBytes',
          ],
        ],
        limitsSuite,
      ],
      [
        'el total pasa a 128 MB',
        [['maxTotalBytes: 64 * 1024 * 1024', 'maxTotalBytes: 128 * 1024 * 1024']],
        limitsSuite,
      ],
      [
        'el total se compara con >=',
        [['totalBytes > LIMITS.maxTotalBytes', 'totalBytes >= LIMITS.maxTotalBytes']],
        limitsSuite,
      ],
      [
        'rutas con ".." pasan',
        [["part === '..' || part === '.' || part === ''", "part === '.'"]],
        limitsSuite,
      ],
      [
        'rutas con caracteres raros pasan',
        [[String.raw`/^[A-Za-z0-9._/-]+$/`, String.raw`/^.+$/`]],
        limitsSuite,
      ],
      [
        'el mayor archivo es el primero',
        [['f.bytes > m.bytes ? f : m', 'f.bytes < m.bytes ? f : m']],
        limitsSuite,
      ],
      ['el reparto no cuenta el principal', [['let count = 1;', 'let count = 0;']], splitSuite],
      [
        'el reparto ignora el tamaño',
        [['|| bytes + f.bytes > LIMITS.maxTotalBytes', '']],
        splitSuite,
      ],
      [
        'el reparto pierde un archivo',
        [
          [
            '[...attachments].sort((a, b) => b.bytes - a.bytes)',
            '[...attachments].sort((a, b) => b.bytes - a.bytes).slice(1)',
          ],
        ],
        splitSuite,
      ],
    ];
    for (const [name, edits, suite] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      expectKilled(name, () => suite(mutant));
    }
  });
});

// ───────────────────────── el mapa de publicación ─────────────────────────

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'jf-pub-'));
  dirs.push(d);
  return d;
}

/** Una carpeta de salida mínima: la página, dos archivos que se publican y tres que no. */
function fakeOut(extra: Record<string, number> = {}): string {
  const out = tmp();
  const put = (path: string, bytes: number | string) => {
    mkdirSync(join(out, path, '..'), { recursive: true });
    writeFileSync(join(out, path), typeof bytes === 'string' ? bytes : Buffer.alloc(bytes, 1));
  };
  put('artifact.html', '<title>JELLYFISH</title>');
  put('index.html', '<!doctype html>');
  put('favicon.ico', 10);
  put('icons/apple-touch-icon.png', 10);
  put('js/app.abc.js', 2000);
  put('photos/JF-MAR-001.thumb.webp', 300);
  put('jf-probe.json', '{"jf":"abc"}');
  for (const [p, b] of Object.entries(extra)) put(p, b);
  return out;
}

function manifestSuite(api: Api): void {
  const out = fakeOut();
  const res = api.writePublishManifests(out, 'abc', ['una nota']);
  // El mapa exacto: ruta publicada → ruta local absoluta, sin la página principal ni lo que no se publica.
  expect(Object.keys(res.files).sort()).toEqual([
    'jf-probe.json',
    'js/app.abc.js',
    'photos/JF-MAR-001.thumb.webp',
  ]);
  for (const [published, local] of Object.entries(res.files)) {
    expect(local).toBe(`${out}/${published}`);
    expect(local.startsWith('/')).toBe(true);
  }
  expect(res.main).toBe(`${out}/artifact.html`);
  expect(res.attachmentCount).toBe(3);
  expect(res.fileCount).toBe(4); // con la página
  expect(res.totalBytes).toBe(24 + 2000 + 300 + 12);
  expect(res.largestFile).toEqual({ path: 'js/app.abc.js', bytes: 2000 });
  expect(res.withinLimits).toBe(true);
  expect(res.parts).toBeUndefined();
  // Lo mismo queda escrito en disco, listo para pasar a la herramienta de publicación.
  const onDisk = JSON.parse(readFileSync(`${out}/publish-files.json`, 'utf8')) as typeof res;
  expect(onDisk.files).toEqual(res.files);
  expect(onDisk.limits).toMatchObject({ maxFiles: 255, maxTotalBytes: 64 * MB });
  const manifest = JSON.parse(readFileSync(`${out}/preview-manifest.json`, 'utf8')) as {
    buildId: string;
    notes: string[];
    files: { path: string }[];
  };
  expect(manifest.buildId).toBe('abc');
  expect(manifest.notes).toContain('una nota');
  expect(manifest.files.map((x) => x.path)).toContain('index.html'); // el manifiesto describe TODO, también lo que no se publica
}

describe('mapa de publicación (publish-files.json)', () => {
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    cleanMutants();
  });

  it('lista exactamente los archivos adjuntos, con rutas locales absolutas, cuenta, total y mayor', () =>
    manifestSuite(publish));

  it('si pasa de 255 archivos lo divide en dos mapas y lo dice; si un archivo no cabe, no lo disfraza', () => {
    const out = fakeOut(
      Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`photos/x${i}.webp`, 10])),
    );
    const res = publish.writePublishManifests(out, 'abc', []);
    expect(res.withinLimits).toBe(false);
    expect(res.parts).toHaveLength(2);
    expect(res.parts!.flatMap((p) => Object.keys(p)).sort()).toEqual(Object.keys(res.files).sort());
    expect(res.parts![0]!['jf-probe.json'] ?? res.parts![0]!['js/app.abc.js']).toBeDefined();
    expect(res.notes.join(' ')).toMatch(/NO cabe en una sola publicación.*2 mapas/);
    // Un archivo suelto que no cabe: dividir no lo arregla.
    const huge = fakeOut({ 'js/enorme.js': 16 * MB + 1 });
    const bad = publish.writePublishManifests(huge, 'abc', []);
    expect(bad.withinLimits).toBe(false);
    expect(bad.parts).toBeUndefined();
    expect(bad.notes.join(' ')).toMatch(/EXCEDE LOS LÍMITES.*js\/enorme\.js/);
  });

  it('detecta mutaciones del mapa (la página principal en el mapa, rutas relativas, lo que no se publica)', async () => {
    const file = new URL('../../../scripts/preview-publish.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      ['index.html se publica', [["  'index.html',\n  'favicon.ico',", "  'favicon.ico',"]]],
      ['los íconos de index.html se publican', [["!path.startsWith('icons/')", 'true']]],
      [
        'el mapa trae rutas relativas',
        [
          [
            'const local = (path: string) => `${outDir}/${path}`;',
            'const local = (path: string) => path;',
          ],
        ],
      ],
      [
        'la cuenta no incluye la página',
        [['fileCount: check.fileCount,', 'fileCount: check.fileCount - 1,']],
      ],
      [
        'el mapa incluye la página principal',
        [
          [
            'files: toMap(attachments),',
            "files: toMap([...attachments, { path: 'artifact.html', bytes: 0 }]),",
          ],
        ],
      ],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      expectKilled(name, () => manifestSuite(mutant));
    }
  });
});

// ───────────────────────── fotos propias ─────────────────────────

let photosDir = '';
const manifestFile = () => join(photosDir, 'manifest.json');

async function webp(path: string, w = 480, h = 360): Promise<void> {
  await sharp({ create: { width: w, height: h, channels: 3, background: '#223344' } })
    .webp()
    .toFile(path);
}

async function photoSuite(api: Api): Promise<void> {
  const skus = new Set(['JF-A-001', 'JF-A-002', 'JF-A-003', 'JF-A-004', 'JF-A-005', 'JF-A-006']);
  const plan = await api.planPhotos({ skus, manifestPath: manifestFile(), photosDir });
  // Con archivo, verificada y 480×360: foto propia con ruta RELATIVA photos/<sku>.thumb.webp.
  expect(plan.seeds.map((s) => s.sku).sort()).toEqual(['JF-A-001', 'JF-A-002', 'JF-A-005']);
  expect(plan.seeds.find((s) => s.sku === 'JF-A-001')).toEqual({
    sku: 'JF-A-001',
    url: 'photos/JF-A-001.thumb.webp',
    illustrative: true,
  });
  expect(plan.seeds.find((s) => s.sku === 'JF-A-002')!.illustrative).toBe(false); // foto real del dueño: no se rotula
  // Se copia exactamente lo que se sirve.
  expect(plan.copy.map((c) => c.to).sort()).toEqual(plan.seeds.map((s) => s.url).sort());
  for (const c of plan.copy) expect(c.from).toBe(`${photosDir}/${c.to.replace('photos/', '')}`);
  // Sin archivo → sin foto (y se avisa); sin verificar → fuera; ilegible → fuera y se avisa.
  expect(plan.seeds.find((s) => s.sku === 'JF-A-003')).toBeUndefined();
  expect(plan.seeds.find((s) => s.sku === 'JF-A-004')).toBeUndefined();
  expect(plan.seeds.find((s) => s.sku === 'JF-A-006')).toBeUndefined();
  const notes = plan.notes.join(' | ');
  expect(notes).toMatch(/1 artículos sin miniatura local.*JF-A-003/);
  expect(notes).toMatch(/1 fotos sin verificar omitidas/);
  expect(notes).toMatch(/no se pudieron leer.*JF-A-006/);
  expect(notes).not.toMatch(/leer[^|]*JF-A-003/); // un archivo que falta no es un archivo ilegible
  expect(notes).toMatch(/no miden 480×360.*JF-A-005 100×100/); // se usa igual, pero se anota
  // Un SKU del manifiesto que no está en el catálogo no se publica.
  expect(plan.seeds.find((s) => s.sku === 'JF-ZZZ-999')).toBeUndefined();
  // Sin manifiesto, ningún artículo lleva foto.
  const none = await api.planPhotos({
    skus,
    manifestPath: join(photosDir, 'no-existe.json'),
    photosDir,
  });
  expect(none.seeds).toEqual([]);
  expect(none.notes.join(' ')).toMatch(/sin photos\.manifest\.json/);
}

describe('fotos propias del build', () => {
  beforeAll(async () => {
    photosDir = tmp();
    await webp(join(photosDir, 'JF-A-001.thumb.webp'));
    await webp(join(photosDir, 'JF-A-002.thumb.webp'));
    await webp(join(photosDir, 'JF-A-004.thumb.webp')); // existe pero el manifiesto dice "sin verificar"
    await webp(join(photosDir, 'JF-A-005.thumb.webp'), 100, 100);
    await webp(join(photosDir, 'JF-ZZZ-999.thumb.webp'));
    writeFileSync(join(photosDir, 'JF-A-006.thumb.webp'), 'esto no es una imagen');
    writeFileSync(
      manifestFile(),
      JSON.stringify({
        items: [
          { sku: 'JF-A-001', illustrative: true, verified: true },
          { sku: 'JF-A-002', illustrative: false, verified: true },
          { sku: 'JF-A-003', illustrative: true, verified: true },
          { sku: 'JF-A-004', illustrative: true, verified: false },
          { sku: 'JF-A-005' },
          { sku: 'JF-A-006', verified: true },
          { sku: 'JF-ZZZ-999', verified: true },
        ],
      }),
    );
  });
  afterAll(cleanMutants);

  it('solo miniaturas locales que existen, verificadas y legibles; el resto cae al degradado', () =>
    photoSuite(publish));

  it('detecta mutaciones del plan de fotos', async () => {
    const file = new URL('../../../scripts/preview-publish.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      [
        'usa la foto aunque el archivo no exista',
        [
          [
            'if (!existsSync(file)) {\n      missing.push(m.sku);\n      continue;\n    }',
            'if (!existsSync(file)) {\n      missing.push(m.sku);\n    }',
          ],
        ],
      ],
      ['publica fotos sin verificar', [['if (m.verified === false) {', 'if (false as boolean) {']]],
      [
        'la ruta de la foto es absoluta',
        [['url: `photos/${m.sku}.thumb.webp`,', 'url: `/photos/${m.sku}.thumb.webp`,']],
      ],
      [
        'el nombre de la miniatura cambia',
        [['`${opts.photosDir}/${m.sku}.thumb.webp`', '`${opts.photosDir}/${m.sku}.webp`']],
      ],
      [
        'una foto real se rotula ilustrativa',
        [['illustrative: m.illustrative !== false,', 'illustrative: true,']],
      ],
      [
        'una imagen ilegible se publica',
        [
          [
            '      unreadable.push(`${m.sku} (${(e as Error).message})`);\n      continue;',
            '      void e;',
          ],
        ],
      ],
      [
        'se publican SKU que no están en el catálogo',
        [['if (!opts.skus.has(m.sku)) continue;', '']],
      ],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      await expectKilledAsync(name, () => photoSuite(mutant));
    }
  });
});

// ───────────────────────── datos embebidos ─────────────────────────

describe('datos embebidos en la página', () => {
  afterAll(cleanMutants);
  const root = new URL('../../../data/catalog/', import.meta.url).pathname;
  const csv = readFileSync(`${root}products.seed.csv`, 'utf8');
  const categories = (
    JSON.parse(readFileSync(`${root}categories.json`, 'utf8')) as { slug: string }[]
  ).map((c) => c.slug);

  function csvSuite(api: Api): void {
    const sample =
      'sku,nombre,precio,notas_precio,costo,Costo\nJF-1,Pollo,100,Margen 15%,55,66\nJF-2,"Res, molida",200,"nota ""x""",77,88\n';
    const out = parseCsv(api.sanitizeCatalogCsv(sample));
    expect(out[0]).toEqual(['sku', 'nombre', 'precio', 'notas_precio', 'costo', 'Costo']); // las columnas siguen (el formato no cambia)
    expect(out[1]).toEqual(['JF-1', 'Pollo', '100', '', '', '']);
    expect(out[2]).toEqual(['JF-2', 'Res, molida', '200', '', '', '']);
    // Con punto y coma (Excel en español) también.
    const semi = parseCsv(api.sanitizeCatalogCsv('sku;nombre;costo\nJF-1;Pollo;55\n'));
    expect(semi[1]).toEqual(['JF-1', 'Pollo', '']);
    // Sin columnas internas, no cambia nada de lo que dice.
    expect(parseCsv(api.sanitizeCatalogCsv('sku,nombre\nJF-1,Pollo\n'))).toEqual([
      ['sku', 'nombre'],
      ['JF-1', 'Pollo'],
    ]);
    expect(api.sanitizeCatalogCsv('')).toBe('');
  }

  it('el CSV embebido no lleva el costo ni las notas de cómo se fijó el precio', () =>
    csvSuite(publish));

  it('con el catálogo real: sigue siendo válido y no cambia ni un precio, nombre ni foto', () => {
    const clean = publish.sanitizeCatalogCsv(csv);
    const a = parseCatalogCsv(csv, { categories });
    const b = parseCatalogCsv(clean, { categories });
    expect(b.errors).toEqual([]);
    expect(b.items).toHaveLength(a.items.length);
    for (const [i, item] of b.items.entries()) {
      const before = a.items[i]!;
      expect({ ...item, cost: undefined, priceNote: undefined }).toEqual({
        ...before,
        cost: undefined,
        priceNote: undefined,
      });
    }
    // La columna `costo` queda vacía y `notas_precio` también.
    const rows = parseCsv(clean);
    const h = rows[0]!;
    for (const r of rows.slice(1)) {
      expect(r[h.indexOf('costo')]).toBe('');
      expect(r[h.indexOf('notas_precio')]).toBe('');
    }
    expect(clean).not.toMatch(/listado del|Precio definido por el due/i);
  });

  it('detecta mutaciones de la limpieza', async () => {
    const file = new URL('../../../scripts/preview-publish.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      [
        'el costo viaja en la página',
        [["['costo', 'notas_precio'] as const", "['notas_precio'] as const"]],
      ],
      [
        'las notas del precio viajan en la página',
        [["['costo', 'notas_precio'] as const", "['costo'] as const"]],
      ],
      ['las columnas con otras mayúsculas se escapan', [['normalizeHeader(h)', 'h']]],
      ['se borra el encabezado también', [['n === 0 ? r :', 'false ? r :']]],
      [
        'el CSV con punto y coma se parte mal',
        [['parseCsv(csv, detectDelimiter(csv))', "parseCsv(csv, ',')"]],
      ],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<Api>(file, edits);
      expectKilled(name, () => csvSuite(mutant));
    }
  });
});
