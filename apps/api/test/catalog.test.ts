import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { type DbHandle, createPgliteDb } from '../src/db/client';
import { products, variants } from '../src/db/schema';
import { getProduct, importCatalog, listProducts, syncCategories } from '../src/services/catalog';
import { catalogDir, categoriesJson } from './helpers';

describe('catálogo semilla en la base de datos', () => {
  let handle: DbHandle;
  const seed = readFileSync(`${catalogDir}/products.seed.csv`, 'utf8');

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

  it('importa los 112 artículos en 98 productos', async () => {
    const result = await importCatalog(handle.db, seed);
    expect(result).toMatchObject({
      ok: true,
      productsCreated: 98,
      variantsCreated: 112,
      variantsUpdated: 0,
    });
    expect(await countRows()).toEqual({ products: 98, variants: 112 });
  });

  it('es idempotente: reimportar no duplica nada', async () => {
    const again = await importCatalog(handle.db, seed);
    expect(again).toMatchObject({
      ok: true,
      productsCreated: 0,
      variantsCreated: 0,
      variantsUpdated: 112,
    });
    expect(await countRows()).toEqual({ products: 98, variants: 112 });
  });

  it('el modo prueba no escribe', async () => {
    const extra =
      seed + 'ZZZ-1,zzz,Producto nuevo,,res,Parrilla,lb,0.5,1,,100,usuario,,,,0,si,si,,,,,si\n';
    const dry = await importCatalog(handle.db, extra, { dryRun: true });
    expect(dry).toMatchObject({ ok: true, dryRun: true, variantsCreated: 1 });
    expect(await countRows()).toEqual({ products: 98, variants: 112 });
  });

  it('ningún artículo de la semilla es visible para clientes (producción)', async () => {
    const { items, total } = await listProducts(handle.db, false);
    expect(total).toBe(0);
    expect(items).toEqual([]);
  });

  it('en modo demo se ven los 98 productos, marcados como no confirmados', async () => {
    const all = await listProducts(handle.db, true, { limit: 100 });
    expect(all.total).toBe(98);
    expect(all.items).toHaveLength(98);
    expect(all.items.every((p) => p.variants.every((v) => v.unconfirmed || v.itbisBps === 0))).toBe(
      true,
    );
  });

  it('ordena por categoría y pagina', async () => {
    const page1 = await listProducts(handle.db, true, { limit: 10 });
    const page2 = await listProducts(handle.db, true, { limit: 10, offset: 10 });
    expect(page1.items[0]!.category).toBe('res');
    expect(new Set([...page1.items, ...page2.items].map((p) => p.group)).size).toBe(20);
  });

  it('busca por nombre, sinónimo dominicano y calibre', async () => {
    const names = async (q: string) =>
      (await listProducts(handle.db, true, { q })).items.map((p) => p.group);
    expect(await names('pernil')).toContain('pierna-cerdo'); // sinónimo
    expect(await names('lomito')).toContain('filete-res'); // sinónimo
    expect(await names('chillo')).toEqual(
      expect.arrayContaining(['chillo-entero', 'filete-chillo']),
    );
    expect(await names('16/20')).toEqual(['camaron-crudo']); // calibre en la variante
    expect(await names('langosta')).toEqual(
      expect.arrayContaining(['cola-langosta', 'langosta-entera']),
    );
  });

  it('un % o _ en la búsqueda no es un comodín', async () => {
    expect((await listProducts(handle.db, true, { q: '%' })).total).toBe(0);
    expect((await listProducts(handle.db, true, { q: '_' })).total).toBe(0);
  });

  it('agrupa las variantes de camarón por calibre y calcula "desde"', async () => {
    const { variants: vs, fromPrice } = await getProduct(handle.db, true, 'camaron-crudo');
    expect(vs.map((v) => v.variant)).toEqual([
      '51/60',
      '41/50',
      '31/40',
      '26/30',
      '21/25',
      '16/20',
    ]); // por precio
    expect(fromPrice).toBe(38_000);
  });

  it('conserva los precios ancla en centavos exactos', async () => {
    const { variants: vs } = await getProduct(handle.db, true, 'pechuga-deshuesada');
    expect(vs[0]!.price).toBe(17_495);
    const molida = await getProduct(handle.db, true, 'molida-res');
    expect(molida.variants.map((v) => v.price)).toEqual([22_900, 29_995]);
  });
});
