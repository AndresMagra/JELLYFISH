/**
 * Recorrido completo de la app del cliente en un navegador real (Chromium), contra el API real en
 * modo demo (catálogo sembrado de data/catalog) y con la pasarela de tarjeta simulada.
 *
 *   npm run e2e:customer                      (capturas en tmp/e2e-customer)
 *   E2E_OUT=/ruta npm run e2e:customer
 *   E2E_SKIP_EXPORT=1 npm run e2e:customer    (reutiliza la app empaquetada en tmp/e2e-customer-web)
 *
 * Recorre: inicio y categorías, búsqueda con sinónimos, producto con presentaciones y reglas de
 * cantidad (paso y mínimo), carrito, registro con OTP real, dirección, horario, cupón creado por la
 * API de administración, pedido en efectivo (PIN y seguimiento), pedido con tarjeta simulada y
 * "Pedir de nuevo" de un pedido entregado. Los totales de la pantalla se comparan contra la
 * cotización del API y contra un cálculo independiente de ITBIS y total.
 *
 * Es la prueba de que las pantallas, el API y el cobro funcionan juntos. No sustituye probar en
 * un iPhone/Android reales (navegador seguro, teclado, notificaciones).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CategoryDTO,
  type OrderDTO,
  type OrderTotals,
  type ProductDTO,
  type ProductListDTO,
  type QuoteDTO,
  type VariantDTO,
  computeOrderTotals,
  formatDOP,
  formatLb,
  priceForWeight,
} from '@jellyfish/shared';
import { type Locator, type Page, chromium } from 'playwright-core';
import {
  CHROME,
  apiLog,
  apiLogin,
  check,
  log,
  otpFor,
  root,
  serveStatic,
  sleep,
  start,
  stopAll,
  waitFor,
} from './e2e-lib';

const OUT = resolve(process.env.E2E_OUT ?? `${root}/tmp/e2e-customer`);
const API_PORT = 3998;
const WEB_PORT = 8089;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
// Empaquetado y caché de Metro propios: no pisan apps/customer/dist ni a otros recorridos, y la
// caché solo se comparte entre corridas con la misma URL del API (Metro no la incluye en su clave).
const WEB_DIST = `${root}/tmp/e2e-customer-web`;
const METRO_TMP = `${root}/tmp/e2e-customer-metro-${API_PORT}`;
const ADMIN = '809-555-0100';
const DRIVER = '849-555-0166';
const COUPON = 'E2E10';
const COUPON_BPS = 1000; // 10 %
/** El signo de resta que dibuja la app en los descuentos (U+2212). */
const MINUS = '\u2212';
/** PNG de 1×1 para las fotos del catálogo, que viven en un CDN externo sin salida en el entorno. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

mkdirSync(OUT, { recursive: true });
// Las capturas se numeran en orden: las de una corrida anterior solo confundirían.
for (const f of readdirSync(OUT)) {
  if (/^(\d\d-.*|FALLO)\.png$/.test(f)) rmSync(`${OUT}/${f}`);
}

const shots: string[] = [];
/** Captura numerada en orden de llegada (01-inicio.png, 02-…); sirve con cualquier pestaña. */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(500); // deja terminar animaciones y carga de imágenes
  const file = `${OUT}/${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  log(`captura ${file.slice(OUT.length + 1)}`);
}

const apiLogTail = () => apiLog.text.trim().split('\n').slice(-15).join('\n');

// ───────────────────────── API (preparación y comparación) ─────────────────────────

async function call<T>(token: string | null, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ''}`);
  return json as T;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(`✖ Falta en el catálogo o los datos de prueba: ${what}`);
  }
  return value;
}

interface CartLine {
  variant: VariantDTO;
  quantity: number;
}

const qtyOf = (l: CartLine) => ({ variantId: l.variant.id, quantity: l.quantity });

/** Cálculo independiente del API: mismo motor de precios, con los precios del catálogo. */
function expectedTotals(lines: CartLine[], opts: { discount?: number; deliveryFee?: number } = {}) {
  return computeOrderTotals(
    lines.map((l) => ({
      id: l.variant.id,
      pricingUnit: l.variant.pricingUnit,
      unitPrice: l.variant.price,
      itbisBps: l.variant.itbisBps,
      quantity: l.quantity,
      variableWeight: l.variant.variableWeight && l.variant.pricingUnit === 'lb',
    })),
    opts,
  );
}

function sameTotals(q: QuoteDTO, e: OrderTotals): string[] {
  const diffs: string[] = [];
  for (const k of ['subtotal', 'discount', 'deliveryFee', 'itbis', 'total'] as const) {
    if (q[k] !== e[k]) diffs.push(`${k}: API ${q[k]} ≠ cálculo ${e[k]}`);
  }
  return diffs;
}

// ───────────────────────── Ayudas de la interfaz ─────────────────────────

/** Las pantallas anteriores siguen montadas bajo la actual: siempre se toca la que se ve. */
const tid = (scope: Page | Locator, id: string) =>
  scope.getByTestId(id).filter({ visible: true }).first();
const btn = (page: Page, name: string | RegExp) =>
  page
    .getByRole('button', { name, ...(typeof name === 'string' ? { exact: true } : {}) })
    .filter({ visible: true })
    .first();
const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });
const seen = (page: Page | Locator, text: string | RegExp) =>
  page
    .getByText(text, typeof text === 'string' ? { exact: true } : {})
    .filter({ visible: true })
    .first();

/** Espera hasta que `fn` devuelva algo verdadero (la app consulta al API cada pocos segundos). */
async function waitUntil<T>(
  what: string,
  fn: () => Promise<T | false | null | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`✖ Tiempo agotado esperando: ${what}`);
    await sleep(400);
  }
}

/** Valor de una fila "etiqueta … valor" de los resúmenes (Subtotal, Envío, Total…). */
async function rowValue(page: Page, label: string): Promise<string> {
  const row = seen(page, label).locator('xpath=..');
  const lines = (await row.innerText({ timeout: 2000 }))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

async function expectRows(page: Page, expected: Record<string, string>, where: string) {
  const t0 = Date.now();
  for (;;) {
    const bad: string[] = [];
    for (const [label, want] of Object.entries(expected)) {
      const got = await rowValue(page, label).catch(() => '(no aparece)');
      if (got !== want) bad.push(`${label}: pantalla "${got}" ≠ esperado "${want}"`);
    }
    if (bad.length === 0) break;
    if (Date.now() - t0 > 15_000) throw new Error(`✖ ${where}: ${bad.join(' | ')}`);
    await sleep(400);
  }
  check(true, `${where}: ${Object.keys(expected).join(', ')} coinciden con el API`);
}

const orderStatus = async (page: Page) =>
  (
    await tid(page, 'order-status')
      .innerText({ timeout: 2000 })
      .catch(() => '')
  ).trim();

/** Elige la primera franja disponible del día mostrado y devuelve su texto ("10:00 a. m. – 12:00 p. m."). */
async function pickSlot(page: Page): Promise<string> {
  const slot = page
    .getByRole('button', { name: /\d:\d\d [ap]\. m\. – /, disabled: false })
    .filter({ visible: true })
    .first();
  await slot.waitFor({ timeout: 20_000 });
  const label = (await slot.innerText()).trim();
  await slot.click();
  return label;
}

/** Lee el PIN de entrega tal como lo ve el cliente (la tarjeta lo anuncia dígito por dígito). */
async function readPin(page: Page): Promise<string> {
  const label = await tid(page, 'pin-card')
    .getByLabel(/Tu PIN de entrega: /)
    .first()
    .getAttribute('aria-label');
  return (label ?? '').replace(/\D/g, '');
}

/** Busca en la pestaña Buscar y espera a que las tarjetas sean exactamente las que devuelve el API. */
async function searchFor(page: Page, text: string): Promise<ProductListDTO> {
  const want = await call<ProductListDTO>(
    null,
    `/v1/products?limit=100&q=${encodeURIComponent(text)}`,
  );
  await tab(page, /Buscar/).click();
  await tid(page, 'search-input').fill(text);
  const groups = want.items.map((p) => p.group).sort();
  await waitUntil(
    `resultados de "${text}" (${groups.join(', ')})`,
    async () => {
      const shown = await tid(page, 'search-results')
        .locator('[data-testid^="product-card-"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(13)).sort());
      return JSON.stringify(shown) === JSON.stringify(groups);
    },
    15_000,
  );
  return want;
}

/** Abre la ficha de un producto desde los resultados de la búsqueda. */
async function openProduct(page: Page, group: string) {
  await tid(tid(page, 'search-results'), `product-card-${group}`).click();
  await tid(page, 'add-to-cart').or(seen(page, 'Ver carrito')).waitFor({ timeout: 20_000 });
}

/** Pulsa "+" / "−" del selector de cantidad y espera a ver la cantidad nueva. */
async function stepTo(page: Page, name: 'Agregar' | 'Quitar', label: string) {
  await btn(page, name).click();
  await seen(page, label).waitFor({ timeout: 5000 });
}

/** Agrega la presentación al carrito (queda en su mínimo) y sube paso a paso hasta `target`. */
async function fillTo(page: Page, v: VariantDTO, target: number) {
  const step = v.stepCentilb ?? 50;
  await tid(page, 'add-to-cart').click();
  let q = v.minCentilb ?? 100;
  await seen(page, formatLb(q)).waitFor({ timeout: 5000 });
  while (q < target) {
    q += step;
    await stepTo(page, 'Agregar', formatLb(q));
  }
}

async function exportWeb(): Promise<void> {
  mkdirSync(METRO_TMP, { recursive: true });
  await new Promise<void>((ok, fail) => {
    let out = '';
    const p = spawn('npx', ['expo', 'export', '--platform', 'web', '--output-dir', WEB_DIST], {
      cwd: `${root}/apps/customer`,
      env: {
        ...process.env,
        EXPO_PUBLIC_API_URL: API,
        EXPO_NO_TELEMETRY: '1',
        CI: '1',
        TMPDIR: METRO_TMP,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-3000);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`expo export falló (${code}):\n${out}`)),
    );
  });
}

/** El paquete debe apuntar a ESTE API; si no, la app dice "No pudimos conectarnos" sin más pistas. */
function assertBundleTargetsApi() {
  const dir = `${WEB_DIST}/_expo/static/js/web`;
  if (!existsSync(dir)) {
    throw new Error(
      `No hay paquete web en ${WEB_DIST}: corre sin E2E_SKIP_EXPORT=1 al menos una vez.`,
    );
  }
  const entry = readdirSync(dir).find((f) => f.startsWith('entry-') && f.endsWith('.js'));
  if (!entry || !readFileSync(`${dir}/${entry}`, 'utf8').includes(API)) {
    throw new Error(
      `El paquete web de la app no trae la URL del API (${API}). Borra ${METRO_TMP} y ${WEB_DIST} y vuelve a correr.`,
    );
  }
}

async function main() {
  // Un API viejo en el mismo puerto contaminaría la prueba sin avisar.
  if (
    await fetch(`${API}/health`).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`El puerto ${API_PORT} ya está en uso: cierra el API anterior.`);
  }
  log('Iniciando API en modo demo…');
  start(
    'npx',
    ['tsx', 'apps/api/src/server.ts'],
    {
      JELLYFISH_DEMO: '1',
      JELLYFISH_SEED: '1',
      PAYMENTS_MOCK: '1',
      PORT: String(API_PORT),
      PUBLIC_API_URL: API,
      BOOTSTRAP_ADMIN_PHONE: ADMIN,
      TRANSFER_BANK: 'Banco de Pruebas',
      TRANSFER_ACCOUNT_NUMBER: '000-000000-0',
      TRANSFER_HOLDER: 'JELLYFISH SRL (PRUEBA)',
      TRANSFER_RNC: '000-00000-0',
    },
    root,
    true,
  );
  await waitFor(`${API}/health`);

  // ───── Preparación por API: cupón, repartidor, catálogo y zona ─────
  const admin = await apiLogin(API, ADMIN);
  await call(admin, '/v1/admin/coupons', 'POST', {
    code: COUPON,
    description: 'Prueba E2E: 10 % de descuento',
    kind: 'percent',
    value: COUPON_BPS,
    perUserLimit: 1,
  });
  await call(admin, '/v1/admin/users', 'POST', {
    phone: DRIVER,
    name: 'Pedro Motorista',
    role: 'driver',
  });
  const driver = await apiLogin(API, DRIVER);
  const driverId = need(
    (await call<{ id: string; phone: string }[]>(admin, '/v1/admin/drivers')).find(
      (d) => d.phone === '+18495550166',
    ),
    'repartidor de prueba',
  ).id;
  const zone = need(
    (
      await call<
        {
          name: string;
          feeCentavos: number;
          minOrderCentavos: number;
          freeOverCentavos: number | null;
        }[]
      >(admin, '/v1/admin/zones')
    )[0],
    'zona de entrega',
  );

  const catalog = (await call<ProductListDTO>(null, '/v1/products?limit=100')).items;
  const categories = await call<CategoryDTO[]>(null, '/v1/categories');
  const product = (group: string): ProductDTO =>
    need(
      catalog.find((p) => p.group === group),
      `ficha "${group}"`,
    );
  const variantOf = (group: string, label = ''): VariantDTO =>
    need(
      product(group).variants.find((v) => v.variant === label),
      `presentación "${label}" de "${group}"`,
    );
  const camaron = variantOf('camaron', '16/20');
  const pechuga = variantOf('pechuga-de-pollo-americana');
  const pulpo = variantOf('pulpo', 'De 4 a 6 lb');
  const ribeye = variantOf('ribeye-choice');
  const variantCount = catalog.reduce((n, p) => n + p.variants.length, 0);
  check(
    catalog.length > 0 && variantCount >= catalog.length,
    `el API publica ${catalog.length} fichas con ${variantCount} presentaciones`,
  );

  /** Envío de la zona de prueba para un subtotal (gratis a partir del monto configurado). */
  const deliveryFeeFor = (subtotal: number) =>
    zone.freeOverCentavos !== null && subtotal >= zone.freeOverCentavos ? 0 : zone.feeCentavos;

  // Cantidades del pedido en efectivo: 2.5 lb de camarón 16/20 y 3 lb de pechuga (ITBIS distinto).
  const orderA: CartLine[] = [
    { variant: camaron, quantity: 250 },
    { variant: pechuga, quantity: 300 },
  ];
  const addressA = { sector: 'Piantini', city: 'Santo Domingo' };

  // ───── App web ─────
  if (process.env.E2E_SKIP_EXPORT !== '1') {
    log('Empaquetando la app para web (la primera vez tarda más)…');
    await exportWeb();
  }
  assertBundleTargetsApi();
  const server = serveStatic(WEB_DIST, WEB_PORT);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const newContext = async (scheme: 'dark' | 'light') => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
    });
    // Las fotos del catálogo viven en un CDN externo: aquí se sirve una imagen mínima para que la
    // prueba no dependa de internet y cualquier "Failed to load resource" sea un fallo real.
    await ctx.route(
      (url) => !/^localhost$/.test(url.hostname),
      (route) =>
        route.request().resourceType() === 'image'
          ? route.fulfill({ contentType: 'image/png', body: PIXEL })
          : route.abort(),
    );
    // Guarda las direcciones que la app abre en otra pestaña (mapa, pasarela) sin cambiar su efecto.
    await ctx.addInitScript(
      `(function () { var real = window.open.bind(window); window.__opened = [];
        window.open = function () { window.__opened.push(String(arguments[0])); return real.apply(null, arguments); }; })();`,
    );
    return ctx;
  };

  const errors: string[] = [];
  /** Respuestas 4xx/5xx del API que el recorrido provoca a propósito ("MÉTODO ruta estado"). */
  const expectedFailures = new Set<string>();
  let current: Page | null = null;
  try {
    const ctx = await newContext('dark');
    const page = await ctx.newPage();
    current = page;
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // "Failed to load resource" ya se cuenta abajo con la dirección y el estado.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
        errors.push(m.text());
    });
    page.on('requestfailed', (r) => {
      if (new URL(r.url()).hostname === 'localhost')
        errors.push(`petición fallida ${r.method()} ${r.url()}: ${r.failure()?.errorText}`);
    });
    page.on('response', (r) => {
      if (!r.url().startsWith(API) || r.status() < 400) return;
      const key = `${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`;
      if (!expectedFailures.delete(key)) errors.push(`respuesta inesperada del API: ${key}`);
    });
    const opened = () => page.evaluate<string[]>('window.__opened');

    // ───── Inicio: categorías y tarjetas con precio ─────
    await page.goto(WEB);
    await page.getByText('Congelados de primera, a tu puerta').waitFor({ timeout: 60_000 });
    await page.getByText(/MODO DEMOSTRACIÓN/).waitFor({ timeout: 30_000 });
    await shot(page, 'inicio');
    const withProducts = categories.filter((c) => catalog.some((p) => p.category === c.slug));
    for (const c of withProducts) {
      await btn(page, `Categoría ${c.name}`).waitFor({ timeout: 5000 });
    }
    check(
      withProducts.length >= 5,
      `el inicio ofrece las ${withProducts.length} categorías con productos (${withProducts.map((c) => c.name).join(', ')})`,
    );
    const wrongCards: string[] = [];
    let cards = 0;
    for (const c of withProducts) {
      // Cada carrusel muestra hasta 10 fichas de su categoría.
      for (const p of catalog.filter((x) => x.category === c.slug).slice(0, 10)) {
        const soldOut = p.variants.every((v) => !v.inStock);
        const want = `${p.name}${soldOut ? ', agotado' : `, desde ${formatDOP(p.fromPrice)}`}`;
        const got = await page
          .getByTestId(`product-card-${p.group}`)
          .first()
          .getAttribute('aria-label', { timeout: 5000 })
          .catch(() => null);
        cards++;
        if (got !== want) wrongCards.push(`${p.group}: "${got}" ≠ "${want}"`);
      }
    }
    check(
      wrongCards.length === 0,
      `las ${cards} tarjetas del inicio muestran nombre y precio "desde" del API${wrongCards.length ? `: ${wrongCards.slice(0, 3).join(' | ')}` : ''}`,
    );

    await tid(page, `product-card-${product('camaron').group}`).scrollIntoViewIfNeeded();
    await shot(page, 'inicio-productos');

    // ───── Categoría → búsqueda filtrada ─────
    const mariscos = need(
      categories.find((c) => c.slug === 'mariscos'),
      'categoría Mariscos',
    );
    await btn(page, `Categoría ${mariscos.name}`).click();
    const inMariscos = await call<ProductListDTO>(null, '/v1/products?limit=100&category=mariscos');
    await seen(page, `${inMariscos.total} productos`).waitFor({ timeout: 15_000 });
    await tid(tid(page, 'search-results'), 'product-card-camaron').waitFor();
    await shot(page, 'categoria-mariscos');
    check(true, `la categoría Mariscos lista ${inMariscos.total} productos, con el camarón`);
    await btn(page, 'Todo').click();

    // ───── Búsqueda con sinónimos y sin tildes ─────
    for (const [text, group] of [
      ['camaron', 'camaron'],
      ['pollo', 'pechuga-de-pollo-americana'],
      ['alitas', 'alas-de-pollo'],
      ['costillas', 'costilla-de-cerdo'],
      ['ribeye', 'ribeye-choice'],
    ] as const) {
      const found = await searchFor(page, text);
      check(
        found.items.some((p) => p.group === group),
        `buscar "${text}" encuentra ${group} (${found.items.length} resultado${found.items.length === 1 ? '' : 's'}, iguales a los del API)`,
      );
      if (text === 'pollo') await shot(page, 'busqueda-pollo');
    }
    await tid(page, 'search-input').fill('zzzqx');
    await seen(page, 'No encontramos eso').waitFor({ timeout: 15_000 });
    check(true, 'una búsqueda sin coincidencias lo dice con claridad');
    await tid(page, 'search-input').fill('');

    // ───── Producto con presentaciones: elegir una y respetar paso y mínimo ─────
    await searchFor(page, 'camaron');
    await openProduct(page, 'camaron');
    for (const v of product('camaron').variants) await btn(page, v.variant).waitFor();
    await btn(page, camaron.variant).click();
    await seen(page, 'Pagas el peso real').waitFor();
    await seen(page, formatDOP(camaron.price)).waitFor();
    await seen(page, 'por libra').waitFor();
    await shot(page, 'producto-camaron');
    check(
      (await tid(page, 'add-to-cart').innerText()).includes(`${formatDOP(camaron.price)} / lb`),
      `el camarón ${camaron.variant} muestra su precio por libra (${formatDOP(camaron.price)})`,
    );
    await tid(page, 'add-to-cart').click();
    const min = camaron.minCentilb ?? 100;
    const step = camaron.stepCentilb ?? 50;
    await seen(page, formatLb(min)).waitFor({ timeout: 5000 });
    await stepTo(page, 'Agregar', formatLb(min + step));
    await stepTo(page, 'Quitar', formatLb(min));
    await btn(page, 'Quitar').click();
    await tid(page, 'add-to-cart').waitFor({ timeout: 5000 });
    check(
      true,
      `la cantidad sube de ${formatLb(step)} en ${formatLb(step)} desde el mínimo de ${formatLb(min)}; por debajo del mínimo se quita`,
    );
    await fillTo(page, camaron, orderA[0]!.quantity);
    const estimate = formatDOP(priceForWeight(camaron.price, orderA[0]!.quantity));
    await seen(page, estimate).waitFor({ timeout: 5000 });
    check(true, `el estimado de ${formatLb(orderA[0]!.quantity)} de camarón es ${estimate}`);
    await shot(page, 'camaron-agregado');
    await btn(page, 'Volver').click();

    // Pechuga (sin presentaciones): 3 lb
    await searchFor(page, 'pechuga');
    await openProduct(page, 'pechuga-de-pollo-americana');
    check(
      (await seen(page, 'Elige una opción').count()) === 0,
      'una ficha de una sola presentación no pide elegir opción',
    );
    await fillTo(page, pechuga, orderA[1]!.quantity);
    await btn(page, 'Volver').click();

    // Pulpo 4–6 lb: el mínimo de la presentación manda (no 1 lb)
    await searchFor(page, 'pulpo');
    await openProduct(page, 'pulpo');
    await btn(page, pulpo.variant).click();
    await tid(page, 'add-to-cart').click();
    const pulpoMin = pulpo.minCentilb ?? 100;
    await seen(page, formatLb(pulpoMin)).waitFor({ timeout: 5000 });
    await shot(page, 'pulpo-minimo');
    await btn(page, 'Quitar').click();
    await tid(page, 'add-to-cart').waitFor({ timeout: 5000 });
    check(
      pulpoMin > 100,
      `el pulpo ${pulpo.variant} entra al carrito con su mínimo de ${formatLb(pulpoMin)} y se quita al bajar de ahí`,
    );
    await btn(page, 'Volver').click();

    // ───── Carrito: totales contra el API (sin dirección todavía) ─────
    await tab(page, /Carrito/).click();
    await seen(page, 'Total estimado').waitFor({ timeout: 20_000 });
    const q0 = await call<QuoteDTO>(null, '/v1/quote', 'POST', { items: orderA.map(qtyOf) });
    const e0 = expectedTotals(orderA);
    const d0 = sameTotals(q0, e0);
    check(
      d0.length === 0,
      `la cotización del API (ITBIS ${formatDOP(q0.itbis)}, total ${formatDOP(q0.total)}) coincide con el cálculo independiente${d0.length ? `: ${d0.join(' | ')}` : ''}`,
    );
    check(
      q0.itbis > 0 && camaron.itbisBps !== pechuga.itbisBps,
      `el pedido mezcla ITBIS distinto (camarón ${camaron.itbisBps / 100} %, pechuga ${pechuga.itbisBps / 100} %)`,
    );
    await expectRows(
      page,
      {
        Subtotal: formatDOP(q0.subtotal),
        Envío: 'Se calcula con tu dirección',
        'Total estimado': formatDOP(q0.total),
      },
      'el carrito',
    );
    for (const l of q0.lines) {
      await seen(page, formatDOP(l.net)).waitFor({ timeout: 5000 });
    }
    check(
      (await tid(page, 'go-checkout').innerText()).includes(formatDOP(q0.total)),
      `el botón de continuar muestra el total ${formatDOP(q0.total)}`,
    );
    await shot(page, 'carrito');

    // ───── Registro por teléfono con OTP real ─────
    await tid(page, 'go-checkout').click();
    await seen(page, 'Entra a JELLYFISH').waitFor();
    const phone = `+1829555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await tid(page, 'phone-input').fill('12');
    await tid(page, 'send-code').click();
    await seen(page, /Ingresa un número dominicano/).waitFor({ timeout: 5000 });
    await tid(page, 'phone-input').fill(phone.slice(2));
    await shot(page, 'login');
    await tid(page, 'send-code').click();
    await seen(page, 'Escribe tu código').waitFor();
    await shot(page, 'codigo');
    // Un código equivocado se rechaza con un mensaje claro y deja volver a intentar.
    expectedFailures.add('POST /v1/auth/otp/verify 400');
    await tid(page, 'otp-input').fill('000000');
    await seen(page, 'Código incorrecto o vencido').waitFor({ timeout: 10_000 });
    check(true, 'un código OTP equivocado se rechaza con "Código incorrecto o vencido"');
    await tid(page, 'otp-input').fill(await otpFor(phone));

    // ───── Checkout sin dirección ─────
    await tid(page, 'place-order').waitFor({ timeout: 20_000 });
    check(
      (await tid(page, 'blocked-reason').innerText()).includes('Agrega una dirección'),
      'sin direcciones, el checkout explica por qué no se puede confirmar',
    );
    check(
      await tid(page, 'place-order').isDisabled(),
      'confirmar está apagado hasta tener dirección',
    );
    const methods = await call<Record<string, { available: boolean }>>(
      null,
      '/v1/payments/methods',
    );
    for (const m of ['card', 'cash', 'transfer']) {
      check(
        methods[m]?.available === true && (await tid(page, `pay-${m}`).count()) === 1,
        `la forma de pago "${m}" está disponible`,
      );
    }

    // ───── Dirección: una zona sin cobertura avisa; Piantini sí llega ─────
    await tid(page, 'add-address').click();
    await tid(page, 'addr-line1').fill('Calle Max Henríquez Ureña #10');
    await tid(page, 'addr-sector').fill('Punta Cana');
    await tid(page, 'addr-city').fill('Higüey');
    await seen(page, 'Aún no llegamos aquí').waitFor({ timeout: 15_000 });
    check(true, 'una dirección fuera de las zonas de entrega avisa "Aún no llegamos aquí"');
    await tid(page, 'addr-sector').fill(addressA.sector);
    await tid(page, 'addr-city').fill(addressA.city);
    await tid(page, 'addr-reference').fill('Al lado del colmado Don Pepe, portón negro');
    await seen(page, '¡Llegamos a tu sector!').waitFor({ timeout: 15_000 });
    await seen(page, zone.name).waitFor({ timeout: 5000 });
    check(true, `Piantini cae en la zona "${zone.name}"`);
    await shot(page, 'direccion');
    await tid(page, 'save-address').click();
    await seen(page, new RegExp(`Casa · ${addressA.sector}`)).waitFor({ timeout: 15_000 });

    // ───── Horario, nombre y totales con la zona ─────
    const slotLabel = await pickSlot(page);
    await tid(page, 'checkout-name').fill('Andrés Prueba');
    const customerToken = need(
      await page.evaluate<string | null>("localStorage.getItem('jellyfish.token')"),
      'sesión del cliente en el navegador',
    );
    const q1 = await call<QuoteDTO>(customerToken, '/v1/quote', 'POST', {
      items: orderA.map(qtyOf),
      address: addressA,
    });
    check(
      q1.coverage === 'covered' &&
        q1.deliveryFee === deliveryFeeFor(q1.subtotal) &&
        q1.missingForMinimum === 0 &&
        q1.subtotal >= zone.minOrderCentavos,
      `el pedido cumple el mínimo de la zona (${formatDOP(zone.minOrderCentavos)}) y paga envío de ${formatDOP(q1.deliveryFee)}`,
    );
    await expectRows(
      page,
      {
        Subtotal: formatDOP(q1.subtotal),
        Envío: formatDOP(q1.deliveryFee),
        'Total estimado': formatDOP(q1.total),
      },
      'el checkout con dirección',
    );

    // ───── Cupón: uno inexistente se explica; el de la prueba descuenta ─────
    await tid(page, 'coupon-open').click();
    await tid(page, 'coupon-input').fill('NOEXISTE');
    await tid(page, 'coupon-apply').click();
    await seen(page, 'No encontramos ese cupón. Revisa que esté bien escrito').waitFor({
      timeout: 10_000,
    });
    check(true, 'un cupón inexistente explica por qué no sirve');
    await tid(page, 'coupon-input').fill(COUPON.toLowerCase());
    await tid(page, 'coupon-apply').click();
    await tid(page, 'coupon-applied').waitFor({ timeout: 15_000 });
    await tid(page, 'quote-discount').waitFor({ timeout: 15_000 });
    const q2 = await call<QuoteDTO>(customerToken, '/v1/quote', 'POST', {
      items: orderA.map(qtyOf),
      address: addressA,
      couponCode: COUPON,
    });
    const discount = Math.floor((q1.subtotal * COUPON_BPS) / 10_000);
    const d2 = sameTotals(q2, expectedTotals(orderA, { discount, deliveryFee: q1.deliveryFee }));
    check(
      q2.coupon?.code === COUPON && q2.discount === discount && d2.length === 0,
      `el API descuenta ${formatDOP(discount)} (10 % de ${formatDOP(q1.subtotal)}) y su ITBIS/total coinciden con el cálculo independiente${d2.length ? `: ${d2.join(' | ')}` : ''}`,
    );
    await expectRows(
      page,
      {
        Subtotal: formatDOP(q2.subtotal),
        [`Descuento · ${COUPON}`]: `${MINUS} ${formatDOP(q2.discount)}`,
        Envío: formatDOP(q2.deliveryFee),
        'Total estimado': formatDOP(q2.total),
      },
      'el checkout con el cupón',
    );
    check(
      (await tid(page, 'coupon-applied').innerText()).includes(
        `Ahorras ${formatDOP(q2.coupon?.discount ?? 0)}`,
      ),
      `la tarjeta del cupón dice cuánto ahorras (${formatDOP(q2.discount)})`,
    );
    await shot(page, 'checkout-cupon');

    // ───── Pedido en efectivo ─────
    check(
      (await tid(page, 'place-order').innerText()).includes(
        `Confirmar pedido · ${formatDOP(q2.total)}`,
      ) && (await tid(page, 'place-order').isEnabled()),
      'con dirección, horario y pago el botón de confirmar muestra el total y se habilita',
    );
    await tid(page, 'place-order').click();
    await waitUntil('pedido en efectivo confirmado', async () =>
      (await orderStatus(page)).includes('Pedido confirmado'),
    );
    await shot(page, 'pedido-efectivo');
    const codeA = need(
      (await seen(page, /^Pedido JF-\d{6}$/).innerText()).match(/JF-\d{6}/)?.[0],
      'código del pedido en la cabecera',
    );
    const mine = await call<OrderDTO[]>(customerToken, '/v1/orders');
    const apiA = need(
      mine.find((o) => o.code === codeA),
      `pedido ${codeA} en el API`,
    );
    check(
      apiA.total === q2.total &&
        apiA.discount === q2.discount &&
        apiA.itbis === q2.itbis &&
        apiA.deliveryFee === q2.deliveryFee &&
        apiA.couponCode === COUPON &&
        apiA.paymentMethod === 'cash',
      `el pedido ${codeA} quedó con el total ${formatDOP(apiA.total)} y el ITBIS ${formatDOP(apiA.itbis)} de la cotización, cupón incluido`,
    );
    await expectRows(
      page,
      {
        Subtotal: formatDOP(apiA.subtotal),
        [`Descuento · ${COUPON}`]: `${MINUS} ${formatDOP(apiA.discount)}`,
        Envío: formatDOP(apiA.deliveryFee),
        'Total estimado': formatDOP(apiA.total),
      },
      `el pedido ${codeA}`,
    );
    check(
      (await seen(page, /^Pagas .* en efectivo al recibir/).innerText()).includes(
        formatDOP(apiA.total),
      ),
      `muestra cuánto pagar en efectivo (${formatDOP(apiA.total)})`,
    );
    check(
      (await page.getByText(slotLabel).filter({ visible: true }).count()) > 0,
      `el pedido conserva el horario elegido (${slotLabel})`,
    );
    const pinUi = await readPin(page);
    check(
      /^\d{4}$/.test(pinUi) && pinUi === apiA.deliveryPin,
      'el pedido muestra su PIN de entrega de 4 dígitos, igual al del API',
    );
    check(
      (await tid(page, 'pin-digits').innerText()) === pinUi[0],
      'la tarjeta del PIN dibuja los dígitos',
    );
    await shot(page, 'pin-de-entrega');

    // ───── Pedido con tarjeta simulada ─────
    await btn(page, 'Volver al inicio').click();
    await searchFor(page, 'ribeye');
    await openProduct(page, 'ribeye-choice');
    // Cantidad mínima que pasa el pedido mínimo de la zona.
    let qtyB = ribeye.minCentilb ?? 100;
    while (priceForWeight(ribeye.price, qtyB) < zone.minOrderCentavos)
      qtyB += ribeye.stepCentilb ?? 50;
    await fillTo(page, ribeye, qtyB);
    const orderB: CartLine[] = [{ variant: ribeye, quantity: qtyB }];
    await btn(page, 'Ver carrito').click();
    await seen(page, 'Total estimado').waitFor({ timeout: 20_000 });
    const qB = await call<QuoteDTO>(customerToken, '/v1/quote', 'POST', {
      items: orderB.map(qtyOf),
      address: addressA,
    });
    await expectRows(
      page,
      {
        Subtotal: formatDOP(qB.subtotal),
        Envío: formatDOP(qB.deliveryFee),
        'Total estimado': formatDOP(qB.total),
      },
      'el carrito con la dirección guardada',
    );
    if (qB.missingForFreeDelivery !== null && qB.missingForFreeDelivery > 0) {
      check(
        (await page
          .getByText(formatDOP(qB.missingForFreeDelivery))
          .filter({ visible: true })
          .count()) > 0,
        `avisa cuánto falta para el envío gratis (${formatDOP(qB.missingForFreeDelivery)})`,
      );
    }
    await shot(page, 'carrito-con-direccion');
    await tid(page, 'go-checkout').click();
    await tid(page, 'place-order').waitFor({ timeout: 20_000 });
    check(
      (await seen(page, new RegExp(`Casa · ${addressA.sector}`)).count()) > 0,
      'el checkout reutiliza la dirección guardada',
    );
    check(
      (await tid(page, 'checkout-name').count()) === 0,
      'ya no pide el nombre a quien lo dio antes',
    );
    await pickSlot(page);
    await tid(page, 'pay-card').click();
    await expectRows(
      page,
      { Subtotal: formatDOP(qB.subtotal), 'Total estimado': formatDOP(qB.total) },
      'el checkout con tarjeta',
    );
    check(
      (await tid(page, 'place-order').innerText()).includes(`Pagar ${formatDOP(qB.total)}`),
      `el botón dice "Pagar ${formatDOP(qB.total)}"`,
    );
    await shot(page, 'checkout-tarjeta');
    const [bank] = await Promise.all([ctx.waitForEvent('page'), tid(page, 'place-order').click()]);
    await waitUntil('pedido con tarjeta esperando pago', async () =>
      (await orderStatus(page)).includes('Esperando pago'),
    );
    await shot(page, 'pedido-esperando-pago');
    const codeB = need(
      (await seen(page, /^Pedido JF-\d{6}$/).innerText()).match(/JF-\d{6}/)?.[0],
      'código del pedido con tarjeta',
    );
    const apiB = need(
      (await call<OrderDTO[]>(customerToken, '/v1/orders')).find((o) => o.code === codeB),
      `pedido ${codeB} en el API`,
    );
    check(
      apiB.total === qB.total && apiB.paymentMethod === 'card' && apiB.status === 'pending_payment',
      `el pedido ${codeB} espera el pago de ${formatDOP(apiB.total)}`,
    );

    await bank.getByText('Pasarela simulada').waitFor({ timeout: 20_000 });
    const onBank = need(
      (await call<OrderDTO[]>(customerToken, '/v1/orders')).find((o) => o.code === codeB),
      `pedido ${codeB} en la pasarela`,
    );
    const charged = need(onBank.payments[0], 'pago del pedido con tarjeta').amount;
    check(
      (await bank.locator('body').innerText()).includes(formatDOP(charged)) &&
        charged === onBank.total,
      `la pasarela simulada cobra el total del pedido, ${formatDOP(charged)}`,
    );
    await shot(bank, 'pasarela-simulada');
    await bank.getByText('Aprobar pago').click();
    await bank.getByText('¡Pago recibido!').waitFor();
    await shot(bank, 'pago-aprobado');
    await bank.close();

    // La pantalla del pedido se actualiza sola al aprobarse el pago.
    await waitUntil(
      'pedido pagado con tarjeta',
      async () => (await orderStatus(page)).includes('Pedido confirmado'),
      40_000,
    );
    await seen(page, 'Pagado').waitFor({ timeout: 10_000 });
    await shot(page, 'pedido-pagado');
    check(true, 'tras aprobar el pago el pedido pasa a confirmado y pagado, sin recargar');
    const paidB = need(
      (await call<OrderDTO[]>(customerToken, '/v1/orders')).find((o) => o.code === codeB),
      `pedido ${codeB}`,
    );
    check(
      paidB.status === 'confirmed' && paidB.payments.some((p) => p.status !== 'pending'),
      `el API confirma el pedido ${codeB} con el pago registrado`,
    );

    // ───── Pedidos ─────
    await btn(page, 'Volver al inicio').click();
    await tab(page, /Pedidos/).click();
    await seen(page, 'Mis pedidos').waitFor();
    await tid(page, `order-row-${codeA}`).waitFor({ timeout: 15_000 });
    await tid(page, `order-row-${codeB}`).waitFor({ timeout: 15_000 });
    check(
      (await tid(page, `reorder-${codeA}`).count()) === 0,
      'un pedido sin entregar todavía no ofrece "Pedir de nuevo"',
    );
    await shot(page, 'pedidos');

    // ───── Entrega: el personal prepara y el repartidor sale; el cliente ve el seguimiento ─────
    await tid(page, `order-row-${codeA}`).click();
    await waitUntil('pantalla del pedido en efectivo', async () =>
      (await orderStatus(page)).includes('Pedido confirmado'),
    );
    const lines = apiA.items;
    const finalQty = new Map(
      lines.map((it) => [
        it.id,
        it.name === product('camaron').name ? it.quantity - 10 : it.quantity + 20,
      ]),
    );
    await call(admin, `/v1/admin/orders/${apiA.id}/transition`, 'POST', { to: 'picking' });
    await call(admin, `/v1/admin/orders/${apiA.id}/weights`, 'POST', {
      weights: lines.map((it) => ({ itemId: it.id, finalQuantity: finalQty.get(it.id) })),
    });
    await call(admin, `/v1/admin/orders/${apiA.id}/transition`, 'POST', { to: 'packed' });
    await call(admin, `/v1/admin/orders/${apiA.id}/assign-driver`, 'POST', { driverId });
    await call(driver, `/v1/driver/orders/${apiA.id}/transition`, 'POST', {
      to: 'out_for_delivery',
    });
    await call(driver, '/v1/driver/location', 'POST', {
      latitude: 18.4861,
      longitude: -69.9312,
      orderId: apiA.id,
    });
    await waitUntil(
      'pedido en camino',
      async () => (await orderStatus(page)).includes('En camino'),
      40_000,
    );
    await tid(page, 'tracking-headline').waitFor({ timeout: 30_000 });
    check(
      /actualizado (ahora mismo|hace \d+ s)/.test(await tid(page, 'tracking-headline').innerText()),
      'en camino: el seguimiento muestra la posición del repartidor y qué tan reciente es',
    );
    check(
      (await readPin(page)) === pinUi,
      'en camino: el PIN de entrega sigue visible y no cambió',
    );
    await shot(page, 'en-camino');
    await tid(page, 'tracking-map').click();
    const mapUrl = (await opened()).find((u) => /google\.com\/maps/.test(u));
    check(
      !!mapUrl && mapUrl.includes('18.4861') && mapUrl.includes('-69.9312'),
      '"Ver en el mapa" abre Google Maps en las coordenadas del repartidor',
    );
    for (const p of ctx.pages()) if (p !== page) await p.close().catch(() => {});

    // El efectivo se cobra antes de entregar, con el total que salió de pesar
    const weighed = need(
      (await call<OrderDTO[]>(customerToken, '/v1/orders')).find((o) => o.id === apiA.id),
      'pedido pesado',
    );
    const finalTotal = need(weighed.finalTotal, 'total final tras pesar');
    await call(driver, `/v1/driver/orders/${apiA.id}/collect`, 'POST', { amount: finalTotal });

    // Un PIN equivocado no entrega y el cliente ve la advertencia
    const wrongPin = String((Number(pinUi) + 1) % 10_000).padStart(4, '0');
    await call(driver, `/v1/driver/orders/${apiA.id}/transition`, 'POST', {
      to: 'delivered',
      pin: wrongPin,
    }).then(
      () => {
        throw new Error('✖ El API entregó el pedido con un PIN equivocado');
      },
      (e: Error) => {
        if (!/PIN incorrecto/.test(e.message)) throw e;
      },
    );
    await tid(page, 'pin-attempts').waitFor({ timeout: 40_000 });
    check(
      (await tid(page, 'pin-attempts').innerText()).includes('Quedan 4 intentos'),
      'un PIN equivocado no entrega y la tarjeta avisa "Quedan 4 intentos"',
    );
    await shot(page, 'pin-equivocado');

    // Entrega con el PIN que el cliente tiene en pantalla
    await call(driver, `/v1/driver/orders/${apiA.id}/transition`, 'POST', {
      to: 'delivered',
      pin: await readPin(page),
    });
    await waitUntil(
      'pedido entregado',
      async () => (await orderStatus(page)).includes('Entregado'),
      40_000,
    );
    await shot(page, 'entregado');
    check(
      (await tid(page, 'pin-card').count()) === 0 &&
        (await tid(page, 'tracking-card').count()) === 0,
      'entregado: ya no se muestran el PIN ni el seguimiento',
    );
    await expectRows(
      page,
      { 'Total final (peso real)': formatDOP(finalTotal) },
      `el pedido ${codeA} entregado`,
    );
    check(
      (await page
        .getByText(`Estimado inicial: ${formatDOP(apiA.total)}`)
        .filter({ visible: true })
        .count()) > 0 && (await seen(page, 'Pagado').count()) > 0,
      `entregado: el peso real cambió el total de ${formatDOP(apiA.total)} a ${formatDOP(finalTotal)} y el efectivo figura pagado`,
    );

    // ───── Pedir de nuevo ─────
    await tid(page, 'reorder').click();
    await tid(page, 'reorder-sheet').waitFor({ timeout: 20_000 });
    await seen(page, 'Listo, ya están en tu carrito').waitFor();
    await shot(page, 'pedir-de-nuevo');
    check(
      (await tid(page, 'reorder-sheet').getByTestId('reorder-item-added').count()) ===
        orderA.length,
      `"Pedir de nuevo" agrega las ${orderA.length} líneas del pedido entregado`,
    );
    await tid(page, 'reorder-go-cart').click();
    await seen(page, 'Total estimado').waitFor({ timeout: 20_000 });
    const qR = await call<QuoteDTO>(customerToken, '/v1/quote', 'POST', {
      items: orderA.map(qtyOf),
      address: addressA,
    });
    await expectRows(
      page,
      {
        Subtotal: formatDOP(qR.subtotal),
        Envío: formatDOP(qR.deliveryFee),
        'Total estimado': formatDOP(qR.total),
      },
      'el carrito del pedido repetido',
    );
    for (const l of orderA) await seen(page, formatLb(l.quantity)).waitFor({ timeout: 5000 });
    await shot(page, 'carrito-repetido');
    check(
      true,
      `el carrito vuelve a tener las cantidades pedidas (${orderA.map((l) => formatLb(l.quantity)).join(' y ')}) con precios de hoy`,
    );
    await tab(page, /Pedidos/).click();
    await tid(page, `reorder-${codeA}`).waitFor({ timeout: 15_000 });
    check(true, 'en Pedidos, el pedido entregado ofrece "Pedir de nuevo"');
    await tab(page, /Perfil/).click();
    await seen(page, 'Mis direcciones').waitFor();
    await shot(page, 'perfil');

    // ───── Modo claro ─────
    const light = await (await newContext('light')).newPage();
    await light.goto(WEB);
    await light.getByText('Congelados de primera, a tu puerta').waitFor({ timeout: 30_000 });
    await shot(light, 'inicio-claro');

    check(
      errors.length === 0 && expectedFailures.size === 0,
      `sin errores de consola/JS ni respuestas inesperadas del API${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}${expectedFailures.size ? `; no ocurrió lo esperado: ${[...expectedFailures].join(', ')}` : ''}`,
    );
    console.log(`\n✔ Recorrido completo. ${shots.length} capturas en ${OUT}\n`);
  } catch (e) {
    // Evidencia para depurar: qué se veía y qué errores lanzó el navegador.
    if (current) {
      await current.screenshot({ path: `${OUT}/FALLO.png` }).catch(() => {});
      console.error(
        `Texto visible al fallar:\n${(
          await current
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 600)}`,
      );
      console.error(`URL: ${current.url()}`);
    }
    if (errors.length)
      console.error(`Errores del navegador:\n- ${errors.slice(0, 6).join('\n- ')}`);
    console.error(`Fin del log del API:\n${apiLogTail()}`);
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
