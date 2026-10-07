/**
 * Recorrido de la app del repartidor en Chromium (vista móvil) contra el API real.
 * Un administrador prepara los pedidos por la API; el repartidor los entrega por la interfaz.
 *
 *   npx tsx scripts/e2e-driver.ts       (capturas en tmp/e2e-driver)
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Page, chromium } from 'playwright-core';
import {
  CHROME,
  apiLogin,
  check,
  log,
  otpFor,
  root,
  run,
  serveStatic,
  start,
  stopAll,
  waitFor,
} from './e2e-lib';

const OUT = resolve(process.env.E2E_OUT ?? `${root}/tmp/e2e-driver`);
const API_PORT = 3996;
const WEB_PORT = 8091;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const ADMIN = '809-555-0100';
const DRIVER = '849-555-0177';
const CUSTOMER = '829-555-0222';
mkdirSync(OUT, { recursive: true });

const shots: string[] = [];
async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(name);
  log(`captura ${name}.png`);
}

const hdr = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});
async function call<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: hdr(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ''}`);
  return json;
}

interface Order {
  id: string;
  code: string;
  total: number;
  items: { id: string }[];
  payments: { id: string }[];
}

async function main() {
  log('Iniciando API en modo demo (catálogo publicado) con transferencia habilitada…');
  start(
    'npx',
    ['tsx', 'apps/api/src/server.ts'],
    {
      JELLYFISH_DEMO: '1',
      JELLYFISH_SEED: '1',
      PORT: String(API_PORT),
      PUBLIC_API_URL: API,
      BOOTSTRAP_ADMIN_PHONE: ADMIN,
      TRANSFER_BANK: 'Banco de Pruebas',
      TRANSFER_ACCOUNT_NUMBER: '000-000000-0',
      TRANSFER_HOLDER: 'JELLYFISH SRL (PRUEBA)',
    },
    root,
    true,
  );
  await waitFor(`${API}/health`);

  // ───── Preparación por API: admin, repartidor, 3 pedidos listos para entregar ─────
  const admin = await apiLogin(API, ADMIN);
  await call(admin, '/v1/admin/users', 'POST', {
    phone: DRIVER,
    name: 'Juan Motorista',
    role: 'driver',
  });
  const customer = await apiLogin(API, CUSTOMER);
  const drivers = await call<{ id: string; phone: string }[]>(admin, '/v1/admin/drivers');
  const driverId = drivers.find((d) => d.phone === '+18495550177')!.id;

  const pechuga = (
    await call<{ items: { variants: { id: string }[] }[] }>(
      customer,
      '/v1/products?q=pechuga%20deshuesada',
    )
  ).items[0]!.variants[0]!.id;
  const slots = await call<{ start: string; available: boolean }[]>(customer, '/v1/delivery/slots');
  const slotStart = slots.find((s) => s.available)!.start;
  const address = {
    line1: 'Av. Winston Churchill 100',
    reference: 'Torre azul, lobby, preguntar por Andrés',
    sector: 'Piantini',
    city: 'Santo Domingo',
  };
  const mk = (paymentMethod: string, quantity = 500) =>
    call<Order>(customer, '/v1/orders', 'POST', {
      items: [{ variantId: pechuga, quantity }],
      address,
      slotStart,
      paymentMethod,
      notes: 'Tocar el timbre dos veces',
    });

  const toPacked = async (o: Order, weight: number) => {
    await call(admin, `/v1/admin/orders/${o.id}/transition`, 'POST', { to: 'picking' });
    await call(admin, `/v1/admin/orders/${o.id}/weights`, 'POST', {
      weights: [{ itemId: o.items[0]!.id, finalQuantity: weight }],
    });
    await call(admin, `/v1/admin/orders/${o.id}/transition`, 'POST', { to: 'packed' });
    await call(admin, `/v1/admin/orders/${o.id}/assign-driver`, 'POST', { driverId });
  };
  const cash = await mk('cash');
  await toPacked(cash, 523);
  const transfer = await mk('transfer');
  await call(admin, `/v1/admin/payments/${transfer.payments[0]!.id}/mark-paid`, 'POST', {
    reference: 'BPD-001122',
  });
  await toPacked(transfer, 500);
  const failing = await mk('cash', 500);
  await toPacked(failing, 500);
  log(
    `Pedidos listos: ${cash.code} (efectivo), ${transfer.code} (transferencia pagada), ${failing.code} (efectivo)`,
  );

  // ───── App del repartidor ─────
  await run('npx', ['expo', 'export', '--platform', 'web'], `${root}/apps/driver`, {
    EXPO_PUBLIC_API_URL: API,
    EXPO_NO_TELEMETRY: '1',
    CI: '1',
  });
  const server = serveStatic(`${root}/apps/driver/dist`, WEB_PORT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });
  const errors: string[] = [];
  let page: Page | null = null;
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
    });
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()))
        errors.push(m.text());
    });

    // Una persona que no es repartidor no ve entregas
    const other = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    await other.goto(WEB);
    await other.getByText('Entra a JELLYFISH').waitFor({ timeout: 30_000 });
    await other.getByTestId('phone-input').fill(CUSTOMER);
    await other.getByTestId('send-code').click();
    await other.getByText('Escribe tu código').waitFor();
    await other.getByTestId('otp-input').fill(await otpFor('+18295550222'));
    await other.getByText('Esta cuenta no es de repartidor').waitFor({ timeout: 15_000 });
    check(
      true,
      'un cliente que entra a la app del repartidor ve que su cuenta no es de repartidor',
    );

    // Acceso del repartidor
    await page.goto(WEB);
    await page.getByText('Entra a JELLYFISH').waitFor({ timeout: 30_000 });
    await page.getByTestId('phone-input').fill(DRIVER);
    await page.getByTestId('send-code').click();
    await page.getByText('Escribe tu código').waitFor();
    await page.getByTestId('otp-input').fill(await otpFor('+18495550177'));
    await page.getByText('Mis entregas').waitFor({ timeout: 15_000 });
    await page.getByTestId(`delivery-${cash.code}`).waitFor();
    await shot(page, '01-entregas');
    check(
      (await page.getByTestId(`delivery-${cash.code}`).innerText()).includes('Cobrar RD$'),
      'la entrega en efectivo muestra cuánto cobrar',
    );
    check(
      (await page.getByTestId(`delivery-${transfer.code}`).innerText()).includes('Ya está pagado'),
      'la entrega ya pagada dice que no se cobra nada',
    );

    // ───── Entrega en efectivo ─────
    await page.getByTestId(`delivery-${cash.code}`).click();
    await page.getByText('Dónde entregar').waitFor();
    check(
      await page.getByText('Torre azul, lobby').isVisible(),
      'se ve la referencia de la dirección',
    );
    await shot(page, '02-detalle-efectivo');
    const due = await page.getByTestId('amount-due').innerText();
    check(due.includes('1,064.99'), `cobra el total real con el peso pesado: ${due}`);
    const waze = await page.getByTestId('waze').count();
    check(waze === 1, 'ofrece abrir la ruta en Waze y Google Maps');

    await page.getByTestId('act-out').click();
    await page.getByTestId('act-collect').waitFor();
    // no puede entregarse sin cobrar: el botón de entregar no existe hasta cobrar
    check(
      (await page.getByTestId('act-delivered').count()) === 0,
      'antes de cobrar no existe el botón de entregar',
    );
    await shot(page, '03-en-camino');
    await page.getByTestId('act-collect').click();
    await page.getByTestId('act-delivered').waitFor();
    await page.getByTestId('act-delivered').click();
    await page.getByText('Mis entregas').first().waitFor();
    await page.getByTestId(`delivery-${cash.code}`).waitFor({ state: 'detached', timeout: 20_000 });
    check(true, 'la entrega en efectivo se completa y sale de la lista');

    // ───── Entrega ya pagada ─────
    await page.getByTestId(`delivery-${transfer.code}`).click();
    await page.getByText('Ya está pagado: no cobres nada').waitFor();
    await shot(page, '04-detalle-pagado');
    await page.getByTestId('act-out').click();
    await page.getByTestId('act-delivered').waitFor();
    await page.getByTestId('act-delivered').click();
    await page.getByText('Mis entregas').first().waitFor();
    check(true, 'la entrega ya pagada se completa sin cobrar nada');

    // ───── Entrega fallida ─────
    await page.getByTestId(`delivery-${failing.code}`).click();
    await page.getByTestId('act-out').click();
    await page.getByTestId('act-failed').click();
    await page.getByText('¿Qué pasó?').waitFor();
    await shot(page, '05-no-pude-entregar');
    await page.getByRole('button', { name: 'No había nadie' }).click();
    await page.getByText('Mis entregas').first().waitFor();
    await page
      .getByTestId(`delivery-${failing.code}`)
      .getByText('No se pudo entregar')
      .waitFor({ timeout: 20_000 });
    check(true, 'una entrega fallida queda marcada con su motivo y pendiente de reprogramar');
    await shot(page, '06-lista-final');

    // ───── Verificación en el servidor ─────
    const state = async (o: Order) =>
      call<{ status: string; timeline: { note: string }[] }>(admin, `/v1/admin/orders/${o.id}`);
    check(
      (await state(cash)).status === 'delivered',
      `${cash.code} quedó entregado en el servidor`,
    );
    check(
      (await state(transfer)).status === 'delivered',
      `${transfer.code} quedó entregado en el servidor`,
    );
    const f = await state(failing);
    check(
      f.status === 'delivery_failed' && f.timeline.some((t) => t.note === 'No había nadie'),
      `${failing.code} quedó como entrega fallida con el motivo`,
    );
    const cashRows = await call<{ phone: string; collected: number; balance: number }[]>(
      admin,
      '/v1/admin/cash',
    );
    const mine = cashRows.find((r) => r.phone === '+18495550177')!;
    check(
      mine.collected === 106_499 && mine.balance === 106_499,
      `el cuadre de caja le carga RD$ 1,064.99 al repartidor (${mine.collected / 100})`,
    );

    check(
      errors.length === 0,
      `sin errores de consola/JS${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
    );
    console.log(`\n✔ Recorrido del repartidor completo. ${shots.length} capturas en ${OUT}\n`);
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
        ).slice(0, 600)}`,
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
