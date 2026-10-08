/**
 * Verifica la VISTA PREVIA web (dist-preview/) como la vería el dueño en su teléfono: Chromium con emulación
 * de iPhone 14 y Pixel 7, en modo claro y oscuro, con el fragmento `artifact.html` envuelto como lo hace la
 * plataforma, servido bajo VARIAS rutas por un alojamiento ESTRICTO (solo archivos propios, política de
 * seguridad que bloquea todo lo externo) y SIN internet.
 *
 *   npx tsx scripts/e2e-preview.ts                       recorrido completo (4 recorridos largos + rutas + extras)
 *   npx tsx scripts/e2e-preview.ts --quick               solo los recorridos cortos (inicio → producto → carrito → recargar)
 *   npx tsx scripts/e2e-preview.ts --mount xyz           solo esa ruta (con --quick, solo el recorrido corto)
 *   npx tsx scripts/e2e-preview.ts --serve [--mount xyz] sirve dist-preview/ y escribe las direcciones (para verla tú)
 *   opciones: --dir ruta/dist-preview  --out ruta/capturas  --port 4311  --only <nombre del extra>
 *   E2E_OUT=/ruta npx tsx scripts/e2e-preview.ts         (capturas fuera del repositorio)
 *
 * Todo recorrido falla si la página: escribe un error en la consola, pide algo a otro origen (incluido el CDN
 * de fotos), recibe un 404 que no estaba previsto, muestra un diálogo del navegador (alert/confirm/prompt),
 * abre una pestaña nueva o viola la política de seguridad.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Browser, type BrowserContext, type Page, chromium, devices } from 'playwright-core';
import { type Host, MOUNTS, type Mount, startHost } from './preview-host';

const root = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: `${root}/dist-preview` },
    out: { type: 'string', default: process.env.E2E_OUT ?? `${root}/tmp/e2e-preview` },
    port: { type: 'string', default: '4311' },
    serve: { type: 'boolean', default: false },
    mount: { type: 'string' },
    quick: { type: 'boolean', default: false },
    only: { type: 'string' },
  },
});
const DIST = resolve(args.dir!);
const OUT = resolve(args.out!);
mkdirSync(OUT, { recursive: true });

const log = (m: string) => console.log(`• ${m}`);
/** SKU con miniatura propia en lo que se publica: el recorrido solo exige foto donde la hay (el resto cae al degradado). */
const HAS_PHOTO = (() => {
  try {
    const files = (
      JSON.parse(readFileSync(`${DIST}/publish-files.json`, 'utf8')) as {
        files: Record<string, string>;
      }
    ).files;
    return new Set(
      Object.keys(files).flatMap((f) => {
        const m = /^photos\/(JF-[A-Z]{3}-\d{3})\.thumb\.webp$/.exec(f);
        return m ? [m[1]!] : [];
      }),
    );
  } catch {
    return new Set<string>();
  }
})();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── comprobaciones ─────────────────────────

const results: { name: string; ok: boolean }[] = [];
let currentLabel = '';

function check(cond: unknown, message: string): asserts cond {
  if (!cond) {
    results.push({ name: `${currentLabel}: ${message}`, ok: false });
    throw new Error(`✖ ${message}`);
  }
  results.push({ name: `${currentLabel}: ${message}`, ok: true });
  log(`✔ ${message}`);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${currentLabel}-${name}.png` });
}

// ───────────────────────── dispositivos ─────────────────────────

interface DeviceCase {
  name: 'iphone' | 'pixel';
  descriptor: (typeof devices)[string];
}
const DEVICES: Record<DeviceCase['name'], DeviceCase> = {
  iphone: { name: 'iphone', descriptor: devices['iPhone 14']! },
  pixel: { name: 'pixel', descriptor: devices['Pixel 7']! },
};
type Scheme = 'dark' | 'light';

// ───────────────────────── una sesión de navegador vigilada ─────────────────────────

interface Session {
  ctx: BrowserContext;
  page: Page;
  host: Host;
  mount: Mount;
  consoleErrors: string[];
  external: string[];
  badResponses: string[];
  dialogs: string[];
  popups: string[];
  tag: string;
}

interface SessionOptions {
  device: DeviceCase;
  scheme: Scheme;
  mount: Mount;
  /** Cambia el contexto (almacenamiento bloqueado, historial que lanza errores…). */
  initScript?: string;
  /** Peticiones locales que se cortan a propósito (p. ej. las fotos). */
  abort?: RegExp;
  fallback?: boolean;
  /** Zonas seguras simuladas (iPhone con muesca). */
  safeArea?: { top: number; bottom: number };
  /** Errores de consola que se esperan en esta modalidad. */
  tolerate?: RegExp[];
}

const CSP_RECORDER = `(function () {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', function (e) {
    window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI + ' en ' + String(e.sourceFile).split('/').slice(-2).join('/') + ':' + e.lineNumber + ':' + e.columnNumber + ' ' + String(e.sample || '').slice(0, 80));
  });
})();`;

async function openSession(browser: Browser, o: SessionOptions): Promise<Session> {
  const host = await startHost({
    dist: DIST,
    port: Number(args.port),
    mounts: [o.mount],
    fallback: o.fallback ? [o.mount.name] : [],
    sandboxFrame: o.mount.page,
  });
  const ctx = await browser.newContext({
    ...o.device.descriptor,
    locale: 'es-DO',
    timezoneId: 'America/Santo_Domingo',
    colorScheme: o.scheme,
  });
  const s: Session = {
    ctx,
    page: await ctx.newPage(),
    host,
    mount: o.mount,
    consoleErrors: [],
    external: [],
    badResponses: [],
    dialogs: [],
    popups: [],
    tag: `${o.device.name}-${o.scheme}-${o.mount.name}`,
  };
  // En las rutas donde los <script src> relativos fallan a propósito, el navegador anota esos 404 en la consola.
  const tolerate = [
    ...(o.tolerate ?? []),
    ...(o.mount.expected404?.length ? [/Failed to load resource.*404/] : []),
  ];
  // Red hacia internet bloqueada: cualquier cosa que no sea el alojamiento de prueba (o data:/blob:) se corta y se anota.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(host.origin) || url.startsWith('data:') || url.startsWith('blob:')) {
      if (o.abort && o.abort.test(url)) return route.abort('failed');
      return route.continue();
    }
    s.external.push(url);
    return route.abort('internetdisconnected');
  });
  ctx.on('page', (p) => {
    if (p !== s.page) s.popups.push(p.url());
  });
  await ctx.addInitScript({ content: CSP_RECORDER });
  if (o.initScript) await ctx.addInitScript({ content: o.initScript });
  const page = s.page;
  page.on('pageerror', (e) => s.consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource/.test(text) && o.abort) return; // lo cortamos nosotros
    if (tolerate.some((re) => re.test(text))) return;
    s.consoleErrors.push(text);
  });
  page.on('request', (r) => {
    const u = r.url();
    if (/^https?:/.test(u) && !u.startsWith(host.origin)) s.external.push(u);
  });
  page.on('response', (r) => {
    if (r.url().startsWith(host.origin) && r.status() >= 400) {
      const path = new URL(r.url()).pathname;
      if (!(o.mount.expected404 ?? []).some((p) => path.startsWith(p)))
        s.badResponses.push(`${r.status()} ${path}`);
    }
  });
  page.on('dialog', (d) => {
    s.dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  if (o.safeArea) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send(
      'Emulation.setSafeAreaInsetsOverride' as never,
      {
        insets: { top: o.safeArea.top, bottom: o.safeArea.bottom, left: 0, right: 0 },
      } as never,
    );
  }
  currentLabel = s.tag;
  return s;
}

async function closeSession(s: Session) {
  await s.ctx.close();
  await s.host.close();
}

/** Lo que TODO recorrido afirma al terminar. */
async function finish(s: Session, extra: { allowCspViolations?: boolean } = {}) {
  const csp = (await s.page.evaluate('window.__cspViolations || []').catch(() => [])) as string[];
  check(
    s.consoleErrors.length === 0,
    `0 errores de consola${s.consoleErrors.length ? `: ${s.consoleErrors.slice(0, 3).join(' | ')}` : ''}`,
  );
  check(
    s.external.length === 0,
    `0 peticiones a otros orígenes${s.external.length ? `: ${s.external.slice(0, 3).join(' | ')}` : ''}`,
  );
  check(
    s.badResponses.length === 0,
    `ningún archivo local falló (404/500)${s.badResponses.length ? `: ${s.badResponses.slice(0, 3).join(' | ')}` : ''}`,
  );
  check(
    s.dialogs.length === 0,
    `la app no usó alert/confirm/prompt${s.dialogs.length ? `: ${s.dialogs.join(' | ')}` : ''}`,
  );
  check(s.popups.length === 0, 'no se abrió ninguna pestaña nueva');
  if (!extra.allowCspViolations)
    check(
      csp.length === 0,
      `0 violaciones de la política de seguridad${csp.length ? `: ${csp.slice(0, 3).join(' | ')}` : ''}`,
    );
}

// ───────────────────────── utilidades de la app ─────────────────────────

const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });

const STATUS_LABELS = {
  confirmed: 'Pedido confirmado',
  picking: 'Preparando tu pedido',
  packed: 'Empacado en frío',
  out_for_delivery: 'En camino',
  delivered: 'Entregado',
  pending_payment: 'Esperando pago',
} as const;

async function orderStatusText(page: Page): Promise<string> {
  return (
    await page
      .getByTestId('order-status')
      .filter({ visible: true })
      .first()
      .innerText()
      .catch(() => '')
  ).trim();
}

/** Espera (la pantalla del pedido se actualiza sola cada 8 s) hasta ver `label`. */
async function waitForStatus(page: Page, label: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const text = await orderStatusText(page);
    if (text.includes(label)) return;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`✖ El pedido nunca llegó a "${label}" (último estado: "${text}")`);
    await sleep(700);
  }
}

/**
 * Espera a que una expresión sea verdadera en la página. Se consulta desde Node (no con `waitForFunction`):
 * esa llamada evalúa texto dentro de la página y la política de seguridad estricta (sin 'unsafe-eval') la rechaza.
 */
async function waitUntil(page: Page, expression: string, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if ((await page.evaluate(expression)) === true) return;
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`✖ No se cumplió a tiempo: ${expression.slice(0, 120)}`);
    await sleep(150);
  }
}

/** ¿Algún ícono se ve como un cuadro vacío? (la fuente recortada no tiene ese glifo) */
async function missingGlyphs(page: Page): Promise<string[]> {
  return page.evaluate(`(async function () {
    await document.fonts.ready;
    var seen = {}; var missing = [];
    var canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
    var ctx = canvas.getContext('2d');
    function draw(font, ch) {
      ctx.clearRect(0, 0, 48, 48); ctx.font = '32px ' + font; ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.fillText(ch, 4, 4);
      return Array.prototype.join.call(ctx.getImageData(0, 0, 48, 48).data, ',');
    }
    var nodes = document.querySelectorAll('div, span');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var txt = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.firstChild.nodeValue : '';
      if (!txt || txt.length > 2) continue;
      var cp = txt.codePointAt(0);
      if (!(cp >= 0xE000 && cp <= 0xF8FF) && !(cp >= 0xF0000 && cp <= 0xFFFFD)) continue;
      var family = getComputedStyle(el).fontFamily;
      var key = family + '|' + cp;
      if (seen[key]) continue; seen[key] = true;
      var unmapped = String.fromCodePoint(0x10FFFD);
      if (draw(family, txt) === draw(family, unmapped)) missing.push(family + ' U+' + cp.toString(16).toUpperCase());
    }
    return missing;
  })()`) as Promise<string[]>;
}

async function demoApi<T>(page: Page, path: string, token?: string | null): Promise<T> {
  return page.evaluate(
    `fetch("https://demo.jellyfish.local${path}", { headers: ${token ? `{ Authorization: "Bearer ${token}" }` : '{}'} }).then(function (r) { return r.json(); })`,
  ) as Promise<T>;
}

/** Fotos de producto que hay en el documento: cargada, rota o pendiente (las de más abajo se piden al llegar). */
async function photosOnScreen(
  page: Page,
): Promise<{ src: string; state: 'ok' | 'broken' | 'pending' }[]> {
  return page.evaluate(
    `Array.from(document.querySelectorAll('img')).filter(function (i) { return /\\/photos\\//.test(i.src); }).map(function (i) { return { src: i.src, state: i.complete ? (i.naturalWidth > 0 ? 'ok' : 'broken') : 'pending' }; })`,
  ) as Promise<{ src: string; state: 'ok' | 'broken' | 'pending' }[]>;
}

interface PageEnvInfo {
  assets: string | null;
  router: string | null;
  noslash: boolean | null;
  pathname: string;
  title: string;
}

/** Lo que el arranque dedujo de la ruta en que se publicó la página. */
function expectedEnv(m: Mount): { assets: string; router: string; noslash: boolean } {
  // El navegador entrega la ruta codificada ("/mi vista/" → "/mi%20vista/").
  const assets = encodeURI(m.filesDir).replace(/\/+$/, '');
  const endsWithSlash = m.page.endsWith('/');
  return {
    assets,
    router: endsWithSlash ? encodeURI(m.page).replace(/\/+$/, '') : encodeURI(m.page),
    noslash: !endsWithSlash,
  };
}

/** La ruta de la página como la ve el navegador (codificada). */
const pagePath = (m: Mount) => encodeURI(m.page);

// ───────────────────────── 1. inicio y recorrido corto ─────────────────────────

interface Home {
  categories: { slug: string; name: string }[];
}

/**
 * Inicio → fotos propias → categorías (incluida "Otros") → búsqueda → detalle → carrito → de vuelta al
 * inicio → recarga. Es lo que corre cada ruta; el recorrido largo (más abajo) lo usa como primer tramo.
 */
async function shortJourney(
  s: Session,
  url: string,
  opts: { reset?: boolean } = {},
): Promise<Home> {
  const { page, mount } = s;
  await page.goto(`${s.host.origin}${url}`);
  await page.locator('#jf-ribbon').waitFor();
  await tab(page, /Buscar/).waitFor({ timeout: 45_000 });
  await shot(page, '01-inicio');

  // ── La página y su ruta ──
  check((await page.title()) === 'JELLYFISH', 'el título de la página es JELLYFISH');
  const env = (await page.evaluate(
    '({ assets: window.__JF_ASSETS__ ?? null, router: window.__JF_BASE__ ?? null, noslash: window.__JF_NOSLASH__ ?? null, pathname: location.pathname, title: document.title })',
  )) as PageEnvInfo;
  const want = expectedEnv(mount);
  check(
    env.assets === want.assets && env.router === want.router && env.noslash === want.noslash,
    `el arranque calculó la ruta de la página (archivos "${env.assets}", router "${env.router}", sin barra: ${String(env.noslash)})`,
  );
  check(
    (await page.evaluate('document.querySelectorAll("base").length')) === 0,
    'no usa <base> (no depende de que el alojamiento lo permita)',
  );
  check(
    (await page.evaluate(
      'navigator.serviceWorker ? navigator.serviceWorker.controller === null : true',
    )) &&
      (await page.evaluate(
        'navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function (r) { return r.length; }) : 0',
      )) === 0,
    'ningún service worker registrado',
  );
  check(
    (await page.locator('#jf-ribbon').innerText()).includes('123456'),
    'la cinta dice VISTA PREVIA y el código de prueba 123456',
  );
  check(
    !/Unmatched|No encontramos esta página/i.test(await page.locator('body').innerText()),
    'el router reconoce la pantalla de inicio en esta ruta',
  );
  check(
    (await page.evaluate('typeof window.JellyfishDemo === "object"')) === true,
    'el servidor de demostración está instalado antes de que arranque la app',
  );

  // ── El reset de la plataforma no rompe la app ──
  const layout = (await page.evaluate(`(function () {
    var root = document.getElementById('root').getBoundingClientRect();
    var ribbon = document.getElementById('jf-ribbon').getBoundingClientRect();
    return {
      rootLeft: root.left, rootRight: root.right, rootBottom: root.bottom, rootTop: root.top,
      vw: window.innerWidth, vh: window.innerHeight, ribbonBottom: ribbon.bottom,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyMargin: getComputedStyle(document.body).margin,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  })()`)) as Record<string, number | string>;
  check(
    layout.rootLeft === 0 &&
      Math.abs((layout.rootRight as number) - (layout.vw as number)) <= 1 &&
      Math.abs((layout.rootBottom as number) - (layout.vh as number)) <= 1 &&
      Math.abs((layout.rootTop as number) - (layout.ribbonBottom as number)) <= 1,
    `la app ocupa la pantalla completa bajo la cinta (el relleno de :root no la mueve): ${JSON.stringify({ top: layout.rootTop, bottom: layout.rootBottom, vh: layout.vh })}`,
  );
  check(layout.overflowX <= 0, 'sin desplazamiento horizontal');
  check(
    layout.bodyBg === 'rgb(5, 11, 31)' && layout.bodyMargin === '0px',
    `el fondo del body es el de la marca, opaco (${String(layout.bodyBg)}), sin margen`,
  );
  const fontOk = await page.evaluate(
    `(function () { var el = Array.from(document.querySelectorAll('div,span')).find(function (e) { return e.childNodes.length === 1 && e.firstChild.nodeType === 3 && e.firstChild.nodeValue === 'JELLYFISH' && e.closest('#root'); }); return el ? getComputedStyle(el).fontFamily : ''; })()`,
  );
  check(
    /Sora|Jakarta/i.test(String(fontOk)),
    `el texto de la app usa sus propias fuentes, no la base de 14 px del visor (${String(fontOk)})`,
  );

  // ── Fotos propias ──
  await waitUntil(
    page,
    `Array.from(document.querySelectorAll('img')).filter(function (i) { return /\\/photos\\//.test(i.src) && i.complete && i.naturalWidth > 0; }).length >= 2`,
    20_000,
  );
  const photos = await photosOnScreen(page);
  const loaded = photos.filter((p) => p.state === 'ok').length;
  check(
    loaded >= 2 && photos.every((p) => p.state !== 'broken'),
    `el inicio muestra fotos reales locales: ${loaded} cargadas de ${photos.length}, ninguna rota`,
  );
  check(
    photos.every(
      (p) =>
        new URL(p.src).origin === s.host.origin &&
        /\/photos\/JF-[A-Z]{3}-\d{3}\.thumb\.webp$/.test(p.src),
    ),
    'las fotos son archivos propios photos/<sku>.thumb.webp resueltos contra la carpeta de la página',
  );
  check(
    photos.every((p) => new URL(p.src).pathname.startsWith(`${want.assets}/photos/`)),
    `…y salen de la carpeta de la página (${want.assets}/photos/)`,
  );
  const missing0 = await missingGlyphs(page);
  check(
    missing0.length === 0,
    `todos los íconos del inicio tienen su glifo${missing0.length ? `: ${missing0.join(', ')}` : ''}`,
  );

  // ── Categorías (incluida "Otros") ──
  const categories = await demoApi<{ slug: string; name: string }[]>(page, '/v1/categories');
  check(
    categories.some((c) => c.name === 'Otros'),
    `hay ${categories.length} categorías, incluida "Otros"`,
  );
  for (const c of categories) {
    await tab(page, /Inicio/).click();
    await page
      .getByRole('button', { name: `Categoría ${c.name}` })
      .first()
      .click();
    await page.getByTestId('search-results').waitFor({ timeout: 20_000 });
    await page
      .getByText(/\d+ productos?/)
      .first()
      .waitFor({ timeout: 20_000 });
    const total = Number(
      ((
        await page
          .getByText(/\d+ productos?/)
          .first()
          .innerText()
      ).match(/\d+/) ?? ['0'])[0],
    );
    check(total > 0, `la categoría ${c.name} muestra ${total} producto(s)`);
    if (c.name === 'Otros') await shot(page, '02-categoria-otros');
  }

  // ── Búsqueda sin acento y por sinónimo ──
  await tab(page, /Buscar/).click();
  await page.getByText('Todo', { exact: true }).first().click(); // quita el filtro de la última categoría
  await page.getByTestId('search-input').fill('');
  await page.getByTestId('search-input').fill('camaron');
  await page
    .getByTestId('search-results')
    .getByText('Camarón')
    .first()
    .waitFor({ timeout: 20_000 });
  check(true, 'buscar "camaron" (sin tilde) encuentra Camarón');
  await page.getByTestId('search-input').fill('gambas');
  await page
    .getByTestId('search-results')
    .getByText('Camarón')
    .first()
    .waitFor({ timeout: 20_000 });
  await shot(page, '03-busqueda-sinonimo');
  check(true, 'buscar "gambas" (sinónimo) encuentra Camarón');

  // ── Detalle: foto por variante e "Imagen ilustrativa" ──
  await page.getByTestId('search-results').getByText('Camarón').first().click();
  await page.getByTestId('add-to-cart').waitFor({ timeout: 20_000 });
  const product = await demoApi<{ product: { variants: { sku: string; variant: string }[] } }>(
    page,
    '/v1/products/camaron',
  );
  const seenHero = new Map<string, string>();
  const withPhoto = product.product.variants.filter((v) => HAS_PHOTO.has(v.sku));
  const withoutPhoto = product.product.variants.filter((v) => !HAS_PHOTO.has(v.sku));
  for (const v of withPhoto.slice(0, 3)) {
    await page.getByRole('button', { name: v.variant }).first().click();
    await waitUntil(
      page,
      `Array.from(document.querySelectorAll('img')).some(function (i) { return i.src.indexOf(${JSON.stringify(`/photos/${v.sku}.thumb.webp`)}) !== -1 && i.complete && i.naturalWidth > 0; })`,
    );
    seenHero.set(v.variant, v.sku);
  }
  check(
    seenHero.size >= Math.min(2, withPhoto.length) && withPhoto.length > 0,
    `cada variante del Camarón con foto muestra SU foto (${[...seenHero].map(([a, b]) => `${a}→${b}`).join(', ')})`,
  );
  if (withoutPhoto.length > 0) {
    // Variante sin miniatura en este build: cae al degradado de la categoría, sin imagen rota.
    await page.getByRole('button', { name: withoutPhoto[0]!.variant }).first().click();
    await page.waitForTimeout(500);
    check(
      (await photosOnScreen(page)).every((p) => p.state !== 'broken') &&
        !(await page.evaluate(
          `Array.from(document.querySelectorAll('img')).some(function (i) { return i.src.indexOf(${JSON.stringify(`/photos/${withoutPhoto[0]!.sku}.thumb.webp`)}) !== -1; })`,
        )),
      `la variante ${withoutPhoto[0]!.variant} (sin foto en este build) no pide ninguna imagen y no se ve rota`,
    );
    await page.getByRole('button', { name: withPhoto[0]!.variant }).first().click();
  }
  await page.getByTestId('photo-illustrative').first().waitFor({ timeout: 10_000 });
  check(
    /Imagen ilustrativa/.test(await page.getByTestId('photo-illustrative').first().innerText()),
    'el detalle rotula la foto con "Imagen ilustrativa"',
  );
  await shot(page, '04-producto');
  await page.getByRole('button', { name: '16/20' }).first().click();
  await page.getByTestId('add-to-cart').click();
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Agregar' }).click();
  await shot(page, '05-producto-agregado');
  void opts;
  return { categories };
}

/** Vuelve a Inicio, comprueba que la URL es la de la página y recarga: el carrito (y la sesión) sobreviven. */
async function reloadAtHome(s: Session): Promise<void> {
  const { page, mount } = s;
  if (/\/product\//.test(page.url())) {
    await page.getByRole('button', { name: 'Volver' }).first().click(); // del detalle de producto a la lista
  }
  await tab(page, /Inicio/).click();
  await page.waitForTimeout(400);
  const here = new URL(page.url());
  check(
    here.pathname === pagePath(mount),
    `de vuelta en Inicio la dirección es la de la página (${here.pathname})`,
  );
  await page.reload();
  await tab(page, /Buscar/).waitFor({ timeout: 45_000 });
  check(
    !/Unmatched|No encontramos esta página/i.test(await page.locator('body').innerText()),
    'recargar la página la abre en el inicio, sin pantalla de error',
  );
  await tab(page, /Carrito/).click();
  await page.getByTestId('go-checkout').waitFor({ timeout: 20_000 });
  check(true, 'tras recargar, el carrito sigue ahí (localStorage)');
  await tab(page, /Inicio/).click();
}

// ───────────────────────── 2. recorrido largo ─────────────────────────

interface LongOptions {
  /** `?speed=3` en la dirección, o `#rapido` (la forma que sí viaja en el enlace del visor). */
  speedVia: 'query' | 'hash';
}

async function longJourney(s: Session, o: LongOptions) {
  const { page, mount } = s;
  const url = o.speedVia === 'query' ? `${mount.page}?speed=3&reset=1` : `${mount.page}#rapido`;
  await shortJourney(s, url);

  // Los tiempos: con #rapido la velocidad es 3; con ?speed=3 también.
  const stages = (await page.evaluate(
    'window.JellyfishDemo.handle.server.ctx.cfg.stageMs',
  )) as Record<string, number>;
  check(
    Math.abs(stages.confirmed! - 25_000 / 3) < 1 && Math.abs(stages.out_for_delivery! - 10_000) < 1,
    `la velocidad ${o.speedVia === 'hash' ? '#rapido' : '?speed=3'} acelera las etapas (${JSON.stringify(stages)})`,
  );

  // ── Favoritos ──
  // El detalle del producto está encima de la lista (que sigue montada): se toca el corazón que se ve.
  await page.getByTestId('fav-camaron').filter({ visible: true }).first().click();
  check(true, 'se marca Camarón como favorito (corazón)');

  // ── Carrito ──
  await page.getByRole('button', { name: 'Ver carrito' }).click();
  await page.getByTestId('go-checkout').waitFor({ timeout: 20_000 });
  await shot(page, '06-carrito');
  const goText = await page.getByTestId('go-checkout').innerText();
  check(
    /RD\$/.test(goText),
    `el carrito calcula el total en pesos (${goText.replace(/\s+/g, ' ')})`,
  );

  // ── Login por OTP (123456) ──
  await page.getByTestId('go-checkout').click();
  const phone = `809555${String(Math.floor(1000 + Math.random() * 8999))}`;
  await page.getByTestId('phone-input').fill(phone);
  await shot(page, '07-login');
  await page.getByTestId('send-code').click();
  await page.getByTestId('otp-input').waitFor();
  await page.getByTestId('otp-input').fill('123456');
  await page.getByText('Confirmar pedido').first().waitFor({ timeout: 20_000 });
  check(true, 'entró con el código de prueba 123456');
  await shot(page, '08-checkout');

  // ── Dirección con "Usar mi ubicación actual" (el doble de geolocalización) ──
  await page.getByTestId('add-address').click();
  const doubles = (await page.evaluate('window.JellyfishDemo.doubles')) as {
    geolocation: boolean;
    permissions: boolean;
  };
  check(
    doubles.geolocation && doubles.permissions,
    'la vista previa instaló el doble de navigator.geolocation y de permissions.query',
  );
  const permission = await page.evaluate(
    `navigator.permissions.query({ name: 'geolocation' }).then(function (p) { return p.state; })`,
  );
  check(
    permission === 'prompt',
    'navigator.permissions.query("geolocation") responde "prompt" al principio (como un navegador nuevo: la app explica antes de pedir)',
  );
  await page.getByTestId('use-location').click();
  await page.getByTestId('location-explain').waitFor({ timeout: 10_000 });
  await shot(page, '09-ubicacion-permiso');
  await page.getByTestId('location-allow').click();
  await page.getByTestId('location-saved').waitFor({ timeout: 15_000 });
  check(
    (await page.evaluate(
      `navigator.permissions.query({ name: 'geolocation' }).then(function (p) { return p.state; })`,
    )) === 'granted',
    'tras dar la posición, el permiso pasa a "granted"',
  );
  const savedText = await page.getByTestId('location-saved').innerText();
  check(
    /18\.4861/.test(savedText) && /-69\.9312/.test(savedText),
    `"Usar mi ubicación actual" guardó el punto de Santo Domingo (${savedText.replace(/\s+/g, ' ').slice(0, 60)})`,
  );
  await page.getByTestId('addr-line1').fill('Calle Max Henríquez Ureña #10');
  await page.getByTestId('addr-sector').fill('Piantini');
  await page.getByTestId('addr-reference').fill('Al lado del colmado Don Pepe, portón negro');
  await page.getByText('¡Llegamos a tu sector!').waitFor();
  await shot(page, '10-direccion');
  await page.getByTestId('save-address').click();
  await page.getByText('Piantini').first().waitFor();
  const addresses = await demoApi<{ latitude: number | null; longitude: number | null }[]>(
    page,
    '/v1/me/addresses',
    (await page.evaluate('localStorage.getItem("jellyfish.token")')) as string,
  );
  check(
    addresses[0]?.latitude === 18.4861 && addresses[0]?.longitude === -69.9312,
    'la dirección guardada lleva las coordenadas del punto de ejemplo',
  );

  // ── Checkout en efectivo ──
  await page
    .getByRole('button')
    .filter({ hasText: /\d:\d\d [ap]\. m\. – / })
    .first()
    .click();
  await page.getByTestId('checkout-name').fill('Andrés Prueba');
  await shot(page, '11-checkout-listo');
  const missing1 = await missingGlyphs(page);
  check(
    missing1.length === 0,
    `todos los íconos del checkout tienen glifo${missing1.length ? `: ${missing1.join(', ')}` : ''}`,
  );
  check(
    await page.getByTestId('place-order').isEnabled(),
    'con dirección, horario y pago el botón de confirmar se habilita',
  );
  await page.getByTestId('place-order').click();
  await page
    .getByTestId('order-status')
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 20_000 });
  await shot(page, '12-pedido-efectivo');
  check(
    (await orderStatusText(page)).includes(STATUS_LABELS.confirmed),
    'el pedido en efectivo queda confirmado',
  );

  // ── PIN de entrega visible ──
  const orderState = await page.evaluate<{ id: string; pin: string; code: string }>(
    '(function(){var o=window.JellyfishDemo.handle.server.ctx.state.orders[0];return {id:o.id,pin:o.deliveryPin,code:"JF-"+String(o.number).padStart(6,"0")}})()',
  );
  check(
    /^\d{4}$/.test(orderState.pin),
    `el pedido trae un PIN de entrega de 4 dígitos (${orderState.pin})`,
  );
  const pinLabel = await page
    .getByLabel(/Tu PIN de entrega/)
    .first()
    .getAttribute('aria-label');
  check(
    pinLabel === `Tu PIN de entrega: ${orderState.pin.split('').join(' ')}`,
    `la pantalla del pedido muestra el PIN al cliente (${String(pinLabel)})`,
  );

  // ── Etapas del pedido ──
  await waitForStatus(page, STATUS_LABELS.picking);
  await shot(page, '13-preparando');
  await waitForStatus(page, STATUS_LABELS.packed);
  await waitForStatus(page, STATUS_LABELS.out_for_delivery);
  await page.getByTestId('tracking-card').waitFor({ timeout: 20_000 });
  await shot(page, '14-en-camino');
  const missing2 = await missingGlyphs(page);
  check(
    missing2.length === 0,
    `todos los íconos del pedido en camino tienen glifo${missing2.length ? `: ${missing2.join(', ')}` : ''}`,
  );
  check(true, 'el pedido avanza solo: confirmado → preparando → empacado → en camino');

  // ── Seguimiento y "Ver en el mapa" (window.open no existe: aviso claro) ──
  await page.getByTestId('tracking-headline').waitFor({ timeout: 20_000 });
  check(true, 'el seguimiento muestra la posición del repartidor simulado');
  const pagesBefore = s.ctx.pages().length;
  await page.getByTestId('tracking-map').click();
  await page.locator('#jf-toast').waitFor({ state: 'visible', timeout: 5000 });
  const toastText = await page.locator('#jf-toast').innerText();
  check(
    /Vista previa/.test(toastText) && /mapa/.test(toastText),
    `"Ver en el mapa" muestra un aviso claro en vez de fallar en silencio: "${toastText.replace(/\s+/g, ' ').slice(0, 90)}"`,
  );
  const mapHref = await page.locator('#jf-toast a').first().getAttribute('href');
  check(
    !!mapHref && /^https:\/\//.test(mapHref) && /maps/.test(mapHref),
    `el aviso trae un enlace de verdad al mapa (${String(mapHref).slice(0, 60)})`,
  );
  check(
    s.ctx.pages().length === pagesBefore && s.popups.length === 0,
    'no se abrió ninguna pestaña',
  );
  await shot(page, '15-aviso-mapa');
  await page.locator('#jf-toast button').click();
  check(await page.locator('#jf-toast').isHidden(), 'el aviso se puede cerrar');

  await waitForStatus(page, STATUS_LABELS.delivered);
  await shot(page, '16-entregado');
  check(true, 'el pedido llega a Entregado');
  const delivered = await page.evaluate<{ pinVerifiedAt: string | null; payment: string }>(
    '(function(){var o=window.JellyfishDemo.handle.server.ctx.state.orders[0];return {pinVerifiedAt:o.pinVerifiedAt,payment:o.payments[0].status}})()',
  );
  check(
    delivered.pinVerifiedAt !== null && delivered.payment === 'captured',
    'al entregar, el PIN queda verificado y el efectivo cobrado',
  );

  // ── Pedir de nuevo ──
  await page
    .getByRole('button', { name: /Pedir de nuevo/i })
    .first()
    .click();
  await page.getByTestId('reorder-sheet').waitFor({ timeout: 15_000 });
  await shot(page, '17-pedir-de-nuevo');
  await page.getByTestId('reorder-go-cart').click();
  await page.getByTestId('go-checkout').waitFor({ timeout: 20_000 });
  check(true, '"Pedir de nuevo" vuelve a llenar el carrito con el pedido entregado');

  // ── Cupón y pedido con tarjeta simulada ──
  await page.getByTestId('go-checkout').click();
  await page.getByText('Confirmar pedido').first().waitFor({ timeout: 20_000 });
  await page
    .getByRole('button')
    .filter({ hasText: /\d:\d\d [ap]\. m\. – / })
    .first()
    .click();
  await page.getByTestId('coupon-open').click();
  await page.getByTestId('coupon-input').fill('BIENVENIDO10');
  await page.getByTestId('coupon-apply').click();
  await page.getByTestId('coupon-applied').waitFor({ timeout: 15_000 });
  await page.getByTestId('quote-discount').waitFor({ timeout: 15_000 });
  await shot(page, '18-cupon');
  check(true, 'el cupón BIENVENIDO10 se aplica y aparece el descuento en el total');
  await page.getByTestId('pay-card').click();
  await shot(page, '19-checkout-tarjeta');
  const pagesBeforeCard = s.ctx.pages().length;
  await page.getByTestId('place-order').click();
  await page
    .getByTestId('order-status')
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 20_000 });
  check(
    (await orderStatusText(page)).includes(STATUS_LABELS.pending_payment) ||
      (await orderStatusText(page)).includes(STATUS_LABELS.confirmed),
    'el pedido con tarjeta empieza esperando el pago',
  );
  await page
    .getByText(STATUS_LABELS.confirmed)
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 25_000 });
  await shot(page, '20-tarjeta-aprobada');
  check(
    s.ctx.pages().length === pagesBeforeCard,
    'el pago con tarjeta NO abre ninguna pasarela (ni pestaña nueva)',
  );
  check(
    await page
      .getByText('Pagado')
      .first()
      .isVisible()
      .catch(() => false),
    'el servidor de demostración aprueba el pago y el pedido queda Pagado',
  );

  // ── Pedidos, favoritos y textos legales ──
  await tab(page, /Pedidos/).click();
  await page
    .getByText(/^JF-\d{6}$/)
    .first()
    .waitFor({ timeout: 20_000 });
  await shot(page, '21-pedidos');
  check(
    (await page.getByText(/^JF-\d{6}$/).count()) >= 2,
    'Mis pedidos lista los dos pedidos hechos',
  );
  await tab(page, /Perfil/).click();
  await page.getByText('Mis direcciones').waitFor();
  await shot(page, '22-perfil');
  const missing3 = await missingGlyphs(page);
  check(
    missing3.length === 0,
    `todos los íconos del perfil tienen glifo${missing3.length ? `: ${missing3.join(', ')}` : ''}`,
  );
  await page.getByTestId('profile-favorites').click();
  await page.getByTestId('favorites-list').waitFor({ timeout: 15_000 });
  check(
    (await page.getByTestId('favorites-list').innerText()).includes('Camarón'),
    'Favoritos lista el Camarón marcado',
  );
  await shot(page, '23-favoritos');
  await page.goBack();
  for (const id of ['terminos', 'privacidad', 'devoluciones', 'cadena-de-frio']) {
    await page.getByTestId(`legal-row-${id}`).first().click();
    await page.getByTestId('legal-title').waitFor({ timeout: 15_000 });
    const title = (await page.getByTestId('legal-title').innerText()).trim();
    check(title.length > 3, `el texto legal "${id}" abre (${title})`);
    if (id === 'terminos') await shot(page, '24-legal');
    await page.goBack();
    await page.getByTestId(`legal-row-${id}`).first().waitFor({ timeout: 15_000 });
  }

  // ── Recarga: todo persiste ──
  await tab(page, /Inicio/).click();
  await page.waitForTimeout(300);
  check(
    new URL(page.url()).pathname === pagePath(mount),
    `de vuelta en Inicio la dirección es la de la página (${new URL(page.url()).pathname})`,
  );
  await page.reload();
  await tab(page, /Pedidos/).waitFor({ timeout: 45_000 });
  await tab(page, /Pedidos/).click();
  await page
    .getByText(/^JF-\d{6}$/)
    .first()
    .waitFor({ timeout: 20_000 });
  check(
    (await page.getByText(/^JF-\d{6}$/).count()) >= 2,
    'tras recargar la página, la sesión y los pedidos siguen ahí',
  );
  await shot(page, '25-despues-de-recargar');
  await tab(page, /Perfil/).click();
  await page.getByTestId('profile-favorites').waitFor();
  check(
    /1 guardado/.test(await page.getByTestId('profile-favorites').innerText()),
    'tras recargar, el favorito sigue guardado',
  );

  // ── Reiniciar: confirmación DENTRO de la página (el visor no muestra confirm()) ──
  await page.locator('#jf-restart').click();
  await page.locator('#jf-confirm').waitFor({ state: 'visible', timeout: 5000 });
  await shot(page, '26-confirmar-reinicio');
  check(
    /Reiniciar la demostración/.test(await page.locator('#jf-confirm').innerText()),
    'Reiniciar pide confirmación con un cuadro de la página',
  );
  await page.locator('#jf-cancel').click();
  check(await page.locator('#jf-confirm').isHidden(), 'Cancelar cierra el cuadro y no borra nada');
  check(
    ((await page.evaluate('window.JellyfishDemo.summary().orders')) as number) >= 2,
    'los pedidos siguen ahí tras cancelar',
  );
  await page.locator('#jf-restart').click();
  await page.locator('#jf-accept').click();
  await tab(page, /Buscar/).waitFor({ timeout: 45_000 });
  await page.waitForTimeout(500);
  const afterReset = (await page.evaluate(
    '({token: localStorage.getItem("jellyfish.token"), orders: window.JellyfishDemo.summary().orders, users: window.JellyfishDemo.summary().users})',
  )) as { token: string | null; orders: number; users: number };
  check(
    afterReset.token === null && afterReset.orders === 0 && afterReset.users === 0,
    'confirmar el reinicio borra la sesión, el carrito y los pedidos de ejemplo',
  );
  await shot(page, '27-reiniciado');
  await finish(s);
}

// ───────────────────────── 3. recorrido corto por ruta ─────────────────────────

async function routeJourney(s: Session) {
  await shortJourney(s, `${s.mount.page}?reset=1`);
  await reloadAtHome(s);
  await finish(s);
}

// ───────────────────────── 4. extras ─────────────────────────

/** replaceState/pushState lanzan SecurityError (marco con otro origen): el arranque lo tolera y la app abre. */
async function historyThrows(browser: Browser, device: DeviceCase) {
  const mount = MOUNTS.find((m) => m.name === 'xyz-artifact')!;
  const s = await openSession(browser, {
    device,
    scheme: 'dark',
    mount,
    initScript: `(function () {
      function deny() { throw new DOMException('Bloqueado por el marco', 'SecurityError'); }
      History.prototype.replaceState = deny;
      History.prototype.pushState = deny;
    })();`,
  });
  currentLabel = `${s.tag}-historial-bloqueado`;
  try {
    await s.page.goto(`${s.host.origin}${mount.page}`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await shot(s.page, '01-inicio');
    check(
      !/Unmatched|No encontramos esta página/i.test(await s.page.locator('body').innerText()),
      'con replaceState y pushState que lanzan error, la app abre en el inicio (no queda en blanco)',
    );
    await tab(s.page, /Buscar/).click();
    await s.page.getByTestId('search-input').fill('camaron');
    await s.page.getByTestId('search-results').getByText('Camarón').first().click();
    await s.page.getByTestId('add-to-cart').waitFor({ timeout: 20_000 });
    await shot(s.page, '02-producto');
    check(true, 'y la navegación interna sigue funcionando (buscar → detalle de producto)');
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** localStorage bloqueado (modo privado): la página funciona en memoria. */
async function noStorage(browser: Browser, device: DeviceCase) {
  const mount = MOUNTS.find((m) => m.name === 'xyz')!;
  const s = await openSession(browser, {
    device,
    scheme: 'light',
    mount,
    initScript: `(function () {
      function deny() { throw new DOMException('El almacenamiento está bloqueado', 'SecurityError'); }
      Object.defineProperty(window, 'localStorage', { get: deny, configurable: true });
      Object.defineProperty(window, 'sessionStorage', { get: deny, configurable: true });
    })();`,
  });
  currentLabel = `${s.tag}-sin-almacenamiento`;
  try {
    await s.page.goto(`${s.host.origin}${mount.page}?reset=1`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await shot(s.page, '01-inicio');
    check(true, 'sin localStorage la página abre igual (todo en memoria)');
    await tab(s.page, /Buscar/).click();
    await s.page.getByTestId('search-input').fill('camaron');
    await s.page
      .getByTestId('search-results')
      .getByText('Camarón')
      .first()
      .waitFor({ timeout: 20_000 });
    check(true, 'y la búsqueda funciona');
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** La página dentro de un marco aislado (sandbox sin same-origin): sin localStorage y con origen "null". */
async function sandboxFrame(browser: Browser, device: DeviceCase) {
  const mount = MOUNTS.find((m) => m.name === 'xyz')!;
  const s = await openSession(browser, { device, scheme: 'dark', mount });
  currentLabel = `${s.tag}-marco-aislado`;
  try {
    await s.page.goto(`${s.host.origin}/host.html`);
    const frame = s.page.frameLocator('#f');
    await frame.getByRole('tab', { name: /Buscar/ }).waitFor({ timeout: 60_000 });
    await shot(s.page, '01-inicio');
    check(true, 'dentro de un marco aislado (sin localStorage) la app abre');
    await frame.getByRole('tab', { name: /Buscar/ }).click();
    await frame.getByTestId('search-input').fill('camaron');
    await frame
      .getByTestId('search-results')
      .getByText('Camarón')
      .first()
      .waitFor({ timeout: 20_000 });
    check(true, 'la búsqueda funciona dentro del marco aislado');
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** Las fotos no llegan (archivo faltante): cada foto cae al degradado de su categoría, sin romper nada. */
async function photosMissing(browser: Browser, device: DeviceCase) {
  const mount = MOUNTS.find((m) => m.name === 'x')!;
  const s = await openSession(browser, { device, scheme: 'dark', mount, abort: /\/photos\// });
  currentLabel = `${s.tag}-sin-fotos`;
  try {
    await s.page.goto(`${s.host.origin}${mount.page}?reset=1`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await s.page
      .getByRole('button', { name: /Categoría Mariscos/ })
      .first()
      .click();
    await s.page
      .getByTestId('search-results')
      .getByText('Camarón')
      .first()
      .waitFor({ timeout: 20_000 });
    await s.page.waitForTimeout(800);
    await shot(s.page, '01-categoria-sin-fotos');
    check(
      true,
      'sin las fotos la app sigue mostrando los productos (degradado con el ícono de la categoría)',
    );
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** Alojamiento con "SPA fallback": recargar en una pantalla interna abre esa misma pantalla. */
async function innerReload(browser: Browser, device: DeviceCase, mountName: string) {
  const mount = MOUNTS.find((m) => m.name === mountName)!;
  const s = await openSession(browser, {
    device,
    scheme: 'light',
    mount,
    fallback: true,
    // Al recargar en /…/product/camaron los <script src> relativos no aciertan: el plan B busca la carpeta.
    tolerate: [/Failed to load resource.*404/],
  });
  currentLabel = `${s.tag}-recarga-interna`;
  try {
    await s.page.goto(`${s.host.origin}${mount.page}?reset=1`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await tab(s.page, /Buscar/).click();
    await s.page.getByTestId('search-input').fill('camaron');
    await s.page.getByTestId('search-results').getByText('Camarón').first().click();
    await s.page.getByTestId('add-to-cart').waitFor({ timeout: 20_000 });
    const innerPath = new URL(s.page.url()).pathname;
    check(
      /\/product\/camaron/.test(innerPath),
      `el detalle del producto tiene su propia dirección (${innerPath})`,
    );
    s.badResponses.length = 0;
    await s.page.reload();
    await s.page.getByTestId('add-to-cart').waitFor({ timeout: 45_000 });
    await shot(s.page, '01-recargado-en-producto');
    check(
      new URL(s.page.url()).pathname === innerPath,
      'recargar en el detalle del producto (en un alojamiento que devuelve la página) lo vuelve a abrir',
    );
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** iPhone con muesca: zonas seguras de 47 px arriba y 34 abajo; la cinta las absorbe y la app no las suma dos veces. */
async function safeAreas(browser: Browser) {
  const mount = MOUNTS.find((m) => m.name === 'x-index')!;
  const s = await openSession(browser, {
    device: DEVICES.iphone,
    scheme: 'dark',
    mount,
    safeArea: { top: 47, bottom: 34 },
  });
  currentLabel = `${s.tag}-zonas-seguras`;
  try {
    await s.page.goto(`${s.host.origin}${mount.page}?reset=1`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await shot(s.page, '01-inicio');
    const m = (await s.page.evaluate(`(function () {
      var cs = getComputedStyle(document.documentElement);
      var ribbon = document.getElementById('jf-ribbon').getBoundingClientRect();
      var root = document.getElementById('root').getBoundingClientRect();
      var hello = Array.from(document.querySelectorAll('div,span')).find(function (e) { return e.childNodes.length === 1 && e.firstChild.nodeType === 3 && /^Hola/.test(e.firstChild.nodeValue || ''); });
      var tabbar = document.querySelector('[role="tablist"]');
      return {
        padTop: cs.paddingTop, padBottom: cs.paddingBottom,
        ribbonH: ribbon.height, rootTop: root.top, vh: window.innerHeight, rootBottom: root.bottom,
        helloTop: hello ? hello.getBoundingClientRect().top : -1,
        tabBottom: tabbar ? tabbar.getBoundingClientRect().bottom : -1,
        overflowY: document.documentElement.scrollHeight - window.innerHeight,
      };
    })()`)) as Record<string, number | string>;
    check(
      m.padTop === '47px' && m.padBottom === '34px',
      `el visor padea :root con las zonas seguras (${String(m.padTop)} / ${String(m.padBottom)})`,
    );
    check(
      (m.ribbonH as number) >= 47 + 20,
      `la cinta absorbe la zona segura de arriba (alto ${String(m.ribbonH)} px)`,
    );
    check(
      Math.abs((m.rootTop as number) - (m.ribbonH as number)) <= 1,
      'la app empieza justo bajo la cinta',
    );
    check(
      (m.helloTop as number) - (m.rootTop as number) < 70,
      `la app no suma la zona segura de arriba otra vez (el saludo queda ${Math.round((m.helloTop as number) - (m.rootTop as number))} px bajo la cinta)`,
    );
    check(
      Math.abs((m.rootBottom as number) - (m.vh as number)) <= 1,
      'la app llega hasta abajo (la barra de pestañas respeta su propia zona segura)',
    );
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

/** Atajos que SÍ viajan en un enlace del visor: `#reiniciar` y `#rapido`. */
async function anchorShortcuts(browser: Browser, device: DeviceCase) {
  const mount = MOUNTS.find((m) => m.name === 'raiz')!;
  const s = await openSession(browser, { device, scheme: 'dark', mount });
  currentLabel = `${s.tag}-atajos`;
  try {
    // Primera visita: se crea una cuenta de ejemplo.
    await s.page.goto(`${s.host.origin}${mount.page}`);
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    await s.page.evaluate(
      `fetch("https://demo.jellyfish.local/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+18095550101", code: "123456" }) }).then(function (r) { return r.json(); })`,
    );
    check(
      ((await s.page.evaluate('window.JellyfishDemo.summary().users')) as number) === 1,
      'hay una cuenta de ejemplo creada',
    );
    // Con #reiniciar se borra todo, una sola vez por sesión del navegador.
    await s.page.goto(`${s.host.origin}${mount.page}#reiniciar`);
    await s.page.reload();
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    check(
      ((await s.page.evaluate('window.JellyfishDemo.summary().users')) as number) === 0,
      '#reiniciar borra la demostración al abrir el enlace',
    );
    await s.page.evaluate(
      `fetch("https://demo.jellyfish.local/v1/auth/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+18095550102", code: "123456" }) }).then(function (r) { return r.json(); })`,
    );
    await s.page.reload();
    await tab(s.page, /Buscar/).waitFor({ timeout: 45_000 });
    check(
      ((await s.page.evaluate('window.JellyfishDemo.summary().users')) as number) === 1,
      'y NO vuelve a borrar en cada recarga (solo la primera vez de la sesión)',
    );
    await finish(s);
  } finally {
    await closeSession(s);
  }
}

// ───────────────────────── principal ─────────────────────────

const LONG_RUNS: {
  device: DeviceCase['name'];
  scheme: Scheme;
  mount: string;
  speedVia: 'query' | 'hash';
  safeArea?: boolean;
}[] = [
  { device: 'iphone', scheme: 'dark', mount: 'xyz', speedVia: 'query' },
  { device: 'pixel', scheme: 'light', mount: 'raiz', speedVia: 'hash' },
  { device: 'iphone', scheme: 'light', mount: 'xyz-artifact', speedVia: 'query' },
  { device: 'pixel', scheme: 'dark', mount: 'x-index', speedVia: 'query' },
];

async function main() {
  if (!existsSync(`${DIST}/artifact.html`) || !existsSync(`${DIST}/publish-files.json`)) {
    throw new Error(`No existe ${DIST}/artifact.html: corre primero  npm run preview:build`);
  }
  if (args.serve) {
    const wanted = args.mount ? MOUNTS.filter((m) => m.name === args.mount) : MOUNTS;
    if (wanted.length === 0)
      throw new Error(
        `No hay una ruta "${args.mount}". Opciones: ${MOUNTS.map((m) => m.name).join(', ')}`,
      );
    console.log('\nVista previa servida (Ctrl+C para salir):');
    let port = Number(args.port);
    for (const m of wanted) {
      const host = await startHost({ dist: DIST, port, mounts: [m], fallback: [m.name] });
      port = host.port + 1;
      console.log(
        `  ${host.origin}${m.page}   (${m.name}${m.mode === 'index' ? ', index.html completo' : ', fragmento envuelto como el visor'})`,
      );
    }
    await new Promise(() => {});
  }

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  let failed = 0;
  const run = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      failed++;
      console.error(`\n✖ ${name}: ${e instanceof Error ? e.message : e}\n`);
    }
  };
  const failureShot = async (s: Session | null, err: unknown) => {
    if (!s) return;
    await s.page.screenshot({ path: `${OUT}/${s.tag}-FALLO.png` }).catch(() => {});
    console.error(
      `Texto visible al fallar:\n${(
        await s.page
          .locator('body')
          .innerText()
          .catch(() => '')
      ).slice(0, 600)}`,
    );
    console.error(`URL: ${s.page.url()}`);
    if (s.consoleErrors.length)
      console.error(`Errores del navegador:\n- ${s.consoleErrors.slice(0, 6).join('\n- ')}`);
    void err;
  };

  try {
    if (!args.only) {
      // Recorridos largos: las cuatro combinaciones de teléfono y tema, en cuatro rutas distintas.
      if (!args.quick) {
        for (const r of LONG_RUNS) {
          if (args.mount && args.mount !== r.mount) continue;
          const mount = MOUNTS.find((m) => m.name === r.mount)!;
          let s: Session | null = null;
          await run(`recorrido largo ${r.device}-${r.scheme}-${r.mount}`, async () => {
            s = await openSession(browser, { device: DEVICES[r.device], scheme: r.scheme, mount });
            try {
              await longJourney(s, { speedVia: r.speedVia });
            } catch (e) {
              await failureShot(s, e);
              throw e;
            } finally {
              await closeSession(s);
            }
          });
        }
      }
      // Recorridos cortos: cada ruta, alternando teléfono y tema.
      let i = 0;
      for (const mount of MOUNTS) {
        if (args.mount && args.mount !== mount.name) continue;
        const device = i % 2 === 0 ? DEVICES.iphone : DEVICES.pixel;
        const scheme: Scheme = Math.floor(i / 2) % 2 === 0 ? 'dark' : 'light';
        i++;
        if (!args.quick && LONG_RUNS.some((r) => r.mount === mount.name)) continue; // ya tuvo su recorrido largo
        let s: Session | null = null;
        await run(`ruta ${mount.name}`, async () => {
          s = await openSession(browser, { device, scheme, mount });
          try {
            await routeJourney(s);
          } catch (e) {
            await failureShot(s, e);
            throw e;
          } finally {
            await closeSession(s);
          }
        });
      }
    }
    if ((!args.quick || args.only) && !args.mount) {
      const extras: [string, () => Promise<void>][] = [
        ['historial-bloqueado', () => historyThrows(browser, DEVICES.iphone)],
        ['sin-almacenamiento', () => noStorage(browser, DEVICES.pixel)],
        ['marco-aislado', () => sandboxFrame(browser, DEVICES.iphone)],
        ['sin-fotos', () => photosMissing(browser, DEVICES.pixel)],
        ['recarga-interna', () => innerReload(browser, DEVICES.iphone, 'xyz')],
        ['recarga-interna-archivo', () => innerReload(browser, DEVICES.pixel, 'xyz-artifact')],
        ['zonas-seguras', () => safeAreas(browser)],
        ['atajos', () => anchorShortcuts(browser, DEVICES.pixel)],
      ];
      for (const [name, fn] of extras) {
        if (args.only && args.only !== name) continue;
        await run(`extra ${name}`, fn);
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
  const ok = results.filter((r) => r.ok).length;
  console.log(
    `\n${failed === 0 ? '✔' : '✖'} ${ok}/${results.length} comprobaciones, ${failed} recorridos fallidos. Capturas y report.json en ${OUT}\n`,
  );
  if (failed > 0) process.exitCode = 1;
  void readFileSync;
}

main()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
