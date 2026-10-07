import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type PhotoManifestItem,
  catalogToCsv,
  parseCatalogCsv,
  parseCsv,
} from '@jellyfish/catalog';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runPhotosApply } from '../../../scripts/photos-apply';
import { fetchPhotos, runPhotosFetch } from '../../../scripts/photos-fetch';
import { catalogDir } from './helpers';

const repoRoot = join(catalogDir, '../..');
const run = promisify(execFile);

const categoriesPath = join(catalogDir, 'categories.json');
const categories = (JSON.parse(readFileSync(categoriesPath, 'utf8')) as { slug: string }[]).map(
  (c) => c.slug,
);
// La semilla real ya trae fotos (se aplicó el manifiesto): las pruebas parten de una copia SIN fotos
// para no depender del estado de los datos del negocio.
const seedItems = parseCatalogCsv(readFileSync(join(catalogDir, 'products.seed.csv'), 'utf8'), {
  categories,
}).items.map((i) => ({ ...i, photo: '', photoIllustrative: true }));
const seedText = catalogToCsv(seedItems);
const seedSkus = seedItems.map((i) => i.sku);

const entry = (sku: string, rawUrl: string, over: Partial<PhotoManifestItem> = {}) => ({
  sku,
  jobId: `job-${sku}`,
  rawUrl,
  minUrl: rawUrl.replace(/\.png$/, '_min.webp'),
  illustrative: true,
  model: 'doble-de-prueba',
  quality: 'high',
  aspect: '4:3',
  attempts: 1,
  verified: true,
  notes: '',
  ...over,
});
const manifestJson = (items: ReturnType<typeof entry>[]) =>
  JSON.stringify({ generatedWith: 'prueba', items }, null, 2);

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    io: { log: (l: string) => lines.push(l), error: (l: string) => errors.push(l) },
    out: () => lines.join('\n'),
    err: () => errors.join('\n'),
  };
}

describe('photos-apply (manifiesto → CSV)', () => {
  let dir: string;
  let csv: string;
  let manifest: string;
  const args = (...extra: string[]) => [
    '--csv',
    csv,
    '--manifest',
    manifest,
    '--categories',
    categoriesPath,
    ...extra,
  ];
  const writeManifest = (items: ReturnType<typeof entry>[]) =>
    writeFileSync(manifest, manifestJson(items));

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jf-apply-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    csv = join(dir, 'catalogo.csv');
    manifest = join(dir, 'manifiesto.json');
    writeFileSync(csv, seedText);
    writeManifest(seedSkus.map((s) => entry(s, `https://cdn.example.com/${s}.png`)));
  });

  it('--dry-run informa lo que cambiaría y no escribe nada', () => {
    const c = capture();
    expect(runPhotosApply(args('--dry-run'), c.io)).toBe(0);
    expect(c.out()).toContain(`Actualizadas: ${seedSkus.length}`);
    expect(c.out()).toContain('--dry-run');
    expect(readFileSync(csv, 'utf8')).toBe(seedText);
  });

  it('escribe la URL del manifiesto y foto_ilustrativa, y deja el resto del CSV idéntico', () => {
    const c = capture();
    expect(runPhotosApply(args(), c.io)).toBe(0);
    const before = parseCsv(seedText);
    const after = parseCsv(readFileSync(csv, 'utf8'));
    const col = (rows: string[][], name: string) => rows[0]!.indexOf(name);
    for (let r = 1; r < before.length; r++) {
      const sku = before[r]![0]!;
      expect(after[r]![col(after, 'foto')], sku).toBe(`https://cdn.example.com/${sku}.png`);
      expect(after[r]![col(after, 'foto_ilustrativa')], sku).toBe('si');
      for (const name of before[0]!) {
        if (name === 'foto') continue;
        expect(after[r]![col(after, name)], `${sku} ${name}`).toBe(before[r]![col(before, name)]);
      }
    }
  });

  it('es idempotente: la segunda corrida no cambia ni un byte', () => {
    runPhotosApply(args(), capture().io);
    const once = readFileSync(csv);
    const mtime = statSync(csv).mtimeMs;
    const c = capture();
    expect(runPhotosApply(args(), c.io)).toBe(0);
    expect(c.out()).toContain('Sin cambios');
    expect(c.out()).toContain(`Ya estaban al día: ${seedSkus.length}`);
    expect(readFileSync(csv).equals(once)).toBe(true);
    expect(statSync(csv).mtimeMs).toBe(mtime);
  });

  it('reporta SKUs sin foto y entradas huérfanas, y --strict las convierte en error', () => {
    writeManifest([
      entry(seedSkus[0]!, 'https://cdn.example.com/a.png'),
      entry('JF-NO-EXISTE', 'https://cdn.example.com/z.png'),
    ]);
    const lenient = capture();
    expect(runPhotosApply(args('--dry-run'), lenient.io)).toBe(0);
    expect(lenient.out()).toContain(`SKUs sin foto (${seedSkus.length - 1})`);
    expect(lenient.out()).toContain(
      'Entradas huérfanas (el SKU no está en el CSV) (1): JF-NO-EXISTE',
    );

    const strict = capture();
    expect(runPhotosApply(args('--dry-run', '--strict'), strict.io)).toBe(1);
    expect(strict.err()).toContain('--strict');

    writeManifest(seedSkus.map((s) => entry(s, `https://cdn.example.com/${s}.png`)));
    expect(runPhotosApply(args('--dry-run', '--strict'), capture().io)).toBe(0);
  });

  it('no aplica entradas sin verificar salvo con --include-unverified', () => {
    writeManifest([
      entry(seedSkus[0]!, 'https://cdn.example.com/a.png', { verified: false }),
      entry(seedSkus[1]!, 'https://cdn.example.com/b.png'),
    ]);
    const c = capture();
    runPhotosApply(args(), c.io);
    expect(c.out()).toContain('Omitidas por no estar verificadas (1)');
    const rows = parseCatalogCsv(readFileSync(csv, 'utf8'), { categories }).items;
    expect(rows[0]!.photo).toBe('');
    expect(rows[1]!.photo).toBe('https://cdn.example.com/b.png');

    runPhotosApply(args('--include-unverified'), capture().io);
    expect(parseCatalogCsv(readFileSync(csv, 'utf8'), { categories }).items[0]!.photo).toBe(
      'https://cdn.example.com/a.png',
    );
  });

  it('un manifiesto inválido o un CSV con errores terminan con error y sin tocar el CSV', () => {
    writeFileSync(manifest, '{"generatedWith":"x","items":[{"sku":"A"}]}');
    const m = capture();
    expect(runPhotosApply(args(), m.io)).toBe(1);
    expect(m.err()).toContain('Manifiesto inválido');
    expect(readFileSync(csv, 'utf8')).toBe(seedText);

    writeManifest(seedSkus.map((s) => entry(s, `https://cdn.example.com/${s}.png`)));
    const broken = seedText.replace('JF-MAR-001', 'JF-MAR-001').replace(/,169\.63,/, ',gratis,');
    expect(broken).not.toBe(seedText);
    writeFileSync(csv, broken);
    const e = capture();
    expect(runPhotosApply(args(), e.io)).toBe(1);
    expect(e.err()).toMatch(/fila 2 \[JF-MAR-001\] precio/);
    expect(readFileSync(csv, 'utf8')).toBe(broken);
  });

  it('falla con un mensaje claro si falta un archivo o la opción no existe', () => {
    const missing = capture();
    expect(
      runPhotosApply(['--csv', join(dir, 'no-existe.csv'), '--manifest', manifest], missing.io),
    ).toBe(1);
    expect(missing.err()).toContain('No se pudo leer');
    expect(runPhotosApply(['--nada'], capture().io)).toBe(2);
  });

  it('funciona como comando (npm run photos:apply) y respeta --dry-run', async () => {
    const { stdout } = await run('npx', ['tsx', 'scripts/photos-apply.ts', ...args('--dry-run')], {
      cwd: repoRoot,
    });
    expect(stdout).toContain(`Actualizadas: ${seedSkus.length}`);
    expect(readFileSync(csv, 'utf8')).toBe(seedText);
    await run('npx', ['tsx', 'scripts/photos-apply.ts', ...args()], { cwd: repoRoot });
    expect(readFileSync(csv, 'utf8')).not.toBe(seedText);
  }, 60_000);
});

describe('photos-fetch (manifiesto → archivos locales)', () => {
  let server: Server;
  let origin: string;
  let dir: string;
  let hits: Map<string, number>;
  let inFlight = 0;
  let maxInFlight = 0;
  let flakyServed = 0;

  const png = (r: number, g: number, b: number, w: number, h: number) =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '';
      hits.set(url, (hits.get(url) ?? 0) + 1);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = () => {
        inFlight--;
      };
      res.on('close', done);
      const send = (status: number, type: string, body: Buffer | string) => {
        res.writeHead(status, { 'content-type': type });
        res.end(body);
      };
      const img = /^\/img\/(\d+)-(\d+)-(\d+)\/(\d+)x(\d+)\.png$/.exec(url);
      if (img) {
        const [r, g, b, w, h] = img.slice(1).map(Number) as [
          number,
          number,
          number,
          number,
          number,
        ];
        // Una pausa corta deja ver cuántas descargas corren a la vez.
        setTimeout(() => {
          png(r, g, b, w, h).then(
            (buf) => send(200, 'image/png', buf),
            () => send(500, 'text/plain', 'x'),
          );
        }, 40);
      } else if (url === '/html') send(200, 'text/html', '<html>no soy una imagen</html>');
      else if (url === '/corrupta.png') send(200, 'image/png', Buffer.from('esto no es un PNG'));
      else if (url === '/vacia.png') send(200, 'image/png', '');
      else if (url === '/flaky.png') {
        if (flakyServed++ === 0) send(503, 'text/plain', 'ocupado');
        else png(10, 200, 10, 900, 675).then((buf) => send(200, 'image/png', buf));
      } else send(404, 'text/plain', 'no existe');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'jf-fetch-'));
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    hits = new Map();
    inFlight = 0;
    maxInFlight = 0;
    flakyServed = 0;
  });

  const out = () => mkdtempSync(join(dir, 'out-'));
  const items = (...specs: [string, string][]) =>
    specs.map(([sku, path]) => entry(sku, `${origin}${path}`));
  const mean = async (file: string) => (await sharp(file).stats()).channels.map((c) => c.mean);

  it('guarda <sku>.webp (ancho máx 1168) y <sku>.thumb.webp (ancho 480) con el color de SU imagen', async () => {
    const outDir = out();
    const results = await fetchPhotos({
      items: items(
        ['JF-A', '/img/220-20-20/1600x1200.png'],
        ['JF-B', '/img/20-20-220/1600x1200.png'],
      ),
      outDir,
    });
    expect(results.map((r) => [r.sku, r.status])).toEqual([
      ['JF-A', 'downloaded'],
      ['JF-B', 'downloaded'],
    ]);
    for (const [sku, dominant] of [
      ['JF-A', 0],
      ['JF-B', 2],
    ] as const) {
      const full = await sharp(join(outDir, `${sku}.webp`)).metadata();
      const thumb = await sharp(join(outDir, `${sku}.thumb.webp`)).metadata();
      expect([full.format, full.width, full.height]).toEqual(['webp', 1168, 876]);
      expect([thumb.format, thumb.width, thumb.height]).toEqual(['webp', 480, 360]);
      const m = await mean(join(outDir, `${sku}.webp`));
      expect(m[dominant]!).toBeGreaterThan(190);
      expect(m[(dominant + 1) % 3]!).toBeLessThan(60);
    }
    expect(readdirSync(outDir).sort()).toEqual([
      'JF-A.thumb.webp',
      'JF-A.webp',
      'JF-B.thumb.webp',
      'JF-B.webp',
    ]);
  });

  it('no amplía una imagen más chica que el máximo', async () => {
    const outDir = out();
    const [r] = await fetchPhotos({ items: items(['JF-M', '/img/90-90-90/800x600.png']), outDir });
    expect(r).toMatchObject({ status: 'downloaded', width: 800, height: 600 });
    expect((await sharp(join(outDir, 'JF-M.thumb.webp')).metadata()).width).toBe(480);
  });

  it('omite lo ya descargado y solo vuelve a bajarlo con --force', async () => {
    const outDir = out();
    const it1 = items(['JF-A', '/img/200-30-30/1600x1200.png']);
    await fetchPhotos({ items: it1, outDir });
    expect(hits.get('/img/200-30-30/1600x1200.png')).toBe(1);

    const again = await fetchPhotos({ items: it1, outDir });
    expect(again[0]).toMatchObject({ status: 'skipped', width: 1168 });
    expect(hits.get('/img/200-30-30/1600x1200.png')).toBe(1);

    const forced = await fetchPhotos({ items: it1, outDir, force: true });
    expect(forced[0]!.status).toBe('downloaded');
    expect(hits.get('/img/200-30-30/1600x1200.png')).toBe(2);
  });

  it('un archivo truncado o falta la miniatura NO cuenta como descargado', async () => {
    const outDir = out();
    const it1 = items(['JF-A', '/img/200-30-30/1600x1200.png']);
    await fetchPhotos({ items: it1, outDir });
    writeFileSync(join(outDir, 'JF-A.webp'), 'truncado');
    expect((await fetchPhotos({ items: it1, outDir }))[0]!.status).toBe('downloaded');
    expect((await sharp(join(outDir, 'JF-A.webp')).metadata()).format).toBe('webp');

    rmSync(join(outDir, 'JF-A.thumb.webp'));
    expect((await fetchPhotos({ items: it1, outDir }))[0]!.status).toBe('downloaded');
    expect(existsSync(join(outDir, 'JF-A.thumb.webp'))).toBe(true);
  });

  it('rechaza lo que no es una imagen válida, sin dejar archivos a medias y sin frenar al resto', async () => {
    const outDir = out();
    const results = await fetchPhotos({
      items: items(
        ['JF-HTML', '/html'],
        ['JF-404', '/no-esta.png'],
        ['JF-BAD', '/corrupta.png'],
        ['JF-EMPTY', '/vacia.png'],
        ['JF-SMALL', '/img/5-5-5/300x225.png'],
        ['JF-OK', '/img/30-200-30/1600x1200.png'],
      ),
      outDir,
      retryDelayMs: 1,
    });
    const by = Object.fromEntries(results.map((r) => [r.sku, r]));
    expect(by['JF-HTML']).toMatchObject({ status: 'failed' });
    expect(by['JF-HTML']!.detail).toMatch(/no es una imagen.*text\/html/);
    expect(by['JF-404']!.detail).toBe('HTTP 404');
    expect(by['JF-BAD']!.detail).toMatch(/ilegible|formato/);
    expect(by['JF-EMPTY']!.detail).toMatch(/vacía/);
    expect(by['JF-SMALL']!.detail).toMatch(/muy pequeña.*300×225/);
    expect(by['JF-OK']!.status).toBe('downloaded');
    // Solo quedó lo bueno: ni .tmp ni miniaturas huérfanas de los fallidos.
    expect(readdirSync(outDir).sort()).toEqual(['JF-OK.thumb.webp', 'JF-OK.webp']);
    // Un 404 es definitivo: no se reintenta.
    expect(hits.get('/no-esta.png')).toBe(1);
  });

  it('reintenta ante un 503 y acaba bajando la imagen', async () => {
    const outDir = out();
    const [r] = await fetchPhotos({
      items: items(['JF-F', '/flaky.png']),
      outDir,
      retryDelayMs: 1,
    });
    expect(r!.status).toBe('downloaded');
    expect(hits.get('/flaky.png')).toBe(2);
  });

  it('falla si no puede conectarse', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise((r) => dead.close(r));
    const [r] = await fetchPhotos({
      items: [entry('JF-X', `http://127.0.0.1:${port}/a.png`)],
      outDir: out(),
      attempts: 2,
      retryDelayMs: 1,
    });
    expect(r).toMatchObject({ status: 'failed' });
    expect(r!.detail).toMatch(/sin respuesta/);
  });

  it('si no puede guardar, falla con un mensaje claro y no deja temporales', async () => {
    const outDir = out();
    // Un directorio con el nombre del destino hace fallar el renombrado final.
    mkdirSync(join(outDir, 'JF-D.webp'));
    const [r] = await fetchPhotos({ items: items(['JF-D', '/img/9-9-9/900x675.png']), outDir });
    expect(r).toMatchObject({ status: 'failed' });
    expect(r!.detail).toMatch(/no se pudo guardar/);
    expect(readdirSync(outDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('avisa si la relación de aspecto no es la del manifiesto, pero guarda la imagen', async () => {
    const [r] = await fetchPhotos({
      items: items(['JF-W', '/img/60-60-60/1600x700.png']),
      outDir: out(),
    });
    expect(r!.status).toBe('downloaded');
    expect(r!.detail).toMatch(/aspecto real es 2\.29.*4:3/);
  });

  it('descarga en paralelo pero sin pasar del máximo pedido', async () => {
    const specs = Array.from(
      { length: 8 },
      (_, i) => [`JF-P${i}`, `/img/${i * 20}-0-0/1000x750.png`] as [string, string],
    );
    await fetchPhotos({ items: items(...specs), outDir: out(), concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(hits.size).toBe(8);
  });

  it('un SKU que no sirve como nombre de archivo no escribe fuera de la carpeta', async () => {
    const outDir = out();
    const results = await fetchPhotos({
      items: [
        entry('../escapa', `${origin}/img/1-1-1/900x675.png`),
        entry('a/b', `${origin}/img/1-1-1/900x675.png`),
      ],
      outDir,
    });
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(hits.size).toBe(0);
    expect(existsSync(join(outDir, '..', 'escapa.webp'))).toBe(false);
    expect(readdirSync(outDir)).toEqual([]);
  });

  describe('comando con --rewrite', () => {
    const [A, B, C, D] = seedSkus as [string, string, string, string];
    let work: string;
    let csv: string;
    let manifest: string;
    const raw: Record<string, () => string> = {
      [A]: () => `${origin}/img/200-30-30/1600x1200.png`,
      [B]: () => `${origin}/img/30-200-30/1600x1200.png`,
      [C]: () => `${origin}/no-esta.png`,
      [D]: () => `${origin}/img/30-30-200/1600x1200.png`,
    };
    const REAL = '/photos/foto-real-del-dueno.webp';
    const cliArgs = (outDir: string, ...extra: string[]) => [
      '--manifest',
      manifest,
      '--out',
      outDir,
      '--csv',
      csv,
      '--categories',
      categoriesPath,
      ...extra,
    ];
    const rowsOf = () => parseCatalogCsv(readFileSync(csv, 'utf8'), { categories }).items;
    const photoOf = (sku: string) => rowsOf().find((i) => i.sku === sku)!.photo;

    beforeEach(() => {
      work = mkdtempSync(join(dir, 'work-'));
      csv = join(work, 'catalogo.csv');
      manifest = join(work, 'manifiesto.json');
      writeFileSync(manifest, manifestJson([A, B, C, D].map((s) => entry(s, raw[s]!()))));
      // Como lo deja photos:apply (la URL del manifiesto en `foto`), salvo D: foto real del dueño.
      const items = parseCatalogCsv(seedText, { categories }).items.map((i) =>
        i.sku === D
          ? { ...i, photo: REAL, photoIllustrative: false }
          : i.sku in raw
            ? { ...i, photo: raw[i.sku]!() }
            : i,
      );
      writeFileSync(csv, catalogToCsv(items));
    });

    it('pasa a /photos/<sku>.webp solo lo que bajó bien; el resto del CSV queda igual', async () => {
      const before = rowsOf();
      const c = capture();
      const code = await runPhotosFetch(cliArgs(out(), '--rewrite'), c.io);
      expect(code).toBe(1); // C no existe en el servidor
      expect(c.out()).toContain('Descargadas: 3');
      expect(c.out()).toContain('Fallidas: 1');
      expect(c.out()).toContain('2 fotos pasaron a /photos/<sku>.webp');
      expect(photoOf(A)).toBe(`/photos/${A}.webp`);
      expect(photoOf(B)).toBe(`/photos/${B}.webp`);
      // C falló: sigue apuntando a su URL. D tiene una foto real del dueño: no se pisa.
      expect(photoOf(C)).toBe(raw[C]!());
      expect(photoOf(D)).toBe(REAL);
      expect(c.out()).toContain(`Conservadas (su foto no es la del manifiesto): ${D}`);

      const strip = (items: typeof before) => items.map(({ photo: _p, ...rest }) => rest);
      expect(strip(rowsOf())).toEqual(strip(before));
    });

    it('es idempotente: otra corrida no baja nada ni toca el CSV', async () => {
      const outDir = out();
      await runPhotosFetch(cliArgs(outDir, '--rewrite'), capture().io);
      const once = readFileSync(csv);
      hits.clear();
      const c = capture();
      expect(await runPhotosFetch(cliArgs(outDir, '--rewrite'), c.io)).toBe(1);
      expect(c.out()).toContain('Ya estaban: 3');
      expect(c.out()).toContain('CSV sin cambios');
      expect(readFileSync(csv).equals(once)).toBe(true);
      // Solo se volvió a intentar lo que había fallado.
      expect([...hits.keys()]).toEqual(['/no-esta.png']);
    });

    it('sin --rewrite el CSV no se toca', async () => {
      const before = readFileSync(csv);
      await runPhotosFetch(cliArgs(out()), capture().io);
      expect(readFileSync(csv).equals(before)).toBe(true);
    });

    it('--only limita a esos SKUs y rechaza uno que el manifiesto no trae', async () => {
      const outDir = out();
      const c = capture();
      expect(await runPhotosFetch(cliArgs(outDir, '--only', A), c.io)).toBe(0);
      expect(readdirSync(outDir).sort()).toEqual([`${A}.thumb.webp`, `${A}.webp`]);

      hits.clear();
      const bad = capture();
      expect(await runPhotosFetch(cliArgs(out(), '--only', `${A},JF-NOPE`), bad.io)).toBe(1);
      expect(bad.err()).toContain('JF-NOPE');
      expect(hits.size).toBe(0);
    });

    it('valida --concurrency y el manifiesto', async () => {
      expect(await runPhotosFetch(cliArgs(out(), '--concurrency', '0'), capture().io)).toBe(2);
      expect(await runPhotosFetch(cliArgs(out(), '--concurrency', 'x'), capture().io)).toBe(2);
      writeFileSync(manifest, '{"generatedWith":"x","items":[{"sku":"A"}]}');
      const c = capture();
      expect(await runPhotosFetch(cliArgs(out()), c.io)).toBe(1);
      expect(c.err()).toContain('Manifiesto inválido');
      expect(hits.size).toBe(0);
    });

    it('funciona como comando (npm run photos:fetch) y sale con 0 si todo bajó bien', async () => {
      const outDir = out();
      const { stdout } = await run(
        'npx',
        ['tsx', 'scripts/photos-fetch.ts', ...cliArgs(outDir, '--only', `${A},${B}`, '--rewrite')],
        { cwd: repoRoot },
      );
      expect(stdout).toContain('Descargadas: 2');
      expect(existsSync(join(outDir, `${B}.thumb.webp`))).toBe(true);
      expect(photoOf(B)).toBe(`/photos/${B}.webp`);
    }, 60_000);
  });
});
