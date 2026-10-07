/**
 * Recorrido del panel de administración en Chromium contra el API real (SIN modo demo, para
 * ejercitar la regla "nada se publica hasta confirmar precio e ITBIS").
 *
 *   npx tsx scripts/e2e-admin.ts          (capturas en tmp/e2e-admin)
 *   E2E_SKIP_BUILD=1 …                    (reutiliza apps/admin/dist)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Page, chromium } from 'playwright-core';
import {
  CHROME,
  apiLogin,
  check,
  log,
  root,
  run,
  serveStatic,
  start,
  stopAll,
  waitFor,
} from './e2e-lib';

const OUT = resolve(process.env.E2E_OUT ?? `${root}/tmp/e2e-admin`);
const API_PORT = 3997;
const WEB_PORT = 8090;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const ADMIN_PHONE = '809-555-0100';
mkdirSync(OUT, { recursive: true });

const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(name);
  log(`captura ${name}.png`);
}

async function main() {
  log('Iniciando API (sin modo demo) con administrador inicial…');
  const apiEnv = {
    JELLYFISH_SEED: '1',
    PORT: String(API_PORT),
    BOOTSTRAP_ADMIN_PHONE: ADMIN_PHONE,
    PUBLIC_API_URL: API,
  };
  start('npx', ['tsx', 'apps/api/src/server.ts'], apiEnv, root, true);
  await waitFor(`${API}/health`);

  if (process.env.E2E_SKIP_BUILD !== '1') {
    log('Compilando el panel…');
    await run('npx', ['vite', 'build'], `${root}/apps/admin`, { VITE_API_URL: API });
  }
  const server = serveStatic(`${root}/apps/admin/dist`, WEB_PORT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const errors: string[] = [];
  let page: Page | null = null;

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1360, height: 860 },
      colorScheme: 'dark',
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
      acceptDownloads: true,
    });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()))
        errors.push(m.text());
    });

    // ───── Acceso ─────
    await page.goto(WEB);
    await page.getByText('Panel de administración').waitFor({ timeout: 20_000 });
    await shot(page, '01-login');
    await page.getByTestId('login-phone').fill(ADMIN_PHONE);
    await page.getByTestId('login-send').click();
    const { otpFor } = await import('./e2e-lib');
    await page.getByTestId('login-code').fill(await otpFor(`+1${ADMIN_PHONE.replace(/\D/g, '')}`));
    await page.getByTestId('login-verify').click();
    await page.getByRole('heading', { name: 'Resumen' }).waitFor({ timeout: 15_000 });
    check(
      await page.getByText('Ningún producto está publicado todavía').isVisible(),
      'con el catálogo semilla, el panel avisa que nada está publicado',
    );
    await shot(page, '02-resumen');

    // ───── Un cliente sin permiso no entra ─────
    const other = await browser.newContext({
      viewport: { width: 1100, height: 800 },
      colorScheme: 'dark',
    });
    const p2 = await other.newPage();
    await p2.goto(WEB);
    await p2.getByTestId('login-phone').fill('829-555-0111');
    await p2.getByTestId('login-send').click();
    await p2.getByTestId('login-code').fill(await otpFor('+18295550111'));
    await p2.getByTestId('login-verify').click();
    await p2.getByText('no tiene acceso al panel').waitFor();
    check(true, 'un cliente que intenta entrar al panel es rechazado con un mensaje claro');
    await other.close();

    // ───── Catálogo: confirmar precios e ITBIS ─────
    await page
      .locator('.nav')
      .getByRole('link', { name: /Catálogo y precios/ })
      .click();
    await page.getByTestId('catalog-search').fill('pechuga de pollo deshuesada');
    await page.getByTestId('row-AVE-004').waitFor();
    await shot(page, '03-catalogo-bloqueado');
    check(
      (await page.getByTestId('row-AVE-004').innerText()).includes('Sin publicar'),
      'la pechuga aparece sin publicar (ITBIS por confirmar)',
    );
    await page.getByTestId('itbis-AVE-004').selectOption('0');
    await page.getByTestId('row-AVE-004').getByText('Publicado').waitFor();
    check(true, 'al definir el ITBIS, la pechuga (precio de referencia) queda publicada');

    await page.getByTestId('catalog-search').fill('alitas');
    await page.getByTestId('row-AVE-010').waitFor();
    const price = page.getByTestId('price-AVE-010');
    await price.fill('145.50');
    await price.press('Enter');
    await page.getByTestId('confirm-AVE-010').waitFor({ state: 'detached', timeout: 10_000 }); // su origen pasó a "Confirmado"
    await page.getByTestId('itbis-AVE-010').selectOption('0');
    await page.getByTestId('row-AVE-010').getByText('Publicado').waitFor();
    check(
      true,
      'cambiar el precio lo confirma; con ITBIS definido las alitas quedan publicadas a RD$ 145.50',
    );
    await shot(page, '04-catalogo-publicado');

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
    await shot(page, '05-importar-errores');
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
    await page.keyboard.press('Escape').catch(() => {});
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cerrar', exact: true })
      .first()
      .click();

    // ───── Exportar ─────
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-csv').click(),
    ]);
    const file = `${OUT}/catalogo-exportado.csv`;
    await download.saveAs(file);
    const csv = readFileSync(file, 'utf8');
    check(
      csv.startsWith('sku,grupo,nombre') && csv.includes('X-2,') && csv.includes('145.5'),
      'la exportación descarga un CSV con los cambios hechos',
    );

    // ───── Zona de entrega ─────
    await page.locator('.nav').getByRole('link', { name: 'Zonas de entrega' }).click();
    await page.getByText('Aún no entregas en ninguna zona').waitFor();
    await page.getByTestId('new-zone').click();
    await page.getByTestId('zone-name').fill('Distrito Nacional');
    await page.getByTestId('zone-areas').fill('Naco, Piantini, Bella Vista, Distrito Nacional');
    await page.getByTestId('zone-fee').fill('150');
    await page.getByTestId('zone-min').fill('800');
    await page.getByTestId('zone-free').fill('4000');
    await shot(page, '06-zona-nueva');
    await page.getByTestId('zone-save').click();
    await page.getByText('Cubre: naco, piantini, bella vista, distrito nacional').waitFor();
    check(true, 'la zona queda creada con tarifa, mínimo y envío gratis');
    await shot(page, '07-zonas');

    // ───── Inventario ─────
    await page.locator('.nav').getByRole('link', { name: 'Inventario' }).click();
    await page.getByTestId('inv-search').fill('pechuga de pollo deshuesada');
    await page.getByTestId('receive-AVE-004').click();
    await page.getByTestId('inv-qty').fill('100');
    await page.getByTestId('inv-confirm').click();
    await page.getByTestId('inv-AVE-004').getByText('100 lb').first().waitFor();
    check(true, 'recibir 100 lb de pechuga actualiza la existencia');
    await shot(page, '08-inventario');

    // ───── Equipo: repartidor ─────
    await page.locator('.nav').getByRole('link', { name: 'Equipo' }).click();
    await page.getByTestId('team-phone').fill('849-555-0177');
    await page.getByTestId('team-name').fill('Juan Motorista');
    await page.getByTestId('team-add').click();
    await page.getByTestId('member-+18495550177').waitFor();
    check(true, 'el repartidor queda agregado al equipo');
    await shot(page, '09-equipo');

    // ───── Un cliente hace un pedido (por API; la app ya tiene su propio recorrido) ─────
    const token = await apiLogin(API, '829-555-0222');
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const products = (await (await fetch(`${API}/v1/products?q=pechuga`)).json()) as {
      items: { group: string; variants: { id: string }[] }[];
    };
    check(
      products.items.length === 1,
      'solo la pechuga confirmada es visible para los clientes (el resto sigue bloqueado)',
    );
    const variantId = products.items[0]!.variants[0]!.id;
    const slots = (await (await fetch(`${API}/v1/delivery/slots`)).json()) as {
      start: string;
      available: boolean;
    }[];
    const orderRes = await fetch(`${API}/v1/orders`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        items: [{ variantId, quantity: 500 }],
        address: {
          line1: 'Calle 5 #12',
          reference: 'Frente al colmado Lilí',
          sector: 'Piantini',
          city: 'Santo Domingo',
        },
        slotStart: slots.find((s) => s.available)!.start,
        paymentMethod: 'cash',
        notes: 'Sin hielo seco, por favor',
      }),
    });
    const order = (await orderRes.json()) as { code: string; total: number };
    check(orderRes.status === 201, `el cliente hizo el pedido ${order.code} en efectivo`);

    // ───── Tablero y flujo completo del pedido ─────
    await page
      .locator('.nav')
      .getByRole('link', { name: /Pedidos/ })
      .click();
    await page.getByTestId(`order-${order.code}`).waitFor({ timeout: 15_000 });
    await shot(page, '10-tablero');
    await page.getByTestId(`order-${order.code}`).click();
    await page.getByText('Nota del cliente: Sin hielo seco').waitFor();
    await shot(page, '11-pedido-confirmado');
    await page.getByTestId('act-picking').click();
    await page.getByTestId('save-weights').waitFor();
    await page.getByTestId('weight-AVE-004').fill('5.23');
    await page.getByTestId('save-weights').click();
    await page.getByText('Pesos guardados').waitFor();
    await shot(page, '12-pesaje');
    await page.getByTestId('act-packed').click();
    await page.getByTestId('driver-select').waitFor();
    await page.getByTestId('driver-select').selectOption({ label: 'Juan Motorista' });
    await page.getByTestId('act-assign').click();
    await page.getByText('Repartidor asignado').waitFor();
    await page.getByTestId('act-out').click();
    await page.getByTestId('act-cash').waitFor();
    // sin cobro registrado no se puede entregar
    await page.getByTestId('act-delivered').click();
    await page.getByText(/Registra el cobro en efectivo/).waitFor();
    check(true, 'no deja marcar entregado un pedido en efectivo sin registrar el cobro');
    await page.getByTestId('act-cash').click();
    const due = await page.getByTestId('dialog-text').inputValue();
    check(due === '1064.99', `el cobro propuesto es el total real con el peso pesado (RD$ ${due})`);
    await page.getByTestId('dialog-confirm').click();
    await page.getByText('Cobro registrado').waitFor();
    await page.getByTestId('act-delivered').click();
    await page.getByText('Este pedido está cerrado.').waitFor();
    check(
      (await page.getByTestId('order-total').innerText()).includes('1,064.99'),
      'el total final del pedido refleja el peso real (5.23 lb × 174.95 + envío)',
    );
    await shot(page, '13-pedido-entregado');

    // ───── Resumen y cuadre de caja ─────
    await page.locator('.nav').getByRole('link', { name: 'Resumen' }).click();
    await page.getByTestId('stat-Efectivo por entregar').getByText('RD$ 1,064.99').waitFor();
    check(true, 'el resumen muestra RD$ 1,064.99 de efectivo en manos del repartidor');
    await shot(page, '14-resumen-final');
    await page
      .locator('.nav')
      .getByRole('link', { name: /Pagos y caja/ })
      .click();
    await page.getByTestId('tab-cash').click();
    await page.getByTestId('settle-+18495550177').click();
    await page.getByTestId('dialog-confirm').click();
    await page.getByText('Entrega de efectivo registrada').waitFor();
    await page.getByTestId('cash-+18495550177').getByText('RD$ 0.00').first().waitFor();
    check(true, 'al registrar la entrega del efectivo, el saldo del repartidor queda en RD$ 0.00');
    await shot(page, '15-caja');

    // ───── Móvil y modo claro ─────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const mp = await mobile.newPage();
    await mp.addInitScript(
      (t) => localStorage.setItem('jellyfish.admin.token', t),
      await page.evaluate(() => localStorage.getItem('jellyfish.admin.token')),
    );
    await mp.goto(WEB);
    await mp.getByRole('heading', { name: 'Resumen' }).waitFor();
    await shot(mp, '16-movil-claro');

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
