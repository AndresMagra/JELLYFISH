/**
 * Recorrido completo de la app del cliente en un navegador real (Chromium), contra el API real
 * en modo demo y con la pasarela de tarjeta simulada.
 *
 *   npx tsx scripts/e2e-customer.ts          (toma capturas en tmp/e2e)
 *   E2E_OUT=/ruta npx tsx scripts/e2e-customer.ts
 *   E2E_SKIP_EXPORT=1 …                      (reutiliza apps/customer/dist)
 *
 * Es la prueba de que las pantallas, el API y el cobro funcionan juntos. No sustituye probar en
 * un iPhone/Android reales (navegador seguro, teclado, notificaciones).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { type BrowserContext, type Page, chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const OUT = resolve(process.env.E2E_OUT ?? `${root}/tmp/e2e`);
const API_PORT = 3998;
const WEB_PORT = 8089;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

mkdirSync(OUT, { recursive: true });
const children: ChildProcess[] = [];
let apiLog = '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`• ${m}`);

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = root, capture = false) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (d: Buffer) => {
    if (capture) apiLog += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (capture) apiLog += d.toString();
  });
  return child;
}

function stopAll() {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
}

async function waitFor(url: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* aún no */
    }
    await sleep(1000);
  }
  throw new Error(`No respondió: ${url}`);
}

function serveStatic(dir: string, port: number) {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let file = join(dir, path);
    // Aplicación de una sola página: cualquier ruta desconocida devuelve index.html.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  server.listen(port);
  return server;
}

const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.waitForTimeout(500); // deja terminar animaciones y carga de imágenes
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  log(`captura ${name}.png`);
}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`✖ ${message}`);
  log(`✔ ${message}`);
}

async function otpFor(phoneE164: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    const m = [
      ...apiLog.matchAll(new RegExp(`Código para ${phoneE164.replace('+', '\\+')}: (\\d{6})`, 'g')),
    ].pop();
    if (m) return m[1]!;
    await sleep(300);
  }
  throw new Error(`No apareció el código OTP de ${phoneE164} en el log del API`);
}

async function typeOtp(page: Page, phone: string) {
  const code = await otpFor(phone);
  await page.getByTestId('otp-input').fill(code);
}

async function run() {
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
      TRANSFER_BANK: 'Banco de Pruebas',
      TRANSFER_ACCOUNT_NUMBER: '000-000000-0',
      TRANSFER_HOLDER: 'JELLYFISH SRL (PRUEBA)',
      TRANSFER_RNC: '000-00000-0',
    },
    root,
    true,
  );
  await waitFor(`${API}/health`);

  if (process.env.E2E_SKIP_EXPORT !== '1') {
    log('Empaquetando la app para web…');
    await new Promise<void>((ok, fail) => {
      const p = spawn('npx', ['expo', 'export', '--platform', 'web'], {
        cwd: `${root}/apps/customer`,
        env: { ...process.env, EXPO_PUBLIC_API_URL: API, EXPO_NO_TELEMETRY: '1', CI: '1' },
        stdio: 'ignore',
      });
      p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`expo export falló (${code})`))));
    });
  }
  const server = serveStatic(`${root}/apps/customer/dist`, WEB_PORT);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const newContext = (scheme: 'dark' | 'light'): Promise<BrowserContext> =>
    browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
    });

  const errors: string[] = [];
  let current: Page | null = null;
  try {
    const ctx = await newContext('dark');
    const page = await ctx.newPage();
    current = page;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()))
        errors.push(m.text());
    });

    // ───── Inicio ─────
    await page.goto(WEB);
    await page.getByText('Congelados de primera, a tu puerta').waitFor({ timeout: 30_000 });
    await page.getByText('MODO DEMOSTRACIÓN').waitFor();
    await shot(page, '01-inicio');
    check(
      await page.getByText('Bistec de res').first().isVisible(),
      'el inicio muestra productos reales del API',
    );

    // ───── Búsqueda sin acentos ─────
    await page.getByRole('tab', { name: /Buscar/ }).click();
    await page.getByTestId('search-input').fill('camaron');
    await page.getByTestId('search-results').getByText('Camarón crudo congelado').first().waitFor();
    await shot(page, '02-busqueda');
    check(
      await page.getByText('Camarón precocido congelado').first().isVisible(),
      'buscar "camaron" (sin tilde) encuentra camarones',
    );

    // ───── Producto con variantes ─────
    await page.getByTestId('search-results').getByText('Camarón crudo congelado').first().click();
    await page.getByRole('button', { name: '26/30' }).click();
    await page.getByText('Pagas el peso real').waitFor();
    await shot(page, '03-producto');
    await page.getByTestId('add-to-cart').click();
    await page.getByText('Estimado').first().waitFor();
    await page.getByRole('button', { name: 'Agregar' }).click(); // 2 lb: supera el pedido mínimo de la zona
    await shot(page, '04-producto-agregado');

    // ───── Carrito ─────
    await page.getByRole('button', { name: 'Ver carrito' }).click();
    await page.getByText('Total estimado').first().waitFor();
    await shot(page, '05-carrito');
    check(
      (await page.getByTestId('go-checkout').innerText()).includes('RD$ 1,380.00'),
      'el carrito calcula 2 lb de camarón 26/30 a RD$ 1,380.00',
    );

    // ───── Login por teléfono (OTP real) ─────
    await page.getByTestId('go-checkout').click();
    await page.getByText('Entra a JELLYFISH').waitFor();
    await shot(page, '06-login');
    const phone = `+1809555${String(Math.floor(1000 + Math.random() * 8999))}`;
    await page.getByTestId('phone-input').fill(phone.slice(2));
    await page.getByTestId('send-code').click();
    await page.getByText('Escribe tu código').waitFor();
    await page.getByTestId('otp-input').focus();
    await shot(page, '07-codigo');
    await typeOtp(page, phone);

    // ───── Checkout ─────
    await page.getByText('Confirmar pedido').first().waitFor({ timeout: 15_000 });
    await shot(page, '08-checkout-vacio');
    check(
      await page.getByTestId('blocked-reason').isVisible(),
      'si falta algo, el checkout explica por qué no se puede confirmar',
    );
    check(
      await page.getByText('Agregar dirección de entrega').isVisible(),
      'sin direcciones, el checkout la pide',
    );
    await page.getByTestId('add-address').click();
    await page.getByTestId('addr-line1').fill('Calle Max Henríquez Ureña #10');
    await page.getByTestId('addr-sector').fill('Piantini');
    await page.getByTestId('addr-reference').fill('Al lado del colmado Don Pepe, portón negro');
    await page.getByText('¡Llegamos a tu sector!').waitFor();
    await shot(page, '09-direccion');
    await page.getByTestId('save-address').click();

    await page.getByText('Piantini').first().waitFor();
    // primera franja disponible del primer día
    const slotButtons = page.getByRole('button').filter({ hasText: /\d:\d\d [ap]\. m\. – / });
    await slotButtons.first().click();
    await page.getByTestId('checkout-name').fill('Andrés Prueba');
    await shot(page, '10-checkout-listo');
    check(
      await page.getByTestId('place-order').isEnabled(),
      'con dirección, horario y pago el botón de confirmar se habilita',
    );

    // ───── Pedido en efectivo ─────
    await page.getByTestId('place-order').click();
    await page.getByTestId('order-status').waitFor({ timeout: 20_000 });
    await shot(page, '11-pedido-efectivo');
    check(
      (await page.getByTestId('order-status').innerText()).includes('Pedido confirmado'),
      'el pedido en efectivo queda confirmado',
    );
    check(
      await page.getByText(/Pagas .* en efectivo al recibir/).isVisible(),
      'muestra cuánto pagar en efectivo',
    );

    // ───── Pedido con tarjeta (pasarela simulada en otra pestaña) ─────
    await page.goto(WEB);
    await page.getByText('Congelados de primera, a tu puerta').waitFor();
    await page.getByRole('tab', { name: /Buscar/ }).click();
    await page.getByTestId('search-input').fill('pechuga');
    await page
      .getByTestId('search-results')
      .getByText('Pechuga de pollo deshuesada')
      .first()
      .click();
    await page.getByTestId('add-to-cart').click();
    // 3 lb más para pasar el pedido mínimo: cada "+" suma media libra
    for (let i = 0; i < 9; i++) await page.getByRole('button', { name: 'Agregar' }).click();
    await page.getByRole('button', { name: 'Ver carrito' }).click();
    await page.getByTestId('go-checkout').click();
    await page.getByText('Confirmar pedido').first().waitFor();
    await page.getByText('Piantini').first().click();
    await page
      .getByRole('button')
      .filter({ hasText: /\d:\d\d [ap]\. m\. – / })
      .first()
      .click();
    await page.getByTestId('pay-card').click();
    await shot(page, '12-checkout-tarjeta');
    const [bank] = await Promise.all([
      ctx.waitForEvent('page'),
      page.getByTestId('place-order').click(),
    ]);
    await page.getByTestId('order-status').waitFor({ timeout: 20_000 });
    check(
      (await page.getByTestId('order-status').innerText()).includes('Esperando pago'),
      'el pedido con tarjeta espera el pago',
    );
    await shot(page, '13-pedido-esperando-pago');

    await bank.getByText('Pasarela simulada').waitFor({ timeout: 20_000 });
    await bank.screenshot({ path: `${OUT}/14-pasarela-simulada.png` });
    shots.push(`${OUT}/14-pasarela-simulada.png`);
    await bank.getByText('Aprobar pago').click();
    await bank.getByText('¡Pago recibido!').waitFor();
    await bank.screenshot({ path: `${OUT}/15-pago-aprobado.png` });
    shots.push(`${OUT}/15-pago-aprobado.png`);
    await bank.close();

    await page.reload();
    await page.getByTestId('order-status').waitFor();
    await page.getByText('Pagado').first().waitFor({ timeout: 15_000 });
    await shot(page, '16-pedido-pagado');
    check(
      (await page.getByTestId('order-status').innerText()).includes('Pedido confirmado'),
      'tras aprobar el pago el pedido pasa a confirmado',
    );

    // ───── Pedidos y perfil ─────
    await page.goto(WEB);
    await page.getByRole('tab', { name: /Pedidos/ }).click();
    await page.getByText('Mis pedidos').waitFor();
    await page
      .getByText(/^JF-\d{6}$/)
      .first()
      .waitFor();
    await shot(page, '17-pedidos');
    await page.getByRole('tab', { name: /Perfil/ }).click();
    await page.getByText('Mis direcciones').waitFor();
    await shot(page, '18-perfil');

    // ───── Modo claro ─────
    const light = await (await newContext('light')).newPage();
    await light.goto(WEB);
    await light.getByText('Congelados de primera, a tu puerta').waitFor({ timeout: 30_000 });
    await shot(light, '19-inicio-claro');

    check(
      errors.length === 0,
      `sin errores de consola/JS en el navegador${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
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
    throw e;
  } finally {
    await browser.close();
    server.close();
  }
}

run()
  .catch((e) => {
    console.error(`\n${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopAll();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
