/**
 * Recorrido del panel de administración en Chromium contra el API real (SIN modo demo, para
 * ejercitar la regla de publicación: activo, precio no estimado e ITBIS definido).
 *
 * Parte del catálogo sembrado (data/catalog/products.seed.csv): todo publicado y sin existencias.
 * Las cifras esperadas salen de ese archivo al correr, no están escritas aquí; lo que el script
 * inventa (precios, lotes, cupón, motivos) es de prueba.
 *
 *   npx tsx scripts/e2e-admin.ts          (capturas en tmp/e2e-admin)
 *   E2E_SKIP_BUILD=1 …                    (reutiliza el panel ya compilado en tmp/e2e-admin-site)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CatalogItem, parseCatalogCsv } from '@jellyfish/catalog';
import {
  type AdminSummaryDTO,
  type AdminVariantDTO,
  type AuditPageDTO,
  type CouponDTO,
  type OrderDTO,
  type ProductListDTO,
  type QuoteDTO,
  type StockLotDTO,
  formatDOP,
} from '@jellyfish/shared';
import { type BrowserContext, type Page, chromium } from 'playwright-core';
import {
  CHROME,
  apiLog,
  apiLogin,
  check,
  log,
  otpFor,
  root,
  run,
  serveStatic,
  sleep,
  start,
  stopAll,
  waitFor,
} from './e2e-lib';

const OUT = resolve(process.env.E2E_OUT ?? `${root}/tmp/e2e-admin`);
// El panel se compila aparte de apps/admin/dist: otros recorridos lo recompilan con su propia URL del API.
const SITE = resolve(process.env.E2E_SITE ?? `${root}/tmp/e2e-admin-site`);
const API_PORT = 3997;
const WEB_PORT = 8090;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const ADMIN_PHONE = '809-555-0100';
const DRIVER_PHONE = '849-555-0177';
const STAFF_PHONE = '829-555-0133';
const CUSTOMER_PHONE = '829-555-0222';
const CUSTOMER2_PHONE = '849-555-0444';
mkdirSync(OUT, { recursive: true });

// Artículos del catálogo sembrado que usa el recorrido (se comprueba que sigan existiendo).
const ORDER_SKU = 'JF-AVE-003'; // pechuga de pollo: un solo artículo, por libra, peso variable
const SOLO_SKU = 'JF-AVE-004'; // pavo entero: un solo artículo, para ver desaparecer la ficha
const MULTI_SKU = 'JF-MAR-003'; // camarón 21/25: ficha con varios artículos
const PRICE_SKU = 'JF-AVE-001'; // alitas: para cambiar el precio
const STOCK_SKU = 'JF-CDO-001'; // lomo de cerdo: existencias sin lote
const EXPIRED_SKU = 'JF-CDO-005'; // chuleta: el lote vencido

const COUPON = 'E2E10';
const LOT_SOON = 'E2E-POR-VENCER';
const LOT_EXPIRED = 'E2E-VENCIDO';
const OVERRIDE_REASON = 'El cliente no estaba; recibió su vecino';
const PHOTO_PATH = `/photos/${ORDER_SKU}.thumb.webp`;
// Las fotos del catálogo sembrado viven en un CDN externo: aquí se responde con una imagen mínima.
const CDN_HOST = /d8j0ntlcm91z4\.cloudfront\.net/;
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
// Chromium anota como error de consola la respuesta 409 de entregar sin registrar el cobro (esperada).
const EXPECTED_REJECTION = /Failed to load resource: the server responded with a status of 409\b/;

const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(name);
  log(`captura ${name}.png`);
}

// ───────────── Auxiliares ─────────────

const e164 = (phone: string) => `+1${phone.replace(/\D/g, '').slice(-10)}`;
const pesos = (centavos: number) => (centavos / 100).toFixed(2);
const DAY_MS = 86_400_000;
/** "AAAA-MM-DD" de hoy en República Dominicana (UTC-4) desplazado `days` días. */
const rdDate = (days = 0) =>
  new Date(Date.now() - 4 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);

async function http<T>(
  path: string,
  token?: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/** Repite hasta que `fn` devuelva algo (la bitácora y los refrescos del panel no son instantáneos). */
async function until<T>(
  what: string,
  fn: () => Promise<T | false | null | undefined>,
  ms = 15_000,
) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn();
    if (got) return got;
    if (Date.now() > end) throw new Error(`✖ No ocurrió a tiempo: ${what}`);
    await sleep(300);
  }
}

const nav = (page: Page, label: string) =>
  page
    .locator('.nav')
    .getByRole('link', { name: new RegExp(`^${label}`) })
    .click();

const statValue = (page: Page, label: string) =>
  page.getByTestId(`stat-${label}`).locator('.value').innerText();

const adminToken = (page: Page) =>
  page.evaluate(() => localStorage.getItem('jellyfish.admin.token')) as Promise<string>;

async function signIn(page: Page, phone: string) {
  await page.goto(WEB);
  await page.getByTestId('login-phone').fill(phone);
  await page.getByTestId('login-send').click();
  await page.getByTestId('login-code').fill(await otpFor(e164(phone)));
  await page.getByTestId('login-verify').click();
}

/** Lee todas las páginas de la bitácora (más recientes primero). */
async function auditEntries(token: string, action?: string) {
  const items: AuditPageDTO['items'] = [];
  let before: string | null = null;
  do {
    const q: string = `limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const r: { status: number; body: AuditPageDTO } = await http(`/v1/admin/audit?${q}`, token);
    if (r.status !== 200) throw new Error(`✖ GET /v1/admin/audit respondió ${r.status}`);
    items.push(...r.body.items);
    before = r.body.nextCursor;
  } while (before);
  return items;
}

/** La paginación de la bitácora necesita más de 50 movimientos: se completan con cambios inocuos. */
async function padAudit(token: string, variantId: string, min: number) {
  for (let n = (await auditEntries(token)).length; n < min; n++) {
    await http(`/v1/admin/variants/${variantId}`, token, {
      method: 'PATCH',
      body: { priceNote: `Prueba e2e ${n}` },
    });
  }
  await until('la bitácora asienta los cambios', async () =>
    (await auditEntries(token)).length >= min ? true : false,
  );
}

const SECRET_KEYS =
  /^(code|otp|pin|token|password|secret|authorization|cookie|apikey|deliverypin)$/;
const FULL_PHONE = /(?:\+?1)?8[024]9\d{7}\b/;
/** Claves y valores que jamás deben estar en lo que guarda la bitácora. */
function leaksIn(value: unknown, secrets: ReadonlySet<string>, path = '$'): string[] {
  if (typeof value === 'string') {
    if (secrets.has(value) || /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value) || FULL_PHONE.test(value))
      return [`${path} = ${value.slice(0, 12)}…`];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => leaksIn(v, secrets, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(SECRET_KEYS.test(k.toLowerCase().replace(/[^a-z0-9]/g, '')) ? [`${path}.${k}`] : []),
      ...leaksIn(v, secrets, `${path}.${k}`),
    ]);
  }
  return [];
}

// ───────────── Catálogo sembrado (la fuente de las cifras esperadas) ─────────────

function loadSeed(): CatalogItem[] {
  const categories = JSON.parse(readFileSync(`${root}/data/catalog/categories.json`, 'utf8')) as {
    slug: string;
  }[];
  const parsed = parseCatalogCsv(readFileSync(`${root}/data/catalog/products.seed.csv`, 'utf8'), {
    categories: categories.map((c) => c.slug),
  });
  if (parsed.errors.length > 0) {
    throw new Error(`✖ products.seed.csv tiene errores: ${JSON.stringify(parsed.errors[0])}`);
  }
  return parsed.items;
}

async function main() {
  const seed = loadSeed();
  const seedOf = (sku: string) => {
    const item = seed.find((i) => i.sku === sku);
    if (!item) throw new Error(`✖ El catálogo sembrado ya no trae ${sku}; ajusta el recorrido`);
    return item;
  };
  const groups = new Set(seed.map((i) => i.group));
  check(
    seed.every((i) => i.active && i.priceSource === 'usuario' && i.itbisBps !== null),
    `el catálogo sembrado (${seed.length} artículos en ${groups.size} fichas) es todo publicable sin modo demo`,
  );
  const orderItem = seedOf(ORDER_SKU);
  const soloItem = seedOf(SOLO_SKU);
  const multiItem = seedOf(MULTI_SKU);
  const priceItem = seedOf(PRICE_SKU);
  const stockItem = seedOf(STOCK_SKU);
  const expiredItem = seedOf(EXPIRED_SKU);
  check(
    seed.filter((i) => i.group === soloItem.group).length === 1 &&
      seed.filter((i) => i.group === multiItem.group).length > 1,
    'el recorrido tiene una ficha de un solo artículo y otra con varios',
  );

  log('Iniciando API (sin modo demo) con administrador inicial…');
  const apiEnv = {
    JELLYFISH_SEED: '1',
    PORT: String(API_PORT),
    BOOTSTRAP_ADMIN_PHONE: ADMIN_PHONE,
    PUBLIC_API_URL: API,
    // Nada del entorno puede encender el modo demo ni cambiar la base.
    JELLYFISH_DEMO: undefined,
    DEMO_OTP_CODE: undefined,
    DATABASE_URL: undefined,
    PGLITE_DIR: undefined,
  };
  start('npx', ['tsx', 'apps/api/src/server.ts'], apiEnv, root, true);
  await waitFor(`${API}/health`);

  if (process.env.E2E_SKIP_BUILD !== '1' || !existsSync(`${SITE}/index.html`)) {
    log('Compilando el panel…');
    await run('npx', ['vite', 'build', '--outDir', SITE, '--emptyOutDir'], `${root}/apps/admin`, {
      VITE_API_URL: API,
    });
  }
  const server = serveStatic(SITE, WEB_PORT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const errors: string[] = [];
  const tolerated: string[] = [];
  let page: Page | null = null;

  const watch = async (ctx: BrowserContext) => {
    await ctx.route(CDN_HOST, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
    );
    ctx.on('page', (p) => {
      p.on('pageerror', (e) => errors.push(e.message));
      p.on('console', (m) => {
        const text = m.text();
        if (m.type() !== 'error' || /favicon/.test(text)) return;
        if (EXPECTED_REJECTION.test(text)) tolerated.push(text);
        else errors.push(text);
      });
    });
  };

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
      acceptDownloads: true,
    });
    await watch(ctx);
    page = await ctx.newPage();

    // Todo lo que se comprueba por API usa estos ayudantes (la tienda pública no pide sesión).
    const store = async (query = '') => {
      const r = await http<ProductListDTO>(`/v1/products?limit=100${query}`);
      return { ...r.body, variants: r.body.items.flatMap((p) => p.variants) };
    };
    const adminCatalog = async () =>
      (await http<AdminVariantDTO[]>('/v1/admin/catalog', await adminToken(page!))).body;
    const adminSummary = async () =>
      (await http<AdminSummaryDTO>('/v1/admin/summary', await adminToken(page!))).body;
    const idOf = async (sku: string) => {
      const row = (await adminCatalog()).find((v) => v.sku === sku);
      if (!row) throw new Error(`✖ ${sku} no está en el catálogo del panel`);
      return row.id;
    };

    // ───── Acceso ─────
    await page.goto(WEB);
    await page.getByText('Panel de administración').waitFor({ timeout: 20_000 });
    await shot(page, '01-login');
    await page.getByTestId('login-phone').fill(ADMIN_PHONE);
    await page.getByTestId('login-send').click();
    await page.getByTestId('login-code').fill(await otpFor(e164(ADMIN_PHONE)));
    await page.getByTestId('login-verify').click();
    await page.getByRole('heading', { name: 'Resumen' }).waitFor({ timeout: 15_000 });
    for (const link of ['Cupones', 'Zonas de entrega', 'Equipo', 'Bitácora', 'Lista de precios']) {
      await page.locator('.nav').getByRole('link', { name: link }).waitFor();
    }
    check(true, 'el administrador entra al panel y ve todo el menú, con Cupones y Bitácora');

    // ───── Resumen inicial: todo publicado, nada en el congelador ─────
    check(
      (await page.getByText('Ningún producto está publicado todavía').count()) === 0,
      'con el catálogo sembrado el panel no avisa de "nada publicado"',
    );
    check(
      (await statValue(page, 'Catálogo sin publicar')) === '0' &&
        (await page.getByTestId('stat-Catálogo sin publicar').innerText()).includes(
          `de ${seed.length} artículos`,
        ),
      `el resumen muestra 0 artículos sin publicar de ${seed.length}`,
    );
    check(
      (await statValue(page, 'Sin existencias')) === String(seed.length),
      'sin recibir mercancía, todos los artículos aparecen sin existencias',
    );
    check(
      (await page.getByTestId('alert-expiring').count()) === 0 &&
        (await page.getByTestId('alert-expired').count()) === 0,
      'sin lotes no hay alertas de vencimiento en el resumen',
    );
    await shot(page, '02-resumen');

    const summary0 = await adminSummary();
    check(
      summary0.catalog.variants === seed.length && summary0.catalog.blocked === 0,
      'el API resume el catálogo igual que el panel',
    );
    const store0 = await store();
    const bySku = new Map(store0.variants.map((v) => [v.sku, v]));
    check(
      store0.demo === false &&
        store0.total === groups.size &&
        store0.variants.length === seed.length &&
        seed.every((i) => {
          const v = bySku.get(i.sku);
          return v && v.price === i.price && v.itbisBps === i.itbisBps && !v.unconfirmed;
        }),
      `la tienda pública publica las ${groups.size} fichas y los ${seed.length} artículos, con el precio e ITBIS del catálogo sembrado`,
    );
    const publicCategories = (await http<{ slug: string }[]>('/v1/categories')).body.map(
      (c) => c.slug,
    );
    check(
      [...new Set(seed.map((i) => i.category))].every((c) => publicCategories.includes(c)),
      'la tienda pública muestra todas las categorías con productos',
    );

    // ───── Un cliente sin permiso no entra ─────
    const other = await browser.newContext({
      viewport: { width: 1100, height: 800 },
      colorScheme: 'dark',
    });
    await watch(other);
    const p2 = await other.newPage();
    await signIn(p2, '829-555-0111');
    await p2.getByText('no tiene acceso al panel').waitFor();
    check(true, 'un cliente que intenta entrar al panel es rechazado con un mensaje claro');
    await other.close();

    // ───── Catálogo: los artículos sembrados y su bloqueo/desbloqueo ─────
    await nav(page, 'Catálogo y precios');
    await page.getByTestId(`row-${orderItem.sku}`).waitFor();
    check(
      (await page.locator('[data-testid^="row-"]').count()) === seed.length &&
        (await page.getByText(`${seed.length} artículos`, { exact: true }).isVisible()),
      `el catálogo lista los ${seed.length} artículos del catálogo sembrado`,
    );
    const mismatched = await page.evaluate(
      (rows) =>
        rows
          .filter((r) => {
            const tr = document.querySelector(`[data-testid="row-${r.sku}"]`);
            if (!tr) return true;
            const price = (tr.querySelector(`[data-testid="price-${r.sku}"]`) as HTMLInputElement)
              .value;
            const itbis = (tr.querySelector(`[data-testid="itbis-${r.sku}"]`) as HTMLSelectElement)
              .value;
            const text = tr.textContent ?? '';
            return (
              price !== r.price ||
              itbis !== r.itbis ||
              !text.includes('Confirmado') ||
              !text.includes('Publicado')
            );
          })
          .map((r) => r.sku),
      seed.map((i) => ({ sku: i.sku, price: pesos(i.price), itbis: String(i.itbisBps) })),
    );
    check(
      mismatched.length === 0,
      `cada artículo se ve Confirmado y Publicado con el precio e ITBIS del catálogo sembrado${mismatched.length ? ` (difieren: ${mismatched.join(', ')})` : ''}`,
    );
    check(
      (await page.getByText('Solo sin publicar (0)').isVisible()) &&
        (await page.locator('.nav a[href="/catalogo"] .count').count()) === 0,
      'ni el filtro ni el menú marcan artículos sin publicar',
    );
    await shot(page, '03-catalogo');

    // Desactivar el único artículo de una ficha la saca de la tienda y lo marca en el resumen.
    const soloRow = page.getByTestId(`row-${soloItem.sku}`);
    await soloRow.getByRole('checkbox').click();
    await soloRow.getByText('Sin publicar').waitFor();
    check(
      (await soloRow.innerText()).includes('Inactivo'),
      'al desactivar el pavo, el catálogo lo marca "Sin publicar · Inactivo"',
    );
    await until('el pavo sale de la tienda', async () =>
      (await store()).variants.every((v) => v.sku !== soloItem.sku),
    );
    check(
      (await http(`/v1/products/${soloItem.group}`)).status === 404 &&
        (await store()).total === groups.size - 1,
      'la ficha del pavo desaparece de la tienda pública (404) y quedan una ficha menos',
    );
    const blockedQuote = await http<{ error: { code: string } }>('/v1/quote', undefined, {
      method: 'POST',
      body: { items: [{ variantId: await idOf(soloItem.sku), quantity: 800 }] },
    });
    check(
      blockedQuote.status === 409 && blockedQuote.body.error.code === 'unavailable',
      'cotizar el artículo bloqueado se rechaza con "no está disponible"',
    );
    check(
      (await page.locator('.nav a[href="/catalogo"] .count').innerText()) === '1',
      'el menú del Catálogo marca 1 artículo sin publicar',
    );
    await page.getByTestId('blocked-only').check();
    await page.getByText('Solo sin publicar (1)').waitFor();
    check(
      (await page.locator('[data-testid^="row-"]').count()) === 1,
      '"Solo sin publicar" deja únicamente el artículo bloqueado',
    );
    await shot(page, '04-catalogo-bloqueado');
    await nav(page, 'Resumen');
    await page
      .getByTestId('stat-Catálogo sin publicar')
      .locator('.value', { hasText: /^1$/ })
      .waitFor();
    check(true, 'el bloqueo reaparece en el resumen: Catálogo sin publicar = 1');
    await nav(page, 'Catálogo y precios');
    await page.getByTestId(`row-${soloItem.sku}`).getByRole('checkbox').click();
    await page.getByTestId(`row-${soloItem.sku}`).getByText('Publicado').waitFor();
    await until('el pavo vuelve a la tienda', async () =>
      (await store()).variants.some((v) => v.sku === soloItem.sku),
    );
    check(true, 'al reactivarlo, el pavo vuelve a estar publicado en la tienda');

    // ITBIS por confirmar bloquea solo ese artículo; el resto de la ficha sigue publicado.
    const multiRow = page.getByTestId(`row-${multiItem.sku}`);
    await multiRow.waitFor();
    await page.getByTestId(`itbis-${multiItem.sku}`).selectOption('');
    await multiRow.getByText('Sin publicar').waitFor();
    check(
      (await multiRow.innerText()).includes('ITBIS por confirmar'),
      'con el ITBIS "Por confirmar", el camarón 21/25 queda sin publicar',
    );
    await until('el camarón 21/25 sale de la tienda', async () => {
      const s = await store();
      return !s.variants.some((v) => v.sku === multiItem.sku) ? s : false;
    });
    const sameGroup = seed.filter((i) => i.group === multiItem.group && i.sku !== multiItem.sku);
    const groupNow = (await store()).items.find((p) => p.group === multiItem.group);
    check(
      groupNow?.variants.length === sameGroup.length,
      'la ficha del camarón sigue en la tienda con sus otros calibres',
    );
    check(
      (await adminSummary()).catalog.blocked === 1,
      'el resumen del API cuenta 1 artículo bloqueado por ITBIS',
    );
    await nav(page, 'Resumen');
    await page
      .getByTestId('stat-Catálogo sin publicar')
      .locator('.value', { hasText: /^1$/ })
      .waitFor();
    check(true, 'el bloqueo por ITBIS también aparece en el resumen: Catálogo sin publicar = 1');
    await nav(page, 'Catálogo y precios');
    await page.getByTestId(`itbis-${multiItem.sku}`).selectOption(String(multiItem.itbisBps));
    await multiRow.getByText('Publicado').waitFor();
    await until('el camarón 21/25 vuelve a la tienda', async () =>
      (await store()).variants.some((v) => v.sku === multiItem.sku),
    );
    check(true, 'al devolverle su ITBIS, el camarón 21/25 reaparece en la tienda');

    // Cambiar un precio: valida el campo y lo publica con el valor nuevo.
    await page.getByTestId('catalog-search').fill(priceItem.name);
    const price = page.getByTestId(`price-${priceItem.sku}`);
    await price.waitFor();
    await price.fill('12,5x');
    check(
      ((await price.getAttribute('class')) ?? '').includes('invalid'),
      'un precio mal escrito se marca en rojo y no se envía',
    );
    await price.fill('95.50');
    await price.press('Enter');
    await until('el precio nuevo llega a la tienda', async () =>
      (await store()).variants.some((v) => v.sku === priceItem.sku && v.price === 9550),
    );
    check(
      (await page.getByTestId(`confirm-${priceItem.sku}`).count()) === 0,
      'las alitas pasan a RD$ 95.50 en la tienda; un precio ya confirmado no pide confirmación',
    );

    // ───── Foto del artículo: ruta local e "Imagen ilustrativa" ─────
    await page.getByTestId('catalog-search').fill(orderItem.name);
    await page.getByTestId(`photo-edit-${orderItem.sku}`).click();
    const ref = page.getByTestId(`photo-input-${orderItem.sku}`);
    await ref.fill('javascript:alert(1)');
    await page.getByText(/Escribe una ruta que empiece con \//).waitFor();
    check(
      await page.getByTestId(`photo-save-${orderItem.sku}`).isDisabled(),
      'una referencia que no es ruta ni URL https se rechaza y no deja guardar',
    );
    await ref.fill(PHOTO_PATH);
    await page.waitForFunction((sel) => {
      const img = document.querySelector(sel);
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    }, `img[data-testid="photo-preview-${orderItem.sku}"]`);
    check(
      await page.getByTestId(`photo-illustrative-${orderItem.sku}`).isChecked(),
      'la foto sembrada es ilustrativa; la vista previa de la ruta local carga desde el API',
    );
    await page.getByTestId(`photo-illustrative-${orderItem.sku}`).click();
    await shot(page, '05-foto');
    await page.getByTestId(`photo-save-${orderItem.sku}`).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByTestId(`row-${orderItem.sku}`).getByText('Foto real').waitFor();
    await page.waitForFunction((sel) => {
      const img = document.querySelector(sel);
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
    }, `img[data-testid="photo-thumb-${orderItem.sku}"]`);
    const saved = (await adminCatalog()).find((v) => v.sku === orderItem.sku);
    check(
      saved?.photo === PHOTO_PATH && saved.photoIllustrative === false,
      'el panel guarda la ruta /photos/… tal cual y la marca como foto real',
    );
    const shown = (await store(`&q=${encodeURIComponent(orderItem.name)}`)).variants.find(
      (v) => v.sku === orderItem.sku,
    );
    check(
      shown?.photo === `${API}${PHOTO_PATH}` && shown.photoIllustrative === false,
      'la tienda pública devuelve la foto con URL absoluta y sin la leyenda de ilustrativa',
    );
    const photoRes = await fetch(`${API}${PHOTO_PATH}`);
    check(
      photoRes.status === 200 && (photoRes.headers.get('content-type') ?? '').startsWith('image/'),
      'esa URL del API sirve la imagen',
    );

    // ───── Importar CSV: errores claros y luego éxito ─────
    await page.getByTestId('catalog-search').fill('');
    await page.getByTestId('open-import').click();
    await page
      .getByTestId('import-text')
      .fill(
        'sku,nombre,categoria,unidad,precio\nX-1,Algo raro,frutas,lb,10\nX-2,Producto bueno,aves,lb,99.90',
      );
    await page.getByTestId('import-check').click();
    await page
      .getByTestId('import-result')
      .getByText(/No se importó nada/)
      .waitFor();
    check(
      (await page.getByTestId('import-result').innerText()).includes('Categoría desconocida'),
      'el CSV con una categoría inválida se rechaza explicando fila y campo',
    );
    await shot(page, '06-importar-errores');
    await page
      .getByTestId('import-text')
      .fill(
        'sku,nombre,categoria,unidad,precio,precio_fuente,itbis,stock\nX-2,Producto bueno,aves,lb,99.90,usuario,0,40',
      );
    await page.getByTestId('import-check').click();
    await page
      .getByTestId('import-result')
      .getByText(/Revisión correcta/)
      .waitFor();
    await page.getByTestId('import-apply').click();
    await page
      .getByTestId('import-result')
      .getByText(/Importación aplicada/)
      .waitFor();
    check(true, 'el CSV corregido se revisa y se aplica');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cerrar', exact: true })
      .first()
      .click();
    check(
      (await store('&q=producto%20bueno')).variants.some(
        (v) => v.sku === 'X-2' && v.price === 9990,
      ),
      'el artículo importado, con precio confirmado e ITBIS, ya se vende en la tienda',
    );

    // ───── Exportar ─────
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-csv').click(),
    ]);
    const file = `${OUT}/catalogo-exportado.csv`;
    await download.saveAs(file);
    const exported = parseCatalogCsv(readFileSync(file, 'utf8'), {
      categories: [...new Set(seed.map((i) => i.category))],
    });
    check(
      exported.errors.length === 0 &&
        exported.items.length === seed.length + 1 &&
        exported.items.find((i) => i.sku === priceItem.sku)?.price === 9550 &&
        exported.items.find((i) => i.sku === orderItem.sku)?.photo === PHOTO_PATH &&
        exported.items.some((i) => i.sku === 'X-2'),
      'la exportación descarga un CSV que se vuelve a leer con los cambios hechos',
    );

    // ───── Zona de entrega ─────
    await nav(page, 'Zonas de entrega');
    await page.getByText('Aún no entregas en ninguna zona').waitFor();
    await page.getByTestId('new-zone').click();
    await page.getByTestId('zone-name').fill('Distrito Nacional');
    await page.getByTestId('zone-areas').fill('Naco, Piantini, Bella Vista, Distrito Nacional');
    await page.getByTestId('zone-fee').fill('150');
    await page.getByTestId('zone-min').fill('500');
    await page.getByTestId('zone-free').fill('4000');
    await shot(page, '07-zona-nueva');
    await page.getByTestId('zone-save').click();
    await page.getByText('Cubre: naco, piantini, bella vista, distrito nacional').waitFor();
    check(true, 'la zona queda creada con tarifa, mínimo y envío gratis');

    // ───── Inventario: existencias ─────
    await nav(page, 'Inventario');
    await page.getByTestId('inv-search').fill(stockItem.name);
    await page.getByTestId(`receive-${stockItem.sku}`).click();
    await page.getByTestId('inv-qty').fill('25');
    await page.getByTestId('inv-confirm').click();
    await page.getByTestId(`inv-${stockItem.sku}`).getByText('25 lb').first().waitFor();
    check(true, 'recibir 25 lb de lomo de cerdo actualiza la existencia');

    // ───── Inventario: lotes y vencimientos ─────
    await page.getByTestId('inv-tab-lotes').click();
    await page.getByTestId('lot-new').waitFor();
    // El lote que vence en 5 días es de la pechuga: de ahí saldrán los pedidos.
    await page.getByTestId('lot-variant-search').fill('pechuga');
    await page.getByTestId(`lot-variant-${orderItem.sku}`).click();
    await page.getByTestId('lot-code').fill(LOT_SOON);
    await page.getByTestId('lot-expires').fill(rdDate(5));
    await page.getByTestId('lot-qty').fill('40');
    await page.getByTestId('lot-submit').click();
    await page.getByTestId(`lot-row-${LOT_SOON}`).waitFor();
    check(
      (await page.getByTestId(`lot-status-${LOT_SOON}`).getAttribute('data-status')) ===
        'expiring' &&
        (await page.getByTestId(`lot-status-${LOT_SOON}`).innerText()) === 'Por vencer',
      'el lote que vence en 5 días queda "Por vencer"',
    );
    const soonRow = page.getByTestId(`expiring-row-${LOT_SOON}`);
    await soonRow.waitFor();
    check(
      (await soonRow.innerText()).includes('vence en 5 días'),
      'la lista "Por vencer" muestra el lote con "vence en 5 días"',
    );

    // Un lote vencido: la fecha vieja se valida y la de hace 3 días se acepta (se recibe para darlo de baja).
    await page.getByTestId('lot-variant-search').fill(expiredItem.name);
    await page.getByTestId(`lot-variant-${expiredItem.sku}`).click();
    await page.getByTestId('lot-code').fill(LOT_EXPIRED);
    await page.getByTestId('lot-expires').fill('2020-01-01');
    await page.getByTestId('lot-qty').fill('10');
    await page.getByText(/pasó hace más de 30 días/).waitFor();
    check(
      await page.getByTestId('lot-submit').isDisabled(),
      'una fecha de vencimiento de hace años se rechaza y no deja recibir el lote',
    );
    await page.getByTestId('lot-expires').fill(rdDate(-3));
    await page.getByTestId('lot-submit').click();
    await page.getByTestId(`lot-row-${LOT_EXPIRED}`).waitFor();
    check(
      (await page.getByTestId(`lot-status-${LOT_EXPIRED}`).getAttribute('data-status')) ===
        'expired' &&
        (await page.getByTestId(`lot-status-${LOT_EXPIRED}`).innerText()) === 'Vencido',
      'el lote con fecha pasada queda "Vencido"',
    );
    const expiredRow = page.getByTestId(`expiring-row-${LOT_EXPIRED}`);
    await expiredRow.waitFor();
    check(
      (await expiredRow.innerText()).includes('venció hace 3 días'),
      'el lote vencido aparece en "Por vencer" con "venció hace 3 días"',
    );
    await page.getByTestId('expiring-days').selectOption('7');
    await soonRow.waitFor();
    await shot(page, '08-lotes');
    const lots = (await http<StockLotDTO[]>('/v1/admin/inventory/lots', await adminToken(page)))
      .body;
    check(
      lots.find((l) => l.lotCode === LOT_SOON)?.qtyRemaining === 4000 &&
        lots.find((l) => l.lotCode === LOT_EXPIRED)?.status === 'expired',
      'el API guarda los lotes con su saldo y su estado',
    );

    await nav(page, 'Resumen');
    const soonAlert = page.getByTestId('alert-expiring');
    const expiredAlert = page.getByTestId('alert-expired');
    await soonAlert.waitFor();
    await expiredAlert.waitFor();
    check(
      (await soonAlert.innerText()).includes('1 lote vence en 7 días o menos') &&
        (await expiredAlert.innerText()).includes('1 lote vencido con existencias'),
      'el resumen alerta de 1 lote por vencer y 1 vencido',
    );
    const summary1 = await adminSummary();
    check(
      summary1.expiringSoon === 1 && summary1.expired === 1,
      'el API cuenta 1 lote por vencer y 1 vencido',
    );
    await shot(page, '09-resumen-alertas');
    await soonAlert.click();
    await page.getByTestId('lot-new').waitFor();
    check(
      page.url().includes('/inventario?tab=lotes'),
      'la alerta lleva directo a la pestaña de lotes',
    );
    await page.getByTestId('inv-tab-existencias').click();
    await page.getByTestId('inv-search').fill(orderItem.name);
    await page.getByTestId(`inv-${orderItem.sku}`).getByText('40 lb').first().waitFor();
    check(true, 'las 40 lb del lote suman a la existencia de la pechuga');

    // ───── Equipo: repartidor y personal ─────
    await nav(page, 'Equipo');
    await page.getByTestId('team-phone').fill(DRIVER_PHONE);
    await page.getByTestId('team-name').fill('Juan Motorista');
    await page.getByTestId('team-add').click();
    await page.getByTestId(`member-${e164(DRIVER_PHONE)}`).waitFor();
    check(true, 'el repartidor queda agregado al equipo');
    await page.getByTestId('team-phone').fill(STAFF_PHONE);
    await page.getByTestId('team-name').fill('Rosa Almacén');
    await page.getByTestId('team-role').selectOption('staff');
    await page.getByTestId('team-add').click();
    await page.getByTestId(`member-${e164(STAFF_PHONE)}`).waitFor();
    await shot(page, '10-equipo');
    check(true, 'la persona de personal queda agregada al equipo');

    // ───── El cliente (por API; la app ya tiene su propio recorrido) ─────
    const customer = await apiLogin(API, CUSTOMER_PHONE);
    const customer2 = await apiLogin(API, CUSTOMER2_PHONE);
    const orderVariant = (await store(`&q=${encodeURIComponent(orderItem.name)}`)).variants.find(
      (v) => v.sku === orderItem.sku,
    )!;
    const slots = (await http<{ start: string; available: boolean }[]>('/v1/delivery/slots')).body;
    const placeOrder = (session: string, quantity: number, couponCode?: string, notes?: string) =>
      http<OrderDTO & { error?: { code: string; message: string } }>('/v1/orders', session, {
        method: 'POST',
        body: {
          items: [{ variantId: orderVariant.id, quantity }],
          address: {
            line1: 'Calle 5 #12',
            reference: 'Frente al colmado Lilí',
            sector: 'Piantini',
            city: 'Santo Domingo',
          },
          slotStart: slots.find((s) => s.available)!.start,
          paymentMethod: 'cash',
          notes,
          couponCode,
        },
      });
    const quoteWith = async (session: string, couponCode: string, quantity = 1000) =>
      (
        await http<QuoteDTO>('/v1/quote', session, {
          method: 'POST',
          body: {
            items: [{ variantId: orderVariant.id, quantity }],
            address: { sector: 'Piantini', city: 'Santo Domingo' },
            couponCode,
          },
        })
      ).body;

    // ───── Cupones: crear desde el panel y comprobar que el API lo cotiza ─────
    await nav(page, 'Cupones');
    await page.getByText('Aún no hay cupones').waitFor();
    await page.getByTestId('coupon-new').click();
    await page.getByTestId('coupon-code').fill(COUPON.toLowerCase());
    await page.getByTestId('coupon-kind').selectOption('percent');
    await page.getByTestId('coupon-value').fill('10');
    await page.getByTestId('coupon-max-redemptions').fill('5');
    await shot(page, '11-cupon-nuevo');
    await page.getByTestId('coupon-submit').click();
    const couponRow = page.getByTestId(`coupon-row-${COUPON}`);
    await couponRow.waitFor();
    check(
      (await page.getByTestId(`coupon-status-${COUPON}`).innerText()) === 'Activo' &&
        (await couponRow.innerText()).includes('10 %') &&
        (await couponRow.innerText()).includes('0 de 5'),
      'el cupón queda creado en mayúsculas, activo, al 10 % y con 5 usos como máximo',
    );
    const q1 = await quoteWith(customer, ` ${COUPON.toLowerCase()} `);
    const expectedSubtotal = Math.round((orderVariant.price * 1000) / 100);
    check(
      q1.coupon?.code === COUPON &&
        q1.subtotal === expectedSubtotal &&
        q1.discount === Math.floor(expectedSubtotal / 10) &&
        q1.total === q1.subtotal - q1.discount + q1.deliveryFee,
      `el API cotiza el cupón para el cliente: 10 lb con ${COUPON} descuenta ${formatDOP(q1.discount)} sin redondear a favor del cliente`,
    );

    // Un pedido real con el cupón: el uso aparece en "Canjes".
    const couponOrder = await placeOrder(customer, 500, COUPON);
    check(
      couponOrder.status === 201 &&
        couponOrder.body.couponCode === COUPON &&
        couponOrder.body.discount === Math.floor(Math.round((orderVariant.price * 500) / 100) / 10),
      `el cliente hizo el pedido ${couponOrder.body.code} con el cupón`,
    );
    // La lista de cupones se refresca cada 30 s: se recarga para ver el canje enseguida.
    await page.reload();
    await page.getByTestId(`coupon-row-${COUPON}`).waitFor();
    check(
      (await page.getByTestId(`coupon-row-${COUPON}`).innerText()).includes('1 de 5'),
      'la lista de cupones cuenta el canje: 1 de 5 usos',
    );
    await page.getByTestId(`coupon-redemptions-${COUPON}`).click();
    await page.getByTestId(`coupon-redemption-${couponOrder.body.code}`).waitFor();
    check(
      (await page.getByTestId(`coupon-redemption-${couponOrder.body.code}`).innerText()).includes(
        formatDOP(couponOrder.body.discount),
      ),
      'Canjes muestra el pedido que usó el cupón y el monto descontado',
    );
    await shot(page, '12-cupon-canjes');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();

    // Pausarlo: el panel lo marca y el API deja de aplicarlo (cotización y pedido).
    await page.getByTestId(`coupon-toggle-${COUPON}`).click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByTestId(`coupon-status-${COUPON}`).getByText('Pausado').waitFor();
    const q2 = await quoteWith(customer2, COUPON);
    check(
      q2.coupon === null && !!q2.couponError && q2.discount === 0,
      'con el cupón pausado, la cotización vuelve sin descuento y explica por qué',
    );
    const refused = await placeOrder(customer2, 500, COUPON);
    check(
      refused.status === 409 &&
        refused.body.error?.code === 'coupon_invalid' &&
        refused.body.error.message === q2.couponError,
      'con el cupón pausado, un pedido nuevo de otro cliente que lo use se rechaza con el mismo motivo',
    );
    await shot(page, '13-cupon-pausado');
    await page.getByTestId(`coupon-toggle-${COUPON}`).click();
    await page.getByTestId(`coupon-status-${COUPON}`).getByText('Activo').waitFor();
    const q3 = await quoteWith(customer2, COUPON);
    check(
      q3.coupon?.code === COUPON && q3.discount === Math.floor(expectedSubtotal / 10),
      'al activarlo de nuevo, el cupón vuelve a aplicar para otro cliente',
    );
    check(
      (await quoteWith(customer, COUPON)).coupon === null,
      'el cliente que ya usó su único canje no puede repetirlo',
    );
    const couponApi = (
      await http<CouponDTO[]>('/v1/admin/coupons', await adminToken(page))
    ).body.find((c) => c.code === COUPON);
    check(
      couponApi?.active === true && couponApi.redemptions === 1 && couponApi.status === 'active',
      'el API lo muestra activo con 1 canje',
    );

    // ───── Pedido real con PIN: tablero, pesaje y entrega sin PIN ─────
    const orderRes = await placeOrder(customer, 1000, undefined, 'Sin hielo seco, por favor');
    const order = orderRes.body;
    check(orderRes.status === 201, `el cliente hizo el pedido ${order.code} en efectivo`);
    const customerView = (await http<OrderDTO>(`/v1/orders/${order.id}`, customer)).body;
    const pin = customerView.deliveryPin ?? '';
    check(/^\d{4}$/.test(pin), 'el cliente ve el PIN de 4 dígitos de su entrega');
    check(
      (await http<OrderDTO>(`/v1/admin/orders/${order.id}`, await adminToken(page))).body
        .deliveryPin === null,
      'el administrador no recibe el PIN del cliente',
    );

    await nav(page, 'Pedidos');
    await page.getByTestId(`order-${order.code}`).waitFor({ timeout: 15_000 });
    await shot(page, '14-tablero');
    await page.getByTestId(`order-${order.code}`).click();
    await page.getByText('Nota del cliente: Sin hielo seco').waitFor();
    const pinCard = page.getByTestId('pin-card');
    check(
      (await pinCard.getByTestId('pin-required').innerText()) === 'Sí' &&
        (await pinCard.getByTestId('pin-attempts').innerText()) === '5 intentos' &&
        (await pinCard.getByTestId('pin-verified').innerText()) === 'Aún sin verificar' &&
        (await page.getByTestId('pin-override-reason-shown').count()) === 0,
      'la tarjeta Entrega muestra: exige PIN, 5 intentos y aún sin verificar',
    );
    await shot(page, '15-pedido-confirmado');
    await page.getByTestId('act-picking').click();
    await page.getByTestId('save-weights').waitFor();
    await page.getByTestId(`weight-${orderItem.sku}`).fill('10.23');
    await page.getByTestId('save-weights').click();
    await page.getByText('Pesos guardados').waitFor();
    await shot(page, '16-pesaje');
    await page.getByTestId('act-packed').click();
    await page.getByTestId('driver-select').waitFor();
    await page.getByTestId('driver-select').selectOption({ label: 'Juan Motorista' });
    await page.getByTestId('act-assign').click();
    await page.getByText('Repartidor asignado').waitFor();
    await page.getByTestId('act-out').click();
    await page.getByTestId('act-cash').waitFor();
    check(
      (await page.getByTestId('act-delivered').count()) === 0 &&
        (await page.getByTestId('deliver-override').isVisible()),
      'con el pedido en camino, el panel ofrece "Entregar sin PIN" en lugar de "Marcar entregado"',
    );
    check(
      !new RegExp(`(?<![\\d.,])${pin}(?![\\d.,])`).test(await page.locator('body').innerText()),
      'el PIN del cliente no se ve en ninguna parte de la pantalla del pedido',
    );

    // Sin cobro registrado no se puede entregar, ni con motivo válido.
    await page.getByTestId('deliver-override').click();
    await page.getByTestId('override-reason').fill(OVERRIDE_REASON);
    await page.getByTestId('override-confirm').click();
    await page
      .getByRole('dialog')
      .getByText(/Registra el cobro en efectivo/)
      .waitFor();
    check(true, 'no deja entregar un pedido en efectivo sin registrar el cobro');
    await page.getByRole('dialog').getByRole('button', { name: 'Volver' }).click();
    await page.getByTestId('act-cash').click();
    const due = await page.getByTestId('dialog-text').inputValue();
    const expectedTotal = Math.round((orderVariant.price * 1023) / 100) + order.deliveryFee;
    check(
      due === pesos(expectedTotal),
      `el cobro propuesto es el total real con el peso pesado (RD$ ${due})`,
    );
    await page.getByTestId('dialog-confirm').click();
    await page.getByText('Cobro registrado').waitFor();

    // Motivo corto: el panel lo frena (faltan caracteres) y el API también lo rechaza.
    await page.getByTestId('deliver-override').click();
    await page.getByTestId('override-reason').fill('corto');
    check(
      (await page.getByTestId('override-count').innerText()).includes('faltan 3') &&
        (await page.getByTestId('override-count').innerText()).includes('8 caracteres') &&
        (await page.getByTestId('override-confirm').isDisabled()),
      'un motivo de 5 caracteres no alcanza: el panel pide 8 como mínimo y bloquea el botón',
    );
    const short = await http<{ error: { code: string; message: string } }>(
      `/v1/admin/orders/${order.id}/transition`,
      await adminToken(page),
      { method: 'POST', body: { to: 'delivered', pinOverrideReason: 'corto' } },
    );
    check(
      short.status === 400 &&
        short.body.error.code === 'pin_override_required' &&
        short.body.error.message.includes('mínimo 8 caracteres'),
      'el API rechaza el motivo corto con "mínimo 8 caracteres"',
    );
    await shot(page, '17-entrega-sin-pin');
    await page.getByTestId('override-reason').fill(OVERRIDE_REASON);
    check(
      (await page.getByTestId('override-confirm').isEnabled()) &&
        !(await page.getByTestId('override-count').innerText()).includes('faltan'),
      'con un motivo válido el botón se habilita',
    );
    await page.getByTestId('override-confirm').click();
    await page.getByText('Este pedido está cerrado.').waitFor();
    check(
      (await page.getByTestId('pin-override-reason-shown').innerText()) === OVERRIDE_REASON &&
        (await page.getByTestId('pin-verified').innerText()) ===
          'No verificado: se entregó sin PIN' &&
        (await page.locator('.timeline').innerText()).includes(
          `Entrega sin PIN autorizada: ${OVERRIDE_REASON}`,
        ),
      'el pedido queda entregado y el motivo se ve en la tarjeta Entrega y en el historial',
    );
    check(
      (await page.getByTestId('order-total').innerText()).includes(formatDOP(expectedTotal)),
      `el total final del pedido refleja el peso real (10.23 lb × precio + envío = ${formatDOP(expectedTotal)})`,
    );
    await shot(page, '18-pedido-entregado');
    const delivered = (await http<OrderDTO>(`/v1/admin/orders/${order.id}`, await adminToken(page)))
      .body;
    const deliveredForCustomer = (await http<OrderDTO>(`/v1/orders/${order.id}`, customer)).body;
    check(
      delivered.status === 'delivered' &&
        delivered.finalTotal === expectedTotal &&
        delivered.pinOverrideReason === OVERRIDE_REASON &&
        delivered.pinVerifiedAt === null &&
        deliveredForCustomer.pinOverrideReason === null &&
        deliveredForCustomer.deliveryPin === null,
      'el motivo es una nota interna: el cliente no la ve y su PIN ya no aparece al entregar',
    );

    // ───── Resumen y cuadre de caja ─────
    await nav(page, 'Resumen');
    await page
      .getByTestId('stat-Efectivo por entregar')
      .getByText(formatDOP(expectedTotal))
      .waitFor();
    check(
      true,
      `el resumen muestra ${formatDOP(expectedTotal)} de efectivo en manos del repartidor`,
    );
    await shot(page, '19-resumen-final');
    await nav(page, 'Pagos y caja');
    await page.getByTestId('tab-cash').click();
    await page.getByTestId(`settle-${e164(DRIVER_PHONE)}`).click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByText('Entrega de efectivo registrada').waitFor();
    await page
      .getByTestId(`cash-${e164(DRIVER_PHONE)}`)
      .getByText('RD$ 0.00')
      .first()
      .waitFor();
    check(true, 'al registrar la entrega del efectivo, el saldo del repartidor queda en RD$ 0.00');
    await shot(page, '20-caja');

    // ───── Bitácora ─────
    const token = await adminToken(page);
    const adminPage: Page = page;
    await padAudit(token, await idOf(priceItem.sku), 55);
    await nav(page, 'Bitácora');
    await page.getByTestId('audit-page').waitFor();
    await until('50 filas en la primera página', async () =>
      (await adminPage.getByTestId('audit-row').count()) === 50 ? true : false,
    );
    await page.getByTestId('audit-more').click();
    await until('"Cargar más" trae la página siguiente', async () =>
      (await adminPage.getByTestId('audit-row').count()) > 50 ? true : false,
    );
    check(true, 'la bitácora pagina de 50 en 50 y "Cargar más" trae lo anterior');

    const filterAudit = async (action: string, expected: number) => {
      await adminPage.getByTestId('audit-filter').fill(action);
      await until(`la bitácora filtra por ${action}`, async () =>
        (await adminPage.getByTestId('audit-row').count()) === expected ? true : false,
      );
    };
    const couponLog = await auditEntries(token, 'coupons.*');
    check(
      couponLog.some((e) => e.action === 'coupons.create' && e.status === 201) &&
        couponLog.filter((e) => e.action === 'coupons.update' && e.status === 200).length === 2,
      'la bitácora registra el cupón creado y los dos cambios (pausar y activar)',
    );
    await filterAudit('coupons.*', couponLog.length);
    const created = page.getByTestId('audit-row').filter({ hasText: 'coupons.create' });
    await created.getByTestId('audit-expand').click();
    const detail = await page.getByTestId('audit-detail').innerText();
    check(
      detail.includes('"kind": "percent"') && !detail.includes(COUPON) && !/"code"/.test(detail),
      'el detalle del cupón creado muestra el tipo y el valor, pero no el código',
    );
    await shot(page, '21-bitacora-cupones');

    const lotLog = await auditEntries(token, 'inventory.receive_lot');
    check(
      lotLog.length === 2 &&
        lotLog.some((e) => e.summary.includes(LOT_SOON)) &&
        lotLog.some((e) => e.summary.includes(LOT_EXPIRED)),
      'la bitácora registra la recepción de los dos lotes con su código',
    );
    await filterAudit('inventory.receive_lot', 2);
    check(
      (await adminPage.getByTestId('audit-row').allInnerTexts()).every((t) =>
        t.includes('Lote recibido: lote E2E-'),
      ),
      'la bitácora del panel resume cada lote recibido con su código',
    );

    const transitions = await auditEntries(token, 'orders.transition');
    const rejected = transitions.filter((e) => e.status >= 400);
    check(
      transitions.some((e) => e.status === 200 && e.summary.includes('«delivered»')) &&
        rejected.some((e) => e.summary.includes('cash_not_collected')) &&
        rejected.some((e) => e.summary.includes('pin_override_required')),
      'la bitácora registra la entrega y también los intentos rechazados (sin cobro, motivo corto)',
    );
    await filterAudit('orders.transition', transitions.length);
    check(
      (await adminPage.getByTestId('audit-row').allInnerTexts()).some(
        (t) => t.includes('«delivered»') && !t.includes('rechazado'),
      ) &&
        (await adminPage.getByTestId('audit-row').allInnerTexts()).some((t) =>
          t.includes('rechazado (pin_override_required)'),
        ),
      'la bitácora del panel muestra la entrega y el intento rechazado por motivo corto',
    );
    await page.getByTestId('audit-expand').first().click();
    await shot(page, '22-bitacora-pedido');

    const secrets = new Set<string>([
      token,
      customer,
      pin,
      ...[...apiLog.text.matchAll(/Código para \+\d+: (\d{6})/g)].map((m) => m[1]!),
    ]);
    const everything = await auditEntries(token);
    const leaked = everything.flatMap((e) => leaksIn(e.payload, secrets, `${e.action}`));
    check(
      leaked.length === 0,
      `ningún movimiento de la bitácora (${everything.length}) guarda PIN, códigos, tokens ni teléfonos completos${leaked.length ? `: ${leaked.slice(0, 3).join(' | ')}` : ''}`,
    );

    // ───── Personal: ve menos y no cambia cupones ─────
    const staffCtx = await browser.newContext({
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
    });
    await watch(staffCtx);
    const sp = await staffCtx.newPage();
    await signIn(sp, STAFF_PHONE);
    await sp.getByRole('heading', { name: 'Resumen' }).waitFor({ timeout: 15_000 });
    check(
      (await sp.locator('.sidebar').innerText()).includes('Personal'),
      'el personal entra al panel con su rol',
    );
    for (const hidden of ['Zonas de entrega', 'Equipo', 'Bitácora', 'Lista de precios']) {
      check(
        (await sp.locator('.nav').getByRole('link', { name: hidden }).count()) === 0,
        `el menú del personal no trae "${hidden}"`,
      );
    }
    for (const path of ['/zonas', '/equipo', '/bitacora']) {
      await sp.goto(`${WEB}${path}`);
      await sp.getByRole('heading', { name: 'Resumen' }).waitFor();
      check(
        new URL(sp.url()).pathname === '/',
        `escribir ${path} a mano devuelve al personal al Resumen`,
      );
    }
    await nav(sp, 'Cupones');
    await sp.getByTestId(`coupon-row-${COUPON}`).waitFor();
    check(
      (await sp.getByTestId('coupon-new').count()) === 0 &&
        (await sp.getByTestId(`coupon-toggle-${COUPON}`).count()) === 0 &&
        (await sp.getByTestId(`coupon-edit-${COUPON}`).count()) === 0 &&
        (await sp.getByText('Solo el administrador los cambia.').isVisible()),
      'el personal ve los cupones pero sin "Nuevo cupón", Editar ni Pausar',
    );
    await sp.getByTestId(`coupon-redemptions-${COUPON}`).click();
    await sp.getByTestId(`coupon-redemption-${couponOrder.body.code}`).waitFor();
    check(true, 'el personal sí puede ver quién usó el cupón');
    await shot(sp, '23-personal-cupones');
    await sp.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await nav(sp, 'Catálogo y precios');
    await sp.getByTestId(`row-${orderItem.sku}`).waitFor();
    check(
      (await sp.getByTestId(`price-${orderItem.sku}`).isDisabled()) &&
        (await sp.getByTestId(`photo-edit-${orderItem.sku}`).count()) === 0 &&
        (await sp.getByTestId('open-import').count()) === 0,
      'el personal ve el catálogo sin poder cambiar precios, fotos ni importar',
    );
    const staffToken = await adminToken(sp);
    const denied = await Promise.all([
      http('/v1/admin/audit', staffToken),
      http('/v1/admin/zones', staffToken),
      http('/v1/admin/users', staffToken),
      http('/v1/admin/coupons', staffToken, {
        method: 'POST',
        body: { code: 'NOPE', kind: 'percent', value: 500 },
      }),
    ]);
    check(
      denied.every((r) => r.status === 403) &&
        (await http('/v1/admin/coupons', staffToken)).status === 200,
      'el API le niega al personal la bitácora, las zonas, el equipo y crear cupones, pero le deja leerlos',
    );
    await staffCtx.close();

    // ───── Móvil y modo claro ─────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    await watch(mobile);
    const mp = await mobile.newPage();
    await mp.addInitScript((t) => localStorage.setItem('jellyfish.admin.token', t), token);
    await mp.goto(WEB);
    await mp.getByRole('heading', { name: 'Resumen' }).waitFor();
    await shot(mp, '24-movil-claro');

    check(
      tolerated.length === 1 && tolerated[0]!.includes('409'),
      'el único rechazo del API que vio el navegador fue el esperado: entregar sin registrar el cobro',
    );
    check(
      errors.length === 0,
      `sin errores de consola/JS en el navegador${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
    );
    console.log(`\n✔ Recorrido del panel completo. ${shots.length} capturas en ${OUT}\n`);
  } catch (e) {
    if (page) {
      await page.screenshot({ path: `${OUT}/FALLO.png` }).catch(() => {});
      console.error(`URL: ${page.url()}`);
      console.error(
        `Texto visible:\n${(
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 700)}`,
      );
    }
    if (errors.length)
      console.error(`Errores del navegador:\n- ${errors.slice(0, 5).join('\n- ')}`);
    throw e;
  } finally {
    await browser.close();
    server.close();
  }
}

main()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopAll();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
