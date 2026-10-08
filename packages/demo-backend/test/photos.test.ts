import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from '@jellyfish/catalog';
import { photoThumb } from '@jellyfish/shared';
import { buildCatalog } from '../src/catalog';
import * as photos from '../src/photos';
import { cleanMutants, expectKilled, loadMutant } from './mutation-lib';

const BASE = 'https://visor.example/x/y/z/';
const CDN = 'https://d8j0ntlcm91z4.cloudfront.net/u/hf_20261007_1_abc.png';

/** Lo que la política de fotos de la vista previa tiene que cumplir. */
function photoSuite(api: typeof photos): void {
  const { resolvePhoto, isExternalPhoto, localThumbPath } = api;
  expect(localThumbPath('JF-MAR-002')).toBe('photos/JF-MAR-002.thumb.webp');

  // Todo lo que no sea un archivo propio es "externo".
  for (const url of [
    CDN,
    'http://cdn.example/a.webp',
    '//cdn.example/a.webp',
    'ftp://x/a.webp',
    'file:///etc/passwd',
    'HTTPS://CDN.EXAMPLE/A.WEBP',
    'javascript:alert(1)',
  ])
    expect(isExternalPhoto(url), url).toBe(true);
  for (const url of [
    'photos/a.webp',
    '/photos/a.webp',
    'data:image/webp;base64,AAAA',
    'blob:abc',
    'DATA:image/png;base64,AA',
  ])
    expect(isExternalPhoto(url), url).toBe(false);

  // Vista previa (localOnly): ningún servidor externo, jamás.
  expect(resolvePhoto(CDN, { localOnly: true, photoBase: BASE })).toBe('');
  expect(resolvePhoto('//cdn.example/a.webp', { localOnly: true })).toBe('');
  // Fuera de la vista previa, la URL externa se respeta (el API real las devuelve así).
  expect(resolvePhoto(CDN)).toBe(CDN);
  // Vacío o con espacios = sin foto.
  expect(resolvePhoto('', { localOnly: true })).toBe('');
  expect(resolvePhoto('   ', { localOnly: true })).toBe('');
  expect(resolvePhoto(undefined)).toBe('');
  expect(resolvePhoto(null)).toBe('');
  // data: y blob: viajan tal cual.
  expect(resolvePhoto('data:image/webp;base64,AAAA', { localOnly: true, photoBase: BASE })).toBe(
    'data:image/webp;base64,AAAA',
  );
  // Ruta propia: se resuelve contra la carpeta de la página, con o sin barra inicial.
  expect(resolvePhoto('photos/JF-MAR-002.thumb.webp', { localOnly: true, photoBase: BASE })).toBe(
    'https://visor.example/x/y/z/photos/JF-MAR-002.thumb.webp',
  );
  expect(resolvePhoto('/photos/JF-MAR-002.thumb.webp', { localOnly: true, photoBase: BASE })).toBe(
    'https://visor.example/x/y/z/photos/JF-MAR-002.thumb.webp',
  );
  // En la raíz, y en una carpeta con espacio (ya codificada por el navegador).
  expect(resolvePhoto('photos/a.webp', { photoBase: 'https://h.example/' })).toBe(
    'https://h.example/photos/a.webp',
  );
  expect(resolvePhoto('photos/a.webp', { photoBase: 'https://h.example/mi%20vista/' })).toBe(
    'https://h.example/mi%20vista/photos/a.webp',
  );
  // Sin carpeta conocida, queda relativa (el navegador la resuelve contra la página).
  expect(resolvePhoto('/photos/a.webp', { localOnly: true })).toBe('photos/a.webp');
  // Una carpeta de página inválida no rompe: sin foto.
  expect(resolvePhoto('photos/a.webp', { photoBase: 'no es una url' })).toBe('');
}

describe('fotos de la vista previa', () => {
  afterAll(cleanMutants);

  it('solo fotos propias, resueltas contra la carpeta de la página', () => photoSuite(photos));

  it('detecta cada mutación de la política de fotos', async () => {
    const file = new URL('../src/photos.ts', import.meta.url).pathname;
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      [
        'la URL con // ya no es externa',
        [[String.raw`/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i`, String.raw`/^(?:[a-z][a-z0-9+.-]*:)/i`]],
      ],
      ['localOnly deja pasar el CDN', [["return policy.localOnly ? '' : url;", 'return url;']]],
      ['data: y blob: se tratan como externos', [[String.raw`/^(data|blob):/i.test(u)`, 'false']]],
      ['no se quita la barra inicial', [[String.raw`url.replace(/^\/+/, '')`, 'url']]],
      [
        'se ignora la carpeta de la página',
        [['new URL(relative, policy.photoBase).href', 'relative']],
      ],
      [
        'el nombre de la miniatura cambia',
        [['`photos/${sku}.thumb.webp`', '`photos/${sku}.webp`']],
      ],
      [
        'una carpeta inválida devuelve la ruta',
        [[`    return '';\n  }\n}`, `    return relative;\n  }\n}`]],
      ],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<typeof photos>(file, edits);
      expectKilled(name, () => photoSuite(mutant));
    }
  });
});

describe('catálogo de la vista previa: fotos por variante', () => {
  const root = new URL('../../../data/catalog/', import.meta.url).pathname;
  const catalogCsv = readFileSync(`${root}products.seed.csv`, 'utf8');
  const categories = JSON.parse(readFileSync(`${root}categories.json`, 'utf8')) as {
    slug: string;
    name: string;
  }[];
  const withPhoto = ['JF-MAR-002', 'JF-RES-001'];
  const seeds = withPhoto.map((sku) => ({
    sku,
    url: `photos/${sku}.thumb.webp`,
    illustrative: true,
  }));
  /** El CSV con la foto "real" (no ilustrativa) de un SKU apuntando a otro servidor. */
  const withExternalPhoto = (sku: string, url: string, from = catalogCsv) => {
    const rows = parseCsv(from);
    const h = rows[0]!;
    return toCsv(
      rows.map((r, i) => {
        if (i === 0 || r[0] !== sku) return r;
        const copy = [...r];
        copy[h.indexOf('foto')] = url;
        copy[h.indexOf('foto_ilustrativa')] = 'no';
        return copy;
      }),
    );
  };
  const build = (opts: object = {}) =>
    buildCatalog({
      baseUrl: 'https://demo.jellyfish.local',
      catalogCsv,
      categories,
      photos: seeds,
      localPhotosOnly: true,
      photoBase: BASE,
      ...opts,
    });

  it('la foto de cada variante es photos/<sku>.thumb.webp resuelta contra la base; sin archivo, vacía', () => {
    const catalog = build();
    for (const v of catalog.variantsById.values()) {
      if (withPhoto.includes(v.sku)) {
        expect(v.photo, v.sku).toBe(`${BASE}photos/${v.sku}.thumb.webp`);
        expect(v.photoIllustrative).toBe(true);
      } else {
        expect(v.photo, `${v.sku} no tiene archivo local`).toBe('');
      }
    }
    expect([...catalog.variantsById.values()].filter((v) => v.photo).length).toBe(withPhoto.length);
  });

  it('photoThumb deja intactas las rutas locales (la app no las convierte a _min.webp del CDN)', () => {
    for (const v of build().variantsById.values()) expect(photoThumb(v.photo)).toBe(v.photo);
  });

  it('ninguna variante apunta a otro origen, ni siquiera si el CSV trae una foto real de otro servidor', () => {
    const catalog = build({
      catalogCsv: withExternalPhoto('JF-RES-001', 'https://cdn.example/real.jpg'),
    });
    for (const v of catalog.variantsById.values()) {
      if (v.photo) expect(new URL(v.photo).origin, v.sku).toBe('https://visor.example');
    }
    // La foto propia del manifiesto es la que se sirve (y es ilustrativa: así lo dice el manifiesto).
    const res = [...catalog.variantsById.values()].find((v) => v.sku === 'JF-RES-001')!;
    expect(res.photo).toBe(`${BASE}photos/JF-RES-001.thumb.webp`);
    expect(res.photoIllustrative).toBe(true);
  });

  it('la huella del catálogo no cambia si la página cambia de carpeta (el estado guardado no se pierde)', () => {
    const a = build({ photoBase: 'https://visor.example/a/' }).signature;
    const b = build({ photoBase: 'https://otro.example/b/c/' }).signature;
    expect(a).toBe(b);
    // …pero sí cambia si cambia qué fotos hay.
    expect(build({ photos: [] }).signature).not.toBe(a);
  });

  afterAll(cleanMutants);

  it('detecta mutaciones del catálogo: foto del CSV, carpeta ignorada o huella con la carpeta', async () => {
    const file = new URL('../src/catalog.ts', import.meta.url).pathname;
    const suite = (api: { buildCatalog: typeof buildCatalog }) => {
      // Una variante con manifiesto y otra SIN manifiesto, las dos con una foto real del CSV en otro servidor.
      const csv = withExternalPhoto(
        'JF-AVE-001',
        'https://cdn.example/otra.jpg',
        withExternalPhoto('JF-RES-001', 'https://cdn.example/real.jpg'),
      );
      const catalog = api.buildCatalog({
        baseUrl: 'https://demo.jellyfish.local',
        catalogCsv: csv,
        categories,
        photos: seeds,
        localPhotosOnly: true,
        photoBase: BASE,
      });
      for (const v of catalog.variantsById.values()) {
        expect(
          v.photo.startsWith('https://cdn.example'),
          `${v.sku} no puede servir fotos de otro servidor`,
        ).toBe(false);
      }
      const byPhoto = (sku: string) =>
        [...catalog.variantsById.values()].find((v) => v.sku === sku)!;
      expect(byPhoto('JF-MAR-002').photo).toBe(`${BASE}photos/JF-MAR-002.thumb.webp`);
      // La foto "real" del CSV apunta a otro servidor: se sirve la propia del manifiesto, no se queda sin foto.
      expect(byPhoto('JF-RES-001').photo).toBe(`${BASE}photos/JF-RES-001.thumb.webp`);
      // …y como es la ilustración del manifiesto (no la foto real del CSV), se rotula "Imagen ilustrativa".
      expect(byPhoto('JF-RES-001').photoIllustrative).toBe(true);
      // Sin foto propia, la variante queda sin foto (nunca la del otro servidor).
      expect(byPhoto('JF-AVE-001').photo).toBe('');
      const other = api.buildCatalog({
        baseUrl: 'https://demo.jellyfish.local',
        catalogCsv,
        categories,
        photos: seeds,
        localPhotosOnly: true,
        photoBase: 'https://x.example/q/',
      });
      const same = api.buildCatalog({
        baseUrl: 'https://demo.jellyfish.local',
        catalogCsv,
        categories,
        photos: seeds,
        localPhotosOnly: true,
        photoBase: BASE,
      });
      expect(other.signature).toBe(same.signature);
    };
    suite({ buildCatalog });
    const mutants: [string, Parameters<typeof loadMutant>[1]][] = [
      [
        'la foto del CSV cuenta en la vista previa',
        [['!options.localPhotosOnly && item.photo !== ', 'item.photo !== ']],
      ],
      [
        'una variante sin foto propia sirve la foto de otro servidor del CSV',
        [
          ['localOnly: options.localPhotosOnly,', 'localOnly: false,'],
          [
            `const photoSource = options.localPhotosOnly
        ? (manifest?.url ?? '')
        : keepOwn`,
            `const photoSource = keepOwn`,
          ],
        ],
      ],
      [
        'la carpeta de la página no se pasa a resolvePhoto',
        [['photoBase: options.photoBase,', 'photoBase: undefined,']],
      ],
      ['la huella usa la foto ya resuelta', [['v.price, v.photoSource]', 'v.price, v.photo]']]],
    ];
    for (const [name, edits] of mutants) {
      const mutant = await loadMutant<{ buildCatalog: typeof buildCatalog }>(file, edits);
      expectKilled(name, () => suite(mutant));
    }
  });
});
