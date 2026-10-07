import { readFileSync } from 'node:fs';
import { parseCatalogCsv } from '@jellyfish/catalog';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { type DbHandle, createPgliteDb } from '../src/db/client';
import { products, variants } from '../src/db/schema';
import {
  getProduct,
  importCatalog,
  listCategories,
  listProducts,
  syncCategories,
} from '../src/services/catalog';
import { catalogDir, categoriesJson } from './helpers';

describe('catálogo del negocio en la base de datos', () => {
  let handle: DbHandle;
  const seed = readFileSync(`${catalogDir}/products.seed.csv`, 'utf8');
  const parsed = parseCatalogCsv(seed, { categories: categoriesJson.map((c) => c.slug) });
  const expected = {
    products: new Set(parsed.items.map((i) => i.group)).size,
    variants: parsed.items.length,
  };

  beforeAll(async () => {
    handle = await createPgliteDb();
    await syncCategories(handle.db, categoriesJson);
  });
  afterAll(() => handle.close());

  const countRows = async () => {
    const [p] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(products);
    const [v] = await handle.db.select({ n: sql<number>`count(*)::int` }).from(variants);
    return { products: p!.n, variants: v!.n };
  };

  it('la semilla no trae errores y tiene un volumen razonable', () => {
    expect(parsed.errors).toEqual([]);
    expect(expected.variants).toBeGreaterThanOrEqual(30);
    expect(expected.products).toBeGreaterThanOrEqual(25);
  });

  it('importa todos los artículos agrupados en productos', async () => {
    const result = await importCatalog(handle.db, seed);
    expect(result).toMatchObject({
      ok: true,
      productsCreated: expected.products,
      variantsCreated: expected.variants,
      variantsUpdated: 0,
    });
    expect(await countRows()).toEqual(expected);
  });

  it('es idempotente: reimportar no duplica nada', async () => {
    const again = await importCatalog(handle.db, seed);
    expect(again).toMatchObject({
      ok: true,
      productsCreated: 0,
      variantsCreated: 0,
      variantsUpdated: expected.variants,
    });
    expect(await countRows()).toEqual(expected);
  });

  it('el modo prueba no escribe', async () => {
    const extra =
      seed + 'ZZZ-1,zzz,Producto nuevo,,res,Parrilla,lb,0.5,1,,100,usuario,,,,0,si,si,,,,,si\n';
    const dry = await importCatalog(handle.db, extra, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true, variantsCreated: 1 });
    expect(await countRows()).toEqual(expected);
  });

  it('todo el catálogo tiene precio confirmado e ITBIS definido, así que se publica', async () => {
    const { items, total } = await listProducts(handle.db, false, { limit: 100 });
    expect(total).toBe(expected.products);
    expect(items).toHaveLength(expected.products);
    for (const p of items) {
      for (const v of p.variants) {
        expect(v.unconfirmed, v.sku).toBe(false);
        expect([0, 1800], v.sku).toContain(v.itbisBps);
      }
    }
  });

  it('sin existencias cargadas, los artículos se ven pero como agotados', async () => {
    const { items } = await listProducts(handle.db, false, { limit: 100 });
    expect(items.every((p) => p.variants.every((v) => !v.inStock && v.available === 0))).toBe(true);
  });

  it('un precio estimado o un ITBIS sin confirmar sigue oculto a los clientes', async () => {
    const extra =
      'ZZZ-1,zzz-estimado,Producto estimado,,res,Parrilla,lb,0.5,1,,100,estimado,,,,0,si,si,,,,,si\n' +
      'ZZZ-2,zzz-sin-itbis,Producto sin ITBIS,,res,Parrilla,lb,0.5,1,,100,usuario,,,,,si,si,,,,,si\n';
    await importCatalog(handle.db, seed + extra);
    const hidden = await listProducts(handle.db, false, { q: 'Producto', limit: 100 });
    expect(hidden.items.map((p) => p.group)).toEqual([]);
    const demo = await listProducts(handle.db, true, { q: 'Producto', limit: 100 });
    expect(demo.items.map((p) => p.group).sort()).toEqual(['zzz-estimado', 'zzz-sin-itbis']);
    await handle.db.execute(sql`delete from variants where sku like 'ZZZ-%'`);
    await handle.db.execute(sql`delete from products where "group" like 'zzz-%'`);
    expect(await countRows()).toEqual(expected);
  });

  it('ordena por categoría y pagina', async () => {
    const page1 = await listProducts(handle.db, false, { limit: 10 });
    const page2 = await listProducts(handle.db, false, { limit: 10, offset: 10 });
    expect(page1.items[0]!.category).toBe('res');
    expect(new Set([...page1.items, ...page2.items].map((p) => p.group)).size).toBe(20);
  });

  it('busca por nombre, sinónimo dominicano y calibre', async () => {
    const names = async (q: string) =>
      (await listProducts(handle.db, false, { q })).items.map((p) => p.group);
    expect(await names('pernil')).toContain('paleta-de-cerdo'); // sinónimo
    expect(await names('lomito')).toContain('lomo-de-cerdo'); // sinónimo
    expect(await names('picanha')).toEqual(['picana-choice']); // sinónimo y sin acento
    expect(await names('chillo')).toEqual(['filete-de-chillo']);
    expect(await names('16/20')).toEqual(['camaron']); // calibre en la variante
    expect(await names('alitas')).toEqual(['alas-de-pollo']);
    expect(await names('bacon')).toEqual(['tocineta']);
  });

  it('un % o _ en la búsqueda no es un comodín', async () => {
    expect((await listProducts(handle.db, false, { q: '%' })).total).toBe(0);
    expect((await listProducts(handle.db, false, { q: '_' })).total).toBe(0);
  });

  it('agrupa las variantes de camarón por calibre y calcula "desde"', async () => {
    const { variants: vs, fromPrice } = await getProduct(handle.db, false, 'camaron');
    expect(vs.map((v) => v.variant).sort()).toEqual(['16/20', '21/25', '51/60 crudo', '8/12']);
    const prices = vs.map((v) => v.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b)); // ordenadas por precio
    expect(fromPrice).toBe(prices[0]);
  });

  it('el ITBIS sigue el asterisco del listado: mariscos con ITBIS, carnes exentas', async () => {
    const camaron = await getProduct(handle.db, false, 'camaron');
    expect(camaron.variants.every((v) => v.itbisBps === 1800)).toBe(true);
    const ribeye = await getProduct(handle.db, false, 'ribeye-choice');
    expect(ribeye.variants.every((v) => v.itbisBps === 0)).toBe(true);
  });

  it('la API pública solo muestra categorías que tienen productos', async () => {
    const visible = await listCategories(handle.db, { visibleOnly: true, demo: false });
    expect(visible.map((c) => c.slug)).toEqual([
      'res',
      'cerdo',
      'aves',
      'pescados',
      'mariscos',
      'otros',
    ]);
    const all = await listCategories(handle.db);
    expect(all.map((c) => c.slug)).toContain('combos');
  });
});
