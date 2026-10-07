/**
 * Verifica la VISTA PREVIA web (dist-preview/) como la vería el dueño en su teléfono: Chromium con
 * emulación de iPhone 14 y Pixel 7, la página servida bajo una subcarpeta desconocida
 * (/artifact/xyz/) y en la raíz, SIN internet (solo el servidor local; las fotos del CDN se
 * responden con una imagen negra) y con la prueba del respaldo cuando las fotos fallan.
 *
 *   npx tsx scripts/e2e-preview.ts                       (usa dist-preview/, toma capturas en tmp/e2e-preview)
 *   npx tsx scripts/e2e-preview.ts --serve               (solo sirve la carpeta y escribe la dirección)
 *   E2E_OUT=/ruta npx tsx scripts/e2e-preview.ts --dir /ruta/dist-preview
 *   --device iphone|pixel|all   --mount subdir|root|noslash|all   --quick (solo inicio → producto → recargar)
 *
 * El servidor es ESTRICTO a propósito: no devuelve index.html para rutas desconocidas (como muchos
 * alojamientos estáticos), así que recargar solo funciona donde la página realmente existe.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type BrowserContext, type Page, chromium, devices } from 'playwright-core';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..');
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', default: `${root}/dist-preview` },
    out: { type: 'string', default: process.env.E2E_OUT ?? `${root}/tmp/e2e-preview` },
    port: { type: 'string', default: '4311' },
    serve: { type: 'boolean', default: false },
    device: { type: 'string', default: 'all' },
    mount: { type: 'string', default: 'all' },
    quick: { type: 'boolean', default: false },
  },
});
const DIST = resolve(args.dir!);
const OUT = resolve(args.out!);
const PORT = Number(args.port);
const ORIGIN = `http://127.0.0.1:${PORT}`;
mkdirSync(OUT, { recursive: true });

const log = (m: string) => console.log(`• ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── servidor estático estricto ─────────────────────────

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

const MOUNTS = {
  subdir: '/artifact/xyz/',
  root: '/',
  noslash: '/artifact/abc',
} as const;
type MountName = keyof typeof MOUNTS;

interface ServerStats {
  requests: { url: string; status: number }[];
}

function startServer(): { close: () => void; stats: ServerStats } {
  const stats: ServerStats = { requests: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', ORIGIN);
    const path = decodeURIComponent(url.pathname);
    let file: string | null = null;
    for (const mount of Object.values(MOUNTS)) {
      if (mount === '/') {
        if (path === '/') file = join(DIST, 'index.html');
        else if (!path.startsWith('/artifact/')) file = join(DIST, path);
      } else if (mount.endsWith('/')) {
        if (path.startsWith(mount)) file = join(DIST, path.slice(mount.length) || 'index.html');
      } else if (path === mount) {
        file = join(DIST, 'index.html'); // la página vive en /artifact/abc (sin barra)
      } else if (path.startsWith(`${mount}/`)) {
        file = join(DIST, path.slice(mount.length + 1) || 'index.html');
      }
      if (file) break;
    }
    const ok = file && existsSync(file) && statSync(file).isFile() && file.startsWith(DIST);
    const status = ok ? 200 : 404;
    stats.requests.push({ url: `${url.pathname}`, status });
    if (!ok) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('No encontrado');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file!)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(file!));
  });
  server.listen(PORT, '127.0.0.1');
  return { close: () => server.close(), stats };
}

// ───────────────────────── red bloqueada ─────────────────────────

/** PNG negro (la "foto" del CDN en estas pruebas). */
const BLACK_PNG = await sharp({
  create: { width: 64, height: 48, channels: 3, background: '#000000' },
})
  .png()
  .toBuffer();

interface NetLog {
  external: string[];
  cdn: number;
  failed: string[];
}

async function lockNetwork(ctx: BrowserContext, mode: 'black' | 'fail', net: NetLog) {
  await ctx.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    if (new URL(url).hostname === 'd8j0ntlcm91z4.cloudfront.net') {
      net.cdn++;
      if (mode === 'black') {
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: BLACK_PNG,
          headers: { 'access-control-allow-origin': '*' },
        });
      }
      return route.abort('failed');
    }
    net.external.push(url);
    return route.abort('internetdisconnected');
  });
}

// ───────────────────────── utilidades de prueba ─────────────────────────

const results: { name: string; ok: boolean; soft?: boolean; note?: string }[] = [];
let currentLabel = '';

function check(cond: unknown, message: string): asserts cond {
  if (!cond) {
    results.push({ name: `${currentLabel}: ${message}`, ok: false });
    throw new Error(`✖ ${message}`);
  }
  results.push({ name: `${currentLabel}: ${message}`, ok: true });
  log(`✔ ${message}`);
}

/** Comprobación de algo que otro equipo todavía puede estar construyendo: avisa, no rompe. */
function soft(cond: unknown, message: string, note = '') {
  results.push({ name: `${currentLabel}: ${message}`, ok: !!cond, soft: true, note });
  log(`${cond ? '✔' : '⚠'} ${message}${cond ? '' : ` (pendiente: ${note || 'no está en la app todavía'})`}`);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${currentLabel}-${name}.png` });
}

async function demoState<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(function(){ var d = window.JellyfishDemo; return (${fn})(d); })()`) as Promise<T>;
}

const STATUS_LABELS = {
  confirmed: 'Pedido confirmado',
  picking: 'Preparando tu pedido',
  packed: 'Empacado en frío',
  out_for_delivery: 'En camino',
  delivered: 'Entregado',
  pending_payment: 'Esperando pago',
  cancelled: 'Cancelado',
} as const;

async function orderStatusText(page: Page): Promise<string> {
  return (await page.getByTestId('order-status').innerText().catch(() => '')).trim();
}

/** Recarga la pantalla del pedido hasta ver `label` (el pedido sigue avanzando mientras tanto). */
async function waitForStatus(page: Page, label: string, seen: Set<string>, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const text = await orderStatusText(page);
    if (text) seen.add(text);
    if (text.includes(label)) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`✖ El pedido nunca llegó a "${label}" (último estado: "${text}")`);
    }
    await sleep(1500);
    await page.reload();
    await page.getByTestId('order-status').waitFor({ timeout: 20_000 }).catch(() => {});
  }
}

interface DeviceCase {
  name: 'iphone' | 'pixel';
  descriptor: (typeof devices)[string];
}

const CASES: DeviceCase[] = [
  { name: 'iphone', descriptor: devices['iPhone 14']! },
  { name: 'pixel', descriptor: devices['Pixel 7']! },
];

// ───────────────────────── el recorrido ─────────────────────────

interface RunOptions {
  device: DeviceCase;
  mount: MountName;
  quick: boolean;
  photos: 'black' | 'fail';
}

async function journey(browser: Awaited<ReturnType<typeof chromium.launch>>, o: RunOptions) {
  currentLabel = `${o.device.name}-${o.mount}${o.photos === 'fail' ? '-sinfotos' : ''}`;
  const net: NetLog = { external: [], cdn: 0, failed: [] };
  const ctx = await browser.newContext({
    ...o.device.descriptor,
    locale: 'es-DO',
    timezoneId: 'America/Santo_Domingo',
    colorScheme: 'dark',
  });
  await lockNetwork(ctx, o.photos, net);
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  const badResponses: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const text = m.text();
      // Con las fotos cortadas a propósito el navegador avisa de cada una: es lo esperado.
      if (o.photos === 'fail' && /Failed to load resource|ERR_FAILED/.test(text)) return;
      consoleErrors.push(text);
    }
  });
  page.on('response', (r) => {
    if (r.url().startsWith(ORIGIN) && r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(ORIGIN)) net.failed.push(r.url());
  });

  const mountPath = MOUNTS[o.mount];
  const speed = 2;
  const url = `${ORIGIN}${mountPath}${mountPath.endsWith('/') ? '' : ''}?speed=${speed}&reset=1`;
  const tab = (name: RegExp) => page.getByRole('tab', { name });

  try {
    // ───── Inicio ─────
    await page.goto(url);
    await page.locator('#jf-ribbon').waitFor();
    await tab(/Buscar/).waitFor({ timeout: 45_000 });
    await shot(page, '01-inicio');
    const ribbon = await page.locator('#jf-ribbon').innerText();
    check(/VISTA PREVIA/.test(ribbon) && /123456/.test(ribbon), 'la cinta dice VISTA PREVIA y el código de prueba 123456');
    const base = await page.evaluate('document.querySelector("base").getAttribute("href")');
    check(base === (mountPath.endsWith('/') ? mountPath : `${mountPath}/`), `la carpeta base se calculó sola (${String(base)})`);
    const demoOn = await page.evaluate('typeof window.JellyfishDemo === "object"');
    check(demoOn === true, 'el servidor de demostración está instalado antes de que arranque la app');
    check(
      (await page.getByText('Camarón').count()) > 0 || (await page.getByText('Res').count()) > 0,
      'el inicio muestra productos y categorías del catálogo de ejemplo',
    );
    const pathAtStart = new URL(page.url()).pathname;
    check(!/Unmatched|No encontramos esta página/i.test(await page.locator('body').innerText()), 'el router reconoce la pantalla de inicio en la subcarpeta');

    // ───── Categorías ─────
    await page.getByRole('button', { name: /Categoría Mariscos/ }).first().click();
    await page.getByTestId('search-results').getByText('Camarón').first().waitFor({ timeout: 20_000 });
    await shot(page, '02-categoria');
    check(new URL(page.url()).pathname.startsWith(mountPath.replace(/\/$/, '')), 'al navegar, la dirección sigue dentro de la subcarpeta');

    // ───── Búsqueda sin acento ─────
    await page.getByTestId('search-input').fill('camaron');
    await page.getByTestId('search-results').getByText('Camarón').first().waitFor();
    await shot(page, '03-busqueda');
    check(
      (await page.getByTestId('search-results').getByText('Camarón').count()) > 0,
      'buscar "camaron" (sin tilde) encuentra Camarón',
    );

    // ───── Detalle con variantes ─────
    await page.getByTestId('search-results').getByText('Camarón').first().click();
    await page.getByRole('button', { name: '16/20' }).click();
    await shot(page, '04-producto');
    check(await page.getByText('16/20').first().isVisible(), 'el detalle muestra las variantes (calibres) y deja elegir una');
    await page.getByTestId('add-to-cart').click();
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Agregar' }).click();
    await shot(page, '05-producto-agregado');

    if (o.quick) {
      await page.evaluate('navigator.serviceWorker.ready.then(function(){return true})');
      await page.reload();
      await page.getByTestId('add-to-cart').waitFor({ timeout: 45_000 });
      check(
        new URL(page.url()).pathname.includes('/product/camaron'),
        'recargar en una pantalla interna (detalle de producto) la vuelve a abrir, aunque el servidor no conozca esa ruta',
      );
      await shot(page, '06-recargado-en-producto');
      await page.goto(url.replace('&reset=1', ''));
      await tab(/Buscar/).waitFor({ timeout: 45_000 });
      check(!/Unmatched/i.test(await page.locator('body').innerText()), 'recargar en la pantalla de inicio funciona');
      return finish();
    }

    // ───── Carrito ─────
    await page.getByRole('button', { name: 'Ver carrito' }).click();
    await page.getByTestId('go-checkout').waitFor({ timeout: 20_000 });
    await shot(page, '06-carrito');
    const goText = await page.getByTestId('go-checkout').innerText();
    check(/RD\$/.test(goText), `el carrito calcula el total en pesos (${goText.replace(/\s+/g, ' ')})`);

    // ───── Login por OTP (123456) ─────
    await page.getByTestId('go-checkout').click();
    const phone = `809555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await page.getByTestId('phone-input').fill(phone);
    await shot(page, '07-login');
    await page.getByTestId('send-code').click();
    await page.getByTestId('otp-input').waitFor();
    await page.getByTestId('otp-input').fill('123456');
    await page.getByText('Confirmar pedido').first().waitFor({ timeout: 20_000 });
    check(true, 'entró con el código de prueba 123456');

    // ───── Dirección ─────
    await shot(page, '08-checkout');
    await page.getByTestId('add-address').click();
    await page.getByTestId('addr-line1').fill('Calle Max Henríquez Ureña #10');
    await page.getByTestId('addr-sector').fill('Piantini');
    await page.getByTestId('addr-reference').fill('Al lado del colmado Don Pepe, portón negro');
    await page.getByText('¡Llegamos a tu sector!').waitFor();
    await shot(page, '09-direccion');
    await page.getByTestId('save-address').click();
    await page.getByText('Piantini').first().waitFor();

    // ───── Checkout en efectivo ─────
    const slotButtons = page.getByRole('button').filter({ hasText: /\d:\d\d [ap]\. m\. – / });
    await slotButtons.first().click();
    await page.getByTestId('checkout-name').fill('Andrés Prueba');
    await shot(page, '10-checkout-listo');
    check(await page.getByTestId('place-order').isEnabled(), 'con dirección, horario y pago el botón de confirmar se habilita');
    await page.getByTestId('place-order').click();
    await page.getByTestId('order-status').waitFor({ timeout: 20_000 });
    await shot(page, '11-pedido-efectivo');
    check((await orderStatusText(page)).includes(STATUS_LABELS.confirmed), 'el pedido en efectivo queda confirmado');

    const orderState = await demoState<{ id: string; pin: string; code: string }>(
      page,
      '(d)=>{var o=d.handle.server.ctx.state.orders[0];return {id:o.id,pin:o.deliveryPin,code:"JF-"+String(o.number).padStart(6,"0")}}',
    );
    check(/^\d{4}$/.test(orderState.pin), `el pedido trae un PIN de entrega de 4 dígitos (${orderState.pin})`);
    soft(await page.getByText(orderState.pin).first().isVisible().catch(() => false), 'la pantalla del pedido muestra el PIN al cliente', 'la pantalla del PIN la construye otro equipo');

    // ───── Etapas del pedido ─────
    const seen = new Set<string>();
    await waitForStatus(page, STATUS_LABELS.picking, seen);
    await shot(page, '12-preparando');
    await waitForStatus(page, STATUS_LABELS.packed, seen);
    await waitForStatus(page, STATUS_LABELS.out_for_delivery, seen);
    await shot(page, '13-en-camino');
    check(true, 'el pedido avanza solo: confirmado → preparando → empacado → en camino');

    // ───── Seguimiento ─────
    const token = await page.evaluate('localStorage.getItem("jellyfish.token")');
    const tracking = await page.evaluate(
      `fetch("https://demo.jellyfish.local/v1/orders/${orderState.id}/tracking",{headers:{Authorization:"Bearer ${String(token)}"}}).then(r=>r.json())`,
    ) as { available: boolean; latitude?: number; longitude?: number };
    check(tracking.available === true && typeof tracking.latitude === 'number', 'el seguimiento devuelve la posición del repartidor simulado en Santo Domingo');
    soft(
      /repartidor|Seguimiento en vivo|¿Dónde va/i.test(await page.locator('body').innerText()),
      'la pantalla del pedido muestra el seguimiento del repartidor',
      'la pantalla de seguimiento la construye otro equipo',
    );
    await waitForStatus(page, STATUS_LABELS.delivered, seen);
    await shot(page, '14-entregado');
    check(true, 'el pedido llega a Entregado');
    const delivered = await demoState<{ pinVerifiedAt: string | null; payment: string }>(
      page,
      '(d)=>{var o=d.handle.server.ctx.state.orders[0];return {pinVerifiedAt:o.pinVerifiedAt,payment:o.payments[0].status}}',
    );
    check(delivered.pinVerifiedAt !== null && delivered.payment === 'captured', 'al entregar, el PIN queda verificado y el efectivo cobrado');

    // ───── Pedir de nuevo ─────
    const reorderBtn = page.getByRole('button', { name: /Pedir de nuevo/i });
    const hasReorderUi = (await reorderBtn.count()) > 0;
    soft(hasReorderUi, 'hay un botón "Pedir de nuevo" en el pedido entregado', 'lo construye otro equipo');
    if (hasReorderUi) {
      await reorderBtn.first().click();
      await page.waitForTimeout(1500);
      await shot(page, '15-pedir-de-nuevo');
    }
    const reorder = await page.evaluate(
      `fetch("https://demo.jellyfish.local/v1/orders/${orderState.id}/reorder",{headers:{Authorization:"Bearer ${String(token)}"}}).then(r=>r.json())`,
    ) as { lines: { status: string }[] };
    check(reorder.lines.length > 0 && reorder.lines.every((l) => l.status === 'ok'), 'pedir de nuevo devuelve las líneas del pedido contra el catálogo de hoy');

    // ───── Pedido con tarjeta ─────
    // Carga limpia de la página: el carrito (y la sesión) sobreviven a recargar.
    await page.goto(url.replace('&reset=1', ''));
    await tab(/Carrito/).waitFor({ timeout: 45_000 });
    if (!hasReorderUi) {
      await tab(/Buscar/).click();
      await page.getByTestId('search-input').fill('camaron');
      await page.getByTestId('search-results').getByText('Camarón').first().click();
      await page.getByRole('button', { name: '16/20' }).click();
      await page.getByTestId('add-to-cart').click();
      for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Agregar' }).click();
      await page.getByRole('button', { name: 'Ver carrito' }).click();
    } else {
      await tab(/Carrito/).click();
    }
    await page.getByTestId('go-checkout').click();
    await page.getByText('Confirmar pedido').first().waitFor({ timeout: 20_000 });
    await page.getByRole('button').filter({ hasText: /\d:\d\d [ap]\. m\. – / }).first().click();
    await page.getByTestId('pay-card').click();
    await shot(page, '16-checkout-tarjeta');
    const pagesBefore = ctx.pages().length;
    await page.getByTestId('place-order').click();
    await page.getByTestId('order-status').waitFor({ timeout: 20_000 });
    check((await orderStatusText(page)).includes(STATUS_LABELS.pending_payment) || (await orderStatusText(page)).includes(STATUS_LABELS.confirmed), 'el pedido con tarjeta empieza esperando el pago');
    await page.getByText(STATUS_LABELS.confirmed).first().waitFor({ timeout: 20_000 });
    await shot(page, '17-tarjeta-aprobada');
    check(ctx.pages().length === pagesBefore, 'el pago con tarjeta NO abre ninguna pasarela (ni pestaña nueva)');
    check(await page.getByText('Pagado').first().isVisible().catch(() => false), 'el servidor de demostración aprueba el pago y el pedido queda Pagado');

    // ───── Pedidos, perfil, favoritos y legales ─────
    await page.goto(url.replace('&reset=1', ''));
    await tab(/Pedidos/).click();
    await page.getByText(/^JF-\d{6}$/).first().waitFor({ timeout: 20_000 });
    await shot(page, '18-pedidos');
    check((await page.getByText(/^JF-\d{6}$/).count()) >= 2, 'Mis pedidos lista los dos pedidos hechos');
    await tab(/Perfil/).click();
    await page.getByText('Mis direcciones').waitFor();
    await shot(page, '19-perfil');
    const profileText = await page.locator('body').innerText();
    soft(/Favoritos/i.test(profileText), 'el perfil tiene Favoritos', 'lo construye otro equipo');
    soft(/Términos|Privacidad/i.test(profileText), 'el perfil tiene los textos legales', 'lo construye otro equipo');

    // ───── Recarga: todo persiste ─────
    await page.reload();
    await tab(/Perfil/).waitFor({ timeout: 45_000 });
    await tab(/Pedidos/).click();
    await page.getByText(/^JF-\d{6}$/).first().waitFor({ timeout: 20_000 });
    check((await page.getByText(/^JF-\d{6}$/).count()) >= 2, 'tras recargar la página, la sesión y los pedidos siguen ahí');
    await shot(page, '20-despues-de-recargar');
    void pathAtStart;
    return finish();
  } catch (e) {
    await page.screenshot({ path: `${OUT}/${currentLabel}-FALLO.png` }).catch(() => {});
    console.error(`Texto visible al fallar:\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 700)}`);
    console.error(`URL: ${page.url()}`);
    if (consoleErrors.length) console.error(`Errores del navegador:\n- ${consoleErrors.slice(0, 6).join('\n- ')}`);
    throw e;
  } finally {
    await ctx.close();
  }

  function finish() {
    check(consoleErrors.length === 0, `0 errores de consola${consoleErrors.length ? `: ${consoleErrors.slice(0, 3).join(' | ')}` : ''}`);
    check(badResponses.length === 0, `ningún archivo local falló (404/500)${badResponses.length ? `: ${badResponses.slice(0, 3).join(' | ')}` : ''}`);
    check(net.external.length === 0, `ninguna petición salió a internet salvo las fotos del CDN${net.external.length ? `: ${net.external.slice(0, 3).join(' | ')}` : ''}`);
    log(`  fotos del CDN pedidas: ${net.cdn} (${o.photos === 'black' ? 'respondidas con imagen negra' : 'cortadas a propósito'})`);
  }
}

// ───────────────────────── principal ─────────────────────────

async function main() {
  if (!existsSync(`${DIST}/index.html`)) {
    throw new Error(`No existe ${DIST}/index.html: corre primero  npm run preview:build`);
  }
  const server = startServer();
  if (args.serve) {
    console.log(`\nVista previa servida en:\n  ${ORIGIN}/            (raíz)\n  ${ORIGIN}${MOUNTS.subdir}   (subcarpeta)\n  ${ORIGIN}${MOUNTS.noslash}      (subcarpeta sin barra)\nCtrl+C para salir.\n`);
    await new Promise(() => {});
  }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const devs = CASES.filter((c) => args.device === 'all' || c.name === args.device);
  const mounts = (Object.keys(MOUNTS) as MountName[]).filter((m) => args.mount === 'all' || m === args.mount);
  let failed = 0;
  try {
    for (const device of devs) {
      for (const mount of mounts) {
        // Recorrido completo en la subcarpeta; en la raíz y sin barra, el recorrido rápido (la app es la misma).
        const quick = args.quick || mount === 'noslash';
        try {
          await journey(browser, { device, mount, quick, photos: 'black' });
        } catch (e) {
          failed++;
          console.error(`\n✖ ${currentLabel}: ${e instanceof Error ? e.message : e}\n`);
        }
      }
    }
    if (!args.quick && devs.length > 0) {
      // Respaldo cuando las fotos no cargan.
      try {
        await journey(browser, { device: devs[0]!, mount: 'subdir', quick: true, photos: 'fail' });
      } catch (e) {
        failed++;
        console.error(`\n✖ ${currentLabel}: ${e instanceof Error ? e.message : e}\n`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(`${OUT}/report.json`, JSON.stringify(results, null, 2));
  const hard = results.filter((r) => !r.soft);
  const softMiss = results.filter((r) => r.soft && !r.ok);
  console.log(
    `\n${failed === 0 ? '✔' : '✖'} ${hard.filter((r) => r.ok).length}/${hard.length} comprobaciones, ${softMiss.length} pendientes de otros equipos. Capturas y report.json en ${OUT}\n`,
  );
  if (softMiss.length) for (const s of softMiss) console.log(`  ⚠ ${s.name} (${s.note || 'pendiente'})`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
