import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCatalogCsv } from '@jellyfish/catalog';
import { photoRefError } from '@jellyfish/shared';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, testConfig } from '../src/config';
import { variants } from '../src/db/schema';
import { photoCacheControl } from '../src/routes/static';
import {
  exportCatalogCsv,
  getProduct,
  importCatalog,
  listProducts,
  patchVariant,
} from '../src/services/catalog';
import { type World, categoriesJson, makeApp, makeWorld } from './helpers';

const BASE = 'https://api.jellyfish.test';
const CDN_PHOTO = 'https://d8j0ntlcm91z4.cloudfront.net/user_x/hf_20261007_000000_abc.png';
/** Como quedó guardada una foto antes de que se validara lo que se escribe (no se puede importar de nuevo). */
const LEGACY_PHOTO = 'fotos/pechuga.jpg';
/** Lo que nunca debe llegar a la columna foto (se publica tal cual en GET /v1/products). */
const BAD_PHOTOS = [
  'javascript:alert(1)',
  'data:image/png;base64,AAAA',
  '//evil.example/x.png',
  'fotos/x.jpg',
  'ftp://host/x.png',
  '/photos/con espacio.webp',
];

const HEADER =
  'sku,grupo,nombre,variante,categoria,unidad,paso_lb,minimo_lb,precio,precio_fuente,itbis,stock,foto,foto_ilustrativa';
const PHOTO_CSV = [
  HEADER,
  `PH-1,foto-local,Producto con foto local,,aves,lb,0.5,1,100,usuario,0,50,/photos/PH-1.webp,si`,
  `PH-2,foto-cdn,Producto con foto del CDN,,aves,lb,0.5,1,100,usuario,0,50,${CDN_PHOTO},no`,
  `PH-3,foto-local-b,Producto con otra foto local,,aves,lb,0.5,1,100,usuario,0,50,/photos/pechuga.webp,`,
  `PH-4,sin-foto,Producto sin foto,,aves,lb,0.5,1,100,usuario,0,50,,`,
].join('\n');

describe('fotos del catálogo en la base de datos y en el API', () => {
  let w: World;
  let app: FastifyInstance;
  let auth: Awaited<ReturnType<typeof makeApp>>['auth'];
  let base: string;
  let photosDir: string;

  const json = (res: { body: string }) => JSON.parse(res.body);
  const dbVariant = async (sku: string) => {
    const [v] = await w.handle.db.select().from(variants).where(eq(variants.sku, sku));
    return v!;
  };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'jf-photos-'));
    photosDir = join(base, 'photos');
    mkdirSync(join(photosDir, 'sub'), { recursive: true });
    const tiny = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#000000' },
    })
      .webp()
      .toBuffer();
    writeFileSync(join(photosDir, 'PH-1.webp'), tiny);
    writeFileSync(join(photosDir, 'PH-1.thumb.webp'), tiny);
    writeFileSync(join(photosDir, 'PH-9.3fa9c1d2.webp'), tiny);
    writeFileSync(join(photosDir, 'sub', 'inner.webp'), tiny);
    writeFileSync(join(photosDir, 'notes.txt'), 'NOTAS INTERNAS');
    writeFileSync(join(photosDir, '.oculta.webp'), tiny);
    // Fuera de la carpeta de fotos y con extensión de imagen: solo la protección contra ".." la frena.
    writeFileSync(join(base, 'secreto.png'), 'CONTENIDO SECRETO');

    w = await makeWorld({
      photosDir,
      payments: { ...testConfig().payments, publicBaseUrl: BASE },
    });
    ({ app, auth } = await makeApp(w));
    const imported = await importCatalog(w.handle.db, PHOTO_CSV);
    expect(imported.errors).toEqual([]);
  });
  afterAll(async () => {
    await app.close();
    await w.close();
    rmSync(base, { recursive: true, force: true });
  });

  describe('importación y exportación', () => {
    it('guarda la foto y si es ilustrativa; vacío o ausente cuenta como ilustrativa', async () => {
      expect(await dbVariant('PH-1')).toMatchObject({
        photo: '/photos/PH-1.webp',
        photoIllustrative: true,
      });
      expect(await dbVariant('PH-2')).toMatchObject({ photo: CDN_PHOTO, photoIllustrative: false });
      expect(await dbVariant('PH-3')).toMatchObject({
        photo: '/photos/pechuga.webp',
        photoIllustrative: true,
      });
      expect(await dbVariant('PH-4')).toMatchObject({ photo: '', photoIllustrative: true });
    });

    it('al reimportar actualiza el rótulo de un artículo que ya existe', async () => {
      const flipped = PHOTO_CSV.replace(`${CDN_PHOTO},no`, `${CDN_PHOTO},si`).replace(
        '/photos/PH-1.webp,si',
        '/photos/PH-1.webp,no',
      );
      const r = await importCatalog(w.handle.db, flipped);
      expect(r.errors).toEqual([]);
      expect(r.variantsUpdated).toBe(4);
      expect((await dbVariant('PH-2')).photoIllustrative).toBe(true);
      expect((await dbVariant('PH-1')).photoIllustrative).toBe(false);
      // se deja como estaba para las demás pruebas
      await importCatalog(w.handle.db, PHOTO_CSV);
      expect((await dbVariant('PH-2')).photoIllustrative).toBe(false);
      expect((await dbVariant('PH-1')).photoIllustrative).toBe(true);
    });

    it('una prueba en seco no guarda nada', async () => {
      const changed = PHOTO_CSV.replace(
        'PH-4,sin-foto,Producto sin foto,,aves,lb,0.5,1,100,usuario,0,50,,',
        'PH-4,sin-foto,Producto sin foto,,aves,lb,0.5,1,100,usuario,0,50,/photos/PH-4.webp,no',
      );
      expect(changed).not.toBe(PHOTO_CSV);
      const r = await importCatalog(w.handle.db, changed, { dryRun: true });
      expect(r.ok).toBe(true);
      expect(r.variantsUpdated).toBe(4);
      expect(await dbVariant('PH-4')).toMatchObject({ photo: '', photoIllustrative: true });
    });

    it('una foto inválida es un error de fila (campo foto) y no se guarda nada del archivo', async () => {
      const rows = BAD_PHOTOS.map(
        (photo, i) =>
          `BAD-${i},bad-${i},Producto malo ${i},,aves,lb,0.5,1,100,usuario,0,50,"${photo}",`,
      );
      const csv = [
        HEADER,
        `OK-1,ok-1,Producto bueno,,aves,lb,0.5,1,100,usuario,0,50,/photos/OK-1.webp,`,
        ...rows,
      ].join('\n');
      const r = await importCatalog(w.handle.db, csv);
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => [e.line, e.sku, e.field])).toEqual(
        BAD_PHOTOS.map((_, i) => [i + 3, `BAD-${i}`, 'foto']),
      );
      for (const [i, photo] of BAD_PHOTOS.entries()) {
        expect(r.errors[i]!.message).toBe(photoRefError(photo));
      }
      // ni siquiera la fila buena: un archivo con errores no se aplica
      const saved = await w.handle.db
        .select({ sku: variants.sku })
        .from(variants)
        .where(inArray(variants.sku, ['OK-1', ...BAD_PHOTOS.map((_, i) => `BAD-${i}`)]));
      expect(saved).toEqual([]);
    });

    it('por HTTP la prueba en seco también devuelve el error de la fila y el motivo en español', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/catalog/import?dryRun=1',
        headers: auth(w.adminId, 'admin'),
        payload: {
          csv: [
            HEADER,
            'BAD-H,bad-h,Producto malo,,aves,lb,0.5,1,100,usuario,0,50,"javascript:alert(1)",',
          ].join('\n'),
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(json(res)).toMatchObject({
        ok: false,
        errors: [{ line: 2, sku: 'BAD-H', field: 'foto' }],
      });
      expect(json(res).errors[0].message).toMatch(/^Escribe una ruta que empiece con \//);
    });

    it('exporta la foto TAL COMO está guardada (sin URL absoluta) y reimporta sin pérdida', async () => {
      const csv = await exportCatalogCsv(w.handle.db);
      const parsed = parseCatalogCsv(csv, { categories: categoriesJson.map((c) => c.slug) });
      expect(parsed.errors).toEqual([]);
      const bySku = Object.fromEntries(parsed.items.map((i) => [i.sku, i]));
      expect(bySku['PH-1']).toMatchObject({ photo: '/photos/PH-1.webp', photoIllustrative: true });
      expect(bySku['PH-2']).toMatchObject({ photo: CDN_PHOTO, photoIllustrative: false });
      expect(bySku['PH-3']).toMatchObject({
        photo: '/photos/pechuga.webp',
        photoIllustrative: true,
      });

      const again = await importCatalog(w.handle.db, csv);
      expect(again.errors).toEqual([]);
      for (const v of await w.handle.db.select().from(variants)) {
        const item = parsed.items.find((i) => i.sku === v.sku)!;
        expect([v.sku, v.photo, v.photoIllustrative]).toEqual([
          v.sku,
          item.photo,
          item.photoIllustrative,
        ]);
      }
      expect((await dbVariant('PH-2')).photoIllustrative).toBe(false);
    });
  });

  describe('fotos en las respuestas del API', () => {
    it('una ruta local se vuelve absoluta con la URL pública del API; https no cambia', async () => {
      const res = await app.inject({ url: '/v1/products?category=aves&limit=100' });
      expect(res.statusCode).toBe(200);
      const all = json(res).items.flatMap((p: { variants: unknown[] }) => p.variants) as {
        sku: string;
        photo: string;
        photoIllustrative: boolean;
      }[];
      const by = Object.fromEntries(all.map((v) => [v.sku, v]));
      expect(by['PH-1']).toMatchObject({
        photo: `${BASE}/photos/PH-1.webp`,
        photoIllustrative: true,
      });
      expect(by['PH-2']).toMatchObject({ photo: CDN_PHOTO, photoIllustrative: false });
      expect(by['PH-3']).toMatchObject({
        photo: `${BASE}/photos/pechuga.webp`,
        photoIllustrative: true,
      });
      expect(by['PH-4']).toMatchObject({ photo: '', photoIllustrative: true });
    });

    it('el detalle de un producto trae lo mismo', async () => {
      const res = await app.inject({ url: '/v1/products/foto-local' });
      expect(res.statusCode).toBe(200);
      expect(json(res).product.variants[0]).toMatchObject({
        sku: 'PH-1',
        photo: `${BASE}/photos/PH-1.webp`,
        photoIllustrative: true,
      });
    });

    it('el servicio devuelve la foto sin tocar cuando no se le da la URL pública', async () => {
      const product = await getProduct(w.handle.db, false, 'foto-local');
      expect(product.variants[0]!.photo).toBe('/photos/PH-1.webp');
      const list = await listProducts(w.handle.db, false, { category: 'aves', limit: 100 });
      expect(list.items.flatMap((p) => p.variants).map((v) => v.photo)).toContain(
        '/photos/PH-1.webp',
      );
    });

    it('la cotización lleva la foto absoluta y si es ilustrativa en cada línea', async () => {
      const [local, cdn] = [await dbVariant('PH-1'), await dbVariant('PH-2')];
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quote',
        payload: {
          items: [
            { variantId: local.id, quantity: 100 },
            { variantId: cdn.id, quantity: 100 },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      const lines = json(res).lines as { sku: string; photo: string; photoIllustrative: boolean }[];
      expect(lines.find((l) => l.sku === 'PH-1')).toMatchObject({
        photo: `${BASE}/photos/PH-1.webp`,
        photoIllustrative: true,
      });
      expect(lines.find((l) => l.sku === 'PH-2')).toMatchObject({
        photo: CDN_PHOTO,
        photoIllustrative: false,
      });
    });
  });

  describe('edición desde el panel', () => {
    it('PATCH acepta photo y photoIllustrative y los guarda', async () => {
      const v = await dbVariant('PH-4');
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: auth(w.adminId, 'admin'),
        payload: { photo: '  /photos/PH-4.webp  ', photoIllustrative: false },
      });
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({ photo: '/photos/PH-4.webp', photoIllustrative: false });
      expect(await dbVariant('PH-4')).toMatchObject({
        photo: '/photos/PH-4.webp',
        photoIllustrative: false,
      });
    });

    it('PATCH rechaza lo que no es una ruta o URL (javascript:, data:, //host…) y no guarda nada', async () => {
      const v = await dbVariant('PH-1');
      const before = v.photo;
      for (const photo of [...BAD_PHOTOS, `/${'a'.repeat(300)}`]) {
        const res = await app.inject({
          method: 'PATCH',
          url: `/v1/admin/variants/${v.id}`,
          headers: auth(w.adminId, 'admin'),
          payload: { photo, price: 12_345 },
        });
        expect(res.statusCode, photo).toBe(400);
        expect(json(res).error.code).toBe('validation');
        expect(json(res).error.message, photo).toBe(`photo: ${photoRefError(photo)}`);
        // ni la foto ni el resto del cambio se aplican
        expect(await dbVariant('PH-1')).toMatchObject({ photo: before, price: v.price });
      }
      expect(
        json(
          await app.inject({
            method: 'PATCH',
            url: `/v1/admin/variants/${v.id}`,
            headers: auth(w.adminId, 'admin'),
            payload: { photo: `/${'a'.repeat(300)}` },
          }),
        ).error.message,
      ).toBe('photo: Máximo 300 caracteres');
    });

    it('el servicio también lo rechaza: la regla no vive solo en la ruta', async () => {
      const v = await dbVariant('PH-1');
      await expect(
        patchVariant(w.handle.db, v.id, { photo: 'javascript:alert(1)' }),
      ).rejects.toMatchObject({
        code: 'validation',
        status: 400,
      });
      expect((await dbVariant('PH-1')).photo).toBe(v.photo);
    });

    it('PATCH acepta quitar la foto (vacío o solo espacios) y una URL https', async () => {
      const v = await dbVariant('PH-4');
      const patch = (photo: string) =>
        app.inject({
          method: 'PATCH',
          url: `/v1/admin/variants/${v.id}`,
          headers: auth(w.adminId, 'admin'),
          payload: { photo },
        });
      expect((await patch(CDN_PHOTO)).statusCode).toBe(200);
      expect((await dbVariant('PH-4')).photo).toBe(CDN_PHOTO);
      expect((await patch('   ')).statusCode).toBe(200);
      expect((await dbVariant('PH-4')).photo).toBe('');
    });

    it('cambiar solo la foto no toca el rótulo, y cambiar solo el rótulo no toca la foto', async () => {
      const v = await dbVariant('PH-4');
      const headers = auth(w.adminId, 'admin');
      await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers,
        payload: { photo: '/photos/otra.webp' },
      });
      expect(await dbVariant('PH-4')).toMatchObject({
        photo: '/photos/otra.webp',
        photoIllustrative: false,
      });
      await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers,
        payload: { photoIllustrative: true },
      });
      expect(await dbVariant('PH-4')).toMatchObject({
        photo: '/photos/otra.webp',
        photoIllustrative: true,
      });
    });

    it('el listado del panel muestra la foto guardada (sin absolutizar) y el rótulo', async () => {
      const res = await app.inject({
        url: '/v1/admin/catalog',
        headers: auth(w.adminId, 'admin'),
      });
      const rows = json(res) as { sku: string; photo: string; photoIllustrative: boolean }[];
      expect(rows.find((r) => r.sku === 'PH-1')).toMatchObject({
        photo: '/photos/PH-1.webp',
        photoIllustrative: true,
      });
      expect(rows.find((r) => r.sku === 'PH-2')).toMatchObject({
        photo: CDN_PHOTO,
        photoIllustrative: false,
      });
    });

    it('rechaza un rótulo que no es booleano y a quien no es administrador', async () => {
      const v = await dbVariant('PH-1');
      const bad = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: auth(w.adminId, 'admin'),
        payload: { photoIllustrative: 'no' },
      });
      expect(bad.statusCode).toBe(400);
      const denied = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/variants/${v.id}`,
        headers: auth(w.customerId, 'customer'),
        payload: { photoIllustrative: false },
      });
      expect(denied.statusCode).toBe(403);
      expect((await dbVariant('PH-1')).photoIllustrative).toBe(true);
    });
  });

  describe('texto heredado que ya estaba guardado', () => {
    /** Simula un artículo guardado antes de validar la foto, y lo deja como estaba al terminar. */
    async function withLegacyPhoto(fn: () => Promise<void>) {
      const { db } = w.handle;
      await db.update(variants).set({ photo: LEGACY_PHOTO }).where(eq(variants.sku, 'PH-3'));
      try {
        await fn();
      } finally {
        await db
          .update(variants)
          .set({ photo: '/photos/pechuga.webp' })
          .where(eq(variants.sku, 'PH-3'));
      }
    }

    it('el API lo sigue mostrando tal cual (no es absoluta ni se rompe)', async () => {
      await withLegacyPhoto(async () => {
        const res = await app.inject({ url: '/v1/products?category=aves&limit=100' });
        const all = json(res).items.flatMap((p: { variants: unknown[] }) => p.variants) as {
          sku: string;
          photo: string;
        }[];
        expect(all.find((v) => v.sku === 'PH-3')!.photo).toBe(LEGACY_PHOTO);
      });
    });

    it('se exporta tal cual, pero volver a importarlo señala la fila y no cambia nada', async () => {
      await withLegacyPhoto(async () => {
        const csv = await exportCatalogCsv(w.handle.db);
        expect(csv).toContain(LEGACY_PHOTO);
        const r = await importCatalog(w.handle.db, csv);
        expect(r.ok).toBe(false);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0]).toMatchObject({ sku: 'PH-3', field: 'foto' });
        expect(r.variantsUpdated).toBe(0);
        expect((await dbVariant('PH-3')).photo).toBe(LEGACY_PHOTO);
      });
    });

    it('el panel lo corrige con una ruta válida o lo quita con vacío', async () => {
      await withLegacyPhoto(async () => {
        const v = await dbVariant('PH-3');
        const patch = (photo: string) =>
          app.inject({
            method: 'PATCH',
            url: `/v1/admin/variants/${v.id}`,
            headers: auth(w.adminId, 'admin'),
            payload: { photo },
          });
        expect((await patch('/photos/pechuga.webp')).statusCode).toBe(200);
        expect((await dbVariant('PH-3')).photo).toBe('/photos/pechuga.webp');
        expect((await patch('')).statusCode).toBe(200);
        expect((await dbVariant('PH-3')).photo).toBe('');
      });
    });
  });

  describe('GET /photos/*', () => {
    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url, headers });

    it('sirve la imagen con su tipo, ETag y caché de un día revalidable', async () => {
      const res = await get('/photos/PH-1.webp');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.headers['cache-control']).toMatch(/^public, max-age=86400/);
      expect(res.headers['cache-control']).not.toMatch(/immutable/);
      expect(res.headers.etag).toBeTruthy();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      // el panel y la vista previa web las cargan desde otro origen
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.rawPayload.equals(readFileSync(join(photosDir, 'PH-1.webp')))).toBe(true);
    });

    it('responde 304 sin cuerpo cuando el ETag coincide', async () => {
      const first = await get('/photos/PH-1.webp');
      const again = await get('/photos/PH-1.webp', { 'if-none-match': String(first.headers.etag) });
      expect(again.statusCode).toBe(304);
      expect(again.rawPayload.length).toBe(0);
      const other = await get('/photos/PH-1.webp', { 'if-none-match': '"otro"' });
      expect(other.statusCode).toBe(200);
    });

    it('un nombre con hash en el medio se cachea un año como inmutable', async () => {
      const res = await get('/photos/PH-9.3fa9c1d2.webp');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('responde HEAD y sirve las miniaturas locales', async () => {
      const head = await app.inject({ method: 'HEAD', url: '/photos/PH-1.webp' });
      expect(head.statusCode).toBe(200);
      expect(Number(head.headers['content-length'])).toBeGreaterThan(0);
      expect(head.rawPayload.length).toBe(0);
      expect((await get('/photos/PH-1.thumb.webp')).statusCode).toBe(200);
    });

    it('un archivo que no existe da 404 JSON y no se cachea', async () => {
      const res = await get('/photos/NO-EXISTE.webp');
      expect(res.statusCode).toBe(404);
      expect(json(res).error.code).toBe('not_found');
      expect(res.headers['cache-control'] ?? '').not.toMatch(/public/);
    });

    it('no lista carpetas', async () => {
      for (const url of ['/photos', '/photos/', '/photos/sub', '/photos/sub/', '/photos/?x=1']) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).not.toContain('PH-1');
      }
    });

    it('no sirve subcarpetas, archivos que no son imágenes ni archivos ocultos', async () => {
      for (const url of ['/photos/sub/inner.webp', '/photos/notes.txt', '/photos/.oculta.webp']) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).not.toContain('NOTAS INTERNAS');
      }
    });

    it('no permite salir de la carpeta con "../" (ni codificado)', async () => {
      const attempts = [
        '/photos/../secreto.png',
        '/photos/%2e%2e/secreto.png',
        '/photos/..%2fsecreto.png',
        '/photos/%2e%2e%2fsecreto.png',
        '/photos/....//secreto.png',
        '/photos/..\\secreto.png',
        '/photos/sub/../../secreto.png',
        '/photos/%252e%252e%252fsecreto.png',
        '/photos/PH-1.webp%00.png',
        '/photos//etc/passwd',
      ];
      for (const url of attempts) {
        const res = await get(url);
        expect(res.statusCode, url).not.toBe(200);
        expect(res.body, url).not.toContain('CONTENIDO SECRETO');
        expect(res.body, url).not.toContain('root:');
      }
    });

    it('solo acepta GET y HEAD', async () => {
      const res = await app.inject({ method: 'POST', url: '/photos/PH-1.webp', payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it('no cuenta contra el límite de peticiones, a diferencia del resto del API', async () => {
      const { app: fresh } = await makeApp(w);
      try {
        for (let i = 0; i < 320; i++) {
          const res = await fresh.inject({ url: '/photos/PH-1.thumb.webp' });
          if (res.statusCode !== 200) throw new Error(`petición ${i}: ${res.statusCode}`);
        }
        const codes: number[] = [];
        for (let i = 0; i < 310; i++)
          codes.push((await fresh.inject({ url: '/health' })).statusCode);
        expect(codes.filter((c) => c === 200)).toHaveLength(300);
        expect(codes.at(-1)).toBe(429);
      } finally {
        await fresh.close();
      }
    });
  });
});

describe('configuración y caché de fotos', () => {
  it('PHOTOS_DIR define la carpeta; vacía, se usa la de por defecto', () => {
    expect(loadConfig({ NODE_ENV: 'test', PHOTOS_DIR: ' /srv/fotos ' }).photosDir).toBe(
      '/srv/fotos',
    );
    expect(loadConfig({ NODE_ENV: 'test', PHOTOS_DIR: '  ' }).photosDir).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'test' }).photosDir).toBeUndefined();
  });

  it('solo es inmutable lo que lleva un hash propio entre puntos', () => {
    expect(photoCacheControl('JF-RES-001.3fa9c1d2.webp')).toMatch(/immutable/);
    expect(photoCacheControl('JF-RES-001.webp')).not.toMatch(/immutable/);
    // un SKU en hexadecimal NO es un hash: va unido por guiones, no entre puntos
    expect(photoCacheControl('JF-DEADBEEF.webp')).not.toMatch(/immutable/);
    expect(photoCacheControl('JF-RES-001.thumb.webp')).not.toMatch(/immutable/);
  });

  it('sin carpeta de fotos (aún no descargadas) el API arranca y responde 404', async () => {
    const world = await makeWorld({ photosDir: join(tmpdir(), 'jf-no-existe-' + Date.now()) });
    const { app } = await makeApp(world);
    try {
      const res = await app.inject({ url: '/photos/JF-MAR-001.webp' });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('not_found');
    } finally {
      await app.close();
      await world.close();
    }
  });
});
