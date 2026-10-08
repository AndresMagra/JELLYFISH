/**
 * Recorrido de la app del repartidor en Chromium (vista móvil) contra el API real en modo demo
 * (catálogo sembrado de data/catalog). Los pedidos los crea un cliente por la API (OTP real) con
 * productos reales, el administrador los prepara y los asigna, y el repartidor los entrega por la
 * interfaz: ubicación, ruta en el mapa, cobro en efectivo y PIN de 4 dígitos del cliente.
 *
 *   npx tsx scripts/e2e-driver.ts            (capturas en tmp/e2e-driver)
 *   E2E_OUT=/ruta npx tsx scripts/e2e-driver.ts   (capturas en otra carpeta; ahí no se borra nada)
 *   E2E_SKIP_EXPORT=1 …                      (reutiliza la app empaquetada en tmp/e2e-driver-web)
 *
 * Recorre: acceso por OTP (y que un cliente no entre como repartidor), explicación y permiso de
 * ubicación (también el "Ahora no"), una entrega fallida, una entrega en efectivo con peso real
 * (ruta en Waze y Google Maps, seguimiento del cliente, PIN incorrecto y correcto, cuadre de caja)
 * y una entrega ya pagada que se bloquea tras 5 PIN incorrectos y la cierra el administrador.
 * No sustituye probar en un teléfono real (GPS, permisos del sistema, Waze instalado).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type OrderDTO,
  type ProductListDTO,
  type TrackingDTO,
  type VariantDTO,
  computeOrderTotals,
  formatDOP,
  formatLb,
} from '@jellyfish/shared';
import { type Locator, type Page, chromium } from 'playwright-core';
import {
  CHROME,
  ISOLATED_API_ENV,
  OVERRIDE_MARKER,
  apiLog,
  apiLogin,
  assertPortFree,
  check,
  clearOwnShots,
  exposesOverrideReason,
  hasNeutralDeliveryNote,
  log,
  root,
  serveStatic,
  sleep,
  start,
  stopAll,
  track,
  waitFor,
} from './e2e-lib';

const DEFAULT_OUT = `${root}/tmp/e2e-driver`;
const OUT = resolve(process.env.E2E_OUT ?? DEFAULT_OUT);
const API_PORT = 3996;
const WEB_PORT = 8091;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
// Empaquetado y caché de Metro propios: no pisan apps/driver/dist ni a otros recorridos, y la
// caché solo se comparte entre corridas con la misma URL del API (Metro no la incluye en su clave).
const WEB_DIST = `${root}/tmp/e2e-driver-web`;
const METRO_TMP = `${root}/tmp/e2e-driver-metro-${API_PORT}`;
const ADMIN = '809-555-0100';
const DRIVER = '849-555-0177';
const CUSTOMER = '829-555-0222';
const CUSTOMER_NAME = 'Andrés Cliente';
const e164 = (phone: string) => `+1${phone.replace(/\D/g, '')}`;
/** Teléfono del administrador que la app ofrece cuando un pedido se bloquea (solo dígitos). */
const ADMIN_CONTACT = `1${ADMIN.replace(/\D/g, '')}`;
/** Dónde está el repartidor (Santo Domingo) y adónde se mueve; el destino del pedido A. */
const HERE = { latitude: 18.4861, longitude: -69.9312, accuracy: 10 };
const MOVED = { latitude: 18.479, longitude: -69.921, accuracy: 10 };
const DESTINATION = { latitude: 18.4707, longitude: -69.9396 };

const shots: string[] = [];
/** Captura numerada en orden de llegada: 01-entregas.png, 02-… */
async function shot(page: Page, name: string) {
  await page.waitForTimeout(500); // deja terminar animaciones y la hoja que sube
  const file = `${OUT}/${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  log(`captura ${file.slice(OUT.length + 1)}`);
}

// ───────────────────────── API (preparación y comparación) ─────────────────────────

async function callRaw<T>(token: string | null, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { code: string; message: string };
  };
  return { status: res.status, json, code: json.error?.code ?? '' };
}

async function call<T>(token: string | null, path: string, method = 'GET', body?: unknown) {
  const { status, json } = await callRaw<T>(token, path, method, body);
  if (status >= 400) {
    const msg = (json as { error?: { message: string } }).error?.message ?? '';
    throw new Error(`${method} ${path} → ${status} ${msg}`);
  }
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

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const wrongPinOf = (pin: string) => String((Number(pin) + 1) % 10_000).padStart(4, '0');
const attemptsText = (left: number) =>
  left === 1 ? 'Te queda 1 intento.' : `Te quedan ${left} intentos.`;

/** Código OTP que el API imprimió DESPUÉS de `since`: no se confunde con uno viejo del mismo teléfono. */
async function freshOtp(phoneE164: string, since: number): Promise<string> {
  const re = new RegExp(`Código para ${phoneE164.replace('+', '\\+')}: (\\d{6})`, 'g');
  for (let i = 0; i < 60; i++) {
    const m = [...apiLog.text.slice(since).matchAll(re)].pop();
    if (m) return m[1]!;
    await sleep(300);
  }
  throw new Error(`No apareció un código OTP nuevo de ${phoneE164} en el log del API`);
}

// ───────────────────────── Ayudas de la interfaz ─────────────────────────

/** Las pantallas anteriores siguen montadas bajo la actual: siempre se toca la que se ve. */
const tid = (scope: Page | Locator, id: string) =>
  scope.getByTestId(id).filter({ visible: true }).first();
const btn = (page: Page, name: string) =>
  page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
const seen = (page: Page | Locator, text: string | RegExp) =>
  page
    .getByText(text, typeof text === 'string' ? { exact: true } : {})
    .filter({ visible: true })
    .first();
const bodyText = (page: Page) => page.locator('body').innerText();

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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Errores de la página y respuestas 4xx/5xx del API ("MÉTODO ruta estado", con los ids como :id). */
function watch(page: Page, errors: string[], failures: string[]) {
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // "Failed to load resource" ya se cuenta abajo con la ruta y el estado.
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
      errors.push(m.text());
  });
  page.on('requestfailed', (r) => {
    if (new URL(r.url()).hostname === 'localhost')
      errors.push(`petición fallida ${r.method()} ${r.url()}: ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.port === String(API_PORT) && r.status() >= 400)
      failures.push(`${r.request().method()} ${u.pathname.replace(UUID, ':id')} ${r.status()}`);
  });
}

async function exportWeb(): Promise<void> {
  mkdirSync(METRO_TMP, { recursive: true });
  await new Promise<void>((ok, fail) => {
    let out = '';
    const p = spawn('npx', ['expo', 'export', '--platform', 'web', '--output-dir', WEB_DIST], {
      cwd: `${root}/apps/driver`,
      env: {
        ...process.env,
        EXPO_PUBLIC_API_URL: API,
        EXPO_PUBLIC_ADMIN_PHONE: ADMIN_CONTACT,
        EXPO_NO_TELEMETRY: '1',
        CI: '1',
        TMPDIR: METRO_TMP,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    track(p, true);
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
  const code = entry ? readFileSync(`${dir}/${entry}`, 'utf8') : '';
  if (!code.includes(API) || !code.includes(ADMIN_CONTACT)) {
    throw new Error(
      `El paquete web no trae la URL del API (${API}) o el teléfono del administrador. Borra ${METRO_TMP} y ${WEB_DIST} y vuelve a correr.`,
    );
  }
}

async function main() {
  // Un API viejo en el mismo puerto contaminaría la prueba sin avisar.
  await assertPortFree(API_PORT);
  await assertPortFree(WEB_PORT);
  mkdirSync(OUT, { recursive: true });
  // Las capturas se numeran en orden: las de una corrida anterior solo confundirían.
  clearOwnShots(OUT, DEFAULT_OUT);
  log('Iniciando API en modo demo (catálogo sembrado) con transferencia habilitada…');
  start(
    'npx',
    ['tsx', 'apps/api/src/server.ts'],
    {
      ...ISOLATED_API_ENV,
      JELLYFISH_DEMO: '1',
      JELLYFISH_SEED: '1',
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

  // ───── Preparación por API: repartidor, cliente real, 3 pedidos listos para entregar ─────
  const admin = await apiLogin(API, ADMIN);
  await call(admin, '/v1/admin/users', 'POST', {
    phone: DRIVER,
    name: 'Juan Motorista',
    role: 'driver',
  });
  const driver = await apiLogin(API, DRIVER);
  const customer = await apiLogin(API, CUSTOMER);
  await call(customer, '/v1/me', 'PATCH', { name: CUSTOMER_NAME });
  const driverId = need(
    (await call<{ id: string; phone: string }[]>(admin, '/v1/admin/drivers')).find(
      (d) => d.phone === e164(DRIVER),
    ),
    'repartidor de prueba',
  ).id;
  const zone = need(
    (await call<{ minOrderCentavos: number }[]>(admin, '/v1/admin/zones'))[0],
    'zona de entrega',
  );

  const catalog = (await call<ProductListDTO>(null, '/v1/products?limit=100')).items;
  const variantOf = (group: string, label = ''): VariantDTO =>
    need(
      need(
        catalog.find((p) => p.group === group),
        `ficha "${group}"`,
      ).variants.find((v) => v.variant === label),
      `presentación "${label}" de "${group}"`,
    );
  const camaron = variantOf('camaron', '16/20');
  const pechuga = variantOf('pechuga-de-pollo-americana');
  check(
    camaron.itbisBps !== pechuga.itbisBps,
    `el pedido mezcla ITBIS distinto (camarón ${camaron.itbisBps / 100} %, pechuga ${pechuga.itbisBps / 100} %)`,
  );

  /** Camarón y pechuga (ITBIS distinto), subiendo la pechuga hasta cumplir el mínimo de la zona. */
  const cart = (): CartLine[] => {
    const lines: CartLine[] = [
      { variant: camaron, quantity: 250 },
      { variant: pechuga, quantity: 300 },
    ];
    const totals = (ls: CartLine[]) =>
      computeOrderTotals(
        ls.map((l) => ({
          id: l.variant.id,
          pricingUnit: l.variant.pricingUnit,
          unitPrice: l.variant.price,
          itbisBps: l.variant.itbisBps,
          quantity: l.quantity,
          variableWeight: l.variant.variableWeight,
        })),
      );
    while (totals(lines).subtotal < zone.minOrderCentavos) lines[1]!.quantity += 50;
    return lines;
  };

  const slotStart = need(
    (await call<{ start: string; remaining: number }[]>(customer, '/v1/delivery/slots')).find(
      (s) => s.remaining >= 3,
    ),
    'una franja de entrega con cupo para 3 pedidos',
  ).start;
  const addressOf = (line1: string, withCoords: boolean) => ({
    line1,
    reference: 'Torre azul, lobby, preguntar por Andrés',
    sector: 'Piantini',
    city: 'Santo Domingo',
    ...(withCoords ? DESTINATION : {}),
  });
  const NOTE = 'Tocar el timbre dos veces';
  const mk = (paymentMethod: 'cash' | 'transfer', line1: string, withCoords: boolean) =>
    call<OrderDTO>(customer, '/v1/orders', 'POST', {
      items: cart().map((l) => ({ variantId: l.variant.id, quantity: l.quantity })),
      address: addressOf(line1, withCoords),
      slotStart,
      paymentMethod,
      notes: NOTE,
    });

  /** Pesa (con la báscula de `finals`), empaca y asigna al repartidor. */
  const toPacked = async (o: OrderDTO, finals: Record<string, number>) => {
    await call(admin, `/v1/admin/orders/${o.id}/transition`, 'POST', { to: 'picking' });
    await call(admin, `/v1/admin/orders/${o.id}/weights`, 'POST', {
      weights: o.items.map((i) => ({
        itemId: i.id,
        finalQuantity: finals[i.sku] ?? i.quantity,
      })),
    });
    await call(admin, `/v1/admin/orders/${o.id}/transition`, 'POST', { to: 'packed' });
    await call(admin, `/v1/admin/orders/${o.id}/assign-driver`, 'POST', { driverId });
  };

  // A: efectivo, con coordenadas y el peso real distinto del pedido (cobra el total real).
  const finalsA = { [camaron.sku]: 250 + 12, [pechuga.sku]: cart()[1]!.quantity - 12 };
  const a = await mk('cash', 'Av. Winston Churchill 100', true);
  await toPacked(a, finalsA);
  // B: transferencia ya pagada, sin coordenadas (el mapa busca por la dirección escrita).
  const b = await mk('transfer', 'Calle Max Henríquez Ureña 55', false);
  await call(admin, `/v1/admin/payments/${b.payments[0]!.id}/mark-paid`, 'POST', {
    reference: 'BPD-001122',
  });
  await toPacked(b, {});
  // C: efectivo; el repartidor no la podrá entregar.
  const c = await mk('cash', 'Av. Abraham Lincoln 8', false);
  await toPacked(c, {});
  log(
    `Pedidos listos: ${a.code} (efectivo), ${b.code} (transferencia pagada), ${c.code} (efectivo)`,
  );

  const adminOrder = (o: OrderDTO) => call<OrderDTO>(admin, `/v1/admin/orders/${o.id}`);
  const customerOrder = (o: OrderDTO) => call<OrderDTO>(customer, `/v1/orders/${o.id}`);
  const trackingOf = (o: OrderDTO) => call<TrackingDTO>(customer, `/v1/orders/${o.id}/tracking`);
  const pinOf = async (o: OrderDTO) => {
    const pin = need((await customerOrder(o)).deliveryPin, `PIN de ${o.code} para el cliente`);
    check(/^\d{4}$/.test(pin), `${o.code} tiene PIN de 4 dígitos para su cliente`);
    return pin;
  };

  // Total real que el repartidor debe cobrar, calculado aparte con el motor de precios.
  const adminA = await adminOrder(a);
  const expectedDueA = computeOrderTotals(
    cart().map((l) => ({
      id: l.variant.id,
      pricingUnit: l.variant.pricingUnit,
      unitPrice: l.variant.price,
      itbisBps: l.variant.itbisBps,
      quantity: finalsA[l.variant.sku]!,
      variableWeight: l.variant.variableWeight,
    })),
    { deliveryFee: a.deliveryFee },
  ).total;
  check(
    adminA.finalTotal === expectedDueA && expectedDueA !== a.total,
    `${a.code}: el total real (${formatDOP(expectedDueA)}) sale del peso pesado y difiere del estimado (${formatDOP(a.total)})`,
  );

  // ───── App del repartidor ─────
  if (process.env.E2E_SKIP_EXPORT !== '1') {
    log('Empaquetando la app del repartidor para web (la primera vez tarda más)…');
    await exportWeb();
  }
  assertBundleTargetsApi();
  const server = serveStatic(WEB_DIST, WEB_PORT);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox'],
  });

  /** Direcciones a las que la app intentó navegar (mapas, WhatsApp): se anotan y no se sale de la app. */
  const outbound: string[] = [];
  const outside: string[] = [];
  const newContext = async (geolocation?: typeof HERE) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      locale: 'es-DO',
      timezoneId: 'America/Santo_Domingo',
      ...(geolocation ? { geolocation } : {}),
    });
    // En web, abrir Waze o Google Maps cambia la página de lugar. La respuesta 204 hace que el
    // navegador se quede donde está, y la dirección que pidió la app queda anotada para revisarla.
    await ctx.route(
      (url) => url.hostname !== 'localhost',
      (route) => {
        if (route.request().isNavigationRequest()) {
          outbound.push(route.request().url());
          return route.fulfill({ status: 204 });
        }
        outside.push(route.request().url());
        return route.abort();
      },
    );
    return ctx;
  };

  const errors: string[] = [];
  const failures: string[] = [];
  const locationPosts: { latitude: number; longitude: number; orderId?: string }[] = [];
  let current: Page | null = null;
  try {
    // ───── Una persona que no es repartidor no ve entregas ─────
    const guestCtx = await newContext();
    const guest = await guestCtx.newPage();
    const guestErrors: string[] = [];
    const guestFailures: string[] = [];
    watch(guest, guestErrors, guestFailures);
    current = guest;
    await guest.goto(WEB);
    await seen(guest, 'Entra a JELLYFISH').waitFor({ timeout: 60_000 });
    await tid(guest, 'phone-input').fill(CUSTOMER);
    const guestSince = apiLog.text.length;
    await tid(guest, 'send-code').click();
    await seen(guest, 'Escribe tu código').waitFor();
    await tid(guest, 'otp-input').fill(await freshOtp(e164(CUSTOMER), guestSince));
    await seen(guest, 'Esta cuenta no es de repartidor').waitFor({ timeout: 15_000 });
    check(
      guestErrors.length === 0 && guestFailures.every((f) => f === 'GET /v1/driver/orders 403'),
      'un cliente que entra a la app del repartidor ve que su cuenta no es de repartidor',
    );
    await guestCtx.close();

    // ───── Acceso del repartidor por OTP ─────
    const ctx = await newContext(HERE);
    const page = await ctx.newPage();
    current = page;
    watch(page, errors, failures);
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/v1/driver/location')
        locationPosts.push(r.postDataJSON());
    });

    await page.goto(WEB);
    await seen(page, 'Entra a JELLYFISH').waitFor({ timeout: 60_000 });
    await tid(page, 'phone-input').fill(DRIVER);
    const since = apiLog.text.length;
    await tid(page, 'send-code').click();
    await seen(page, 'Escribe tu código').waitFor();
    await tid(page, 'otp-input').fill(await freshOtp(e164(DRIVER), since));
    await seen(page, 'Mis entregas').waitFor({ timeout: 15_000 });
    for (const o of [a, b, c]) await tid(page, `delivery-${o.code}`).waitFor();
    await tid(page, 'location-notice').waitFor();
    check(true, 'el repartidor entra con su código y ve sus 3 entregas');
    await shot(page, 'entregas');

    const cardA = await tid(page, `delivery-${a.code}`).innerText();
    check(
      cardA.includes(`Cobrar ${formatDOP(expectedDueA)} en efectivo`),
      `${a.code} en la lista pide cobrar el total real: ${formatDOP(expectedDueA)}`,
    );
    check(
      (await tid(page, `delivery-${b.code}`).innerText()).includes('Ya está pagado'),
      `${b.code} ya pagado dice que no se cobra nada`,
    );
    check(
      (await tid(page, `pin-flag-${a.code}`).getAttribute('aria-label')) ===
        'Esta entrega se cierra con el PIN del cliente',
      'cada entrega avisa que se cierra con el PIN del cliente',
    );
    check(
      (await tid(page, 'location-notice').innerText()).includes('Activa tu ubicación'),
      'sin permiso de ubicación, la lista invita a activarla',
    );

    // ───── Entrega fallida, saliendo con "Ahora no" a la ubicación ─────
    await tid(page, `delivery-${c.code}`).click();
    await seen(page, 'Dónde entregar').waitFor();
    await tid(page, 'act-out').click();
    await tid(page, 'location-sheet').waitFor();
    check(
      (await seen(page, 'Deja que tus clientes vean tu avance').count()) === 1,
      'la primera vez que sale, la app explica para qué usa la ubicación',
    );
    await shot(page, 'ubicacion-explicacion');
    await tid(page, 'location-skip').click();
    await tid(page, 'step-cash').waitFor({ timeout: 20_000 });
    check(
      (await adminOrder(c)).status === 'out_for_delivery',
      `con "Ahora no" ${c.code} sale a entregar igual (la ubicación nunca bloquea)`,
    );
    const noPosition = await trackingOf(c);
    check(
      !noPosition.available,
      `sin permiso no se manda ubicación y el cliente de ${c.code} no ve a nadie en el mapa`,
    );
    await tid(page, 'act-failed').click();
    await tid(page, 'fail-sheet').waitFor();
    await shot(page, 'no-pude-entregar');
    await btn(page, 'No había nadie').click();
    await seen(page, 'Mis entregas').waitFor();
    await tid(page, `delivery-${c.code}`).getByText('No se pudo entregar').waitFor();
    const failed = await adminOrder(c);
    check(
      failed.status === 'delivery_failed' &&
        failed.timeline.some((t) => t.note === 'No había nadie'),
      `${c.code} quedó como entrega fallida con su motivo y pendiente de reprogramar`,
    );

    // ───── Activar la ubicación desde el aviso de la lista ─────
    await tid(page, 'location-notice').click();
    await tid(page, 'location-sheet').waitFor();
    await ctx.grantPermissions(['geolocation']); // lo que haría la persona en el diálogo del sistema
    await tid(page, 'location-allow').click();
    await tid(page, 'location-sheet').waitFor({ state: 'detached' });
    await tid(page, 'location-notice').waitFor({ state: 'detached' });
    check(true, 'tras dar el permiso, el aviso de activar la ubicación desaparece');

    // ───── Entrega en efectivo con PIN ─────
    await tid(page, `delivery-${a.code}`).click();
    await seen(page, 'Dónde entregar').waitFor();
    check(
      (await tid(page, `delivery-${a.code}`).count()) === 0,
      'el detalle tapa la lista: el texto que se revisa es el del detalle',
    );
    const detail = await bodyText(page);
    for (const text of [
      CUSTOMER_NAME,
      `${a.address.line1}, ${a.address.sector}`,
      a.address.city,
      a.address.reference,
      `Nota del cliente: ${NOTE}`,
      'Listo para salir',
      'Esta entrega se cierra con el PIN de 4 dígitos del cliente',
    ]) {
      check(detail.includes(text), `el detalle de ${a.code} muestra "${text}"`);
    }
    for (const it of adminA.items) {
      const line = `${it.name}${it.variant ? ` · ${it.variant}` : ''}`;
      const weight = formatLb(it.finalQuantity ?? it.quantity);
      check(
        detail.includes(line) && detail.includes(weight),
        `"${line}" aparece con el peso real (${weight}), no con el pedido (${formatLb(it.quantity)})`,
      );
    }
    check(
      (await tid(page, 'amount-due').innerText()) === formatDOP(expectedDueA),
      `el detalle manda cobrar el total real con el peso pesado: ${formatDOP(expectedDueA)}`,
    );
    check(
      (await tid(page, 'step-cash').count()) === 0,
      'antes de salir no se muestran los pasos para cerrar la entrega',
    );
    await shot(page, 'detalle-efectivo');
    await tid(page, 'amount-due').scrollIntoViewIfNeeded();
    await shot(page, 'detalle-pago');

    // Ruta en el mapa: con coordenadas del cliente, Waze y Google Maps van a ese punto exacto.
    const destination = `${DESTINATION.latitude},${DESTINATION.longitude}`;
    const goTo = async (id: string, wanted: number) => {
      await tid(page, id).click();
      await waitUntil(`la app abre la ruta (${id})`, async () => outbound.length >= wanted);
      return new URL(outbound[wanted - 1]!);
    };
    const waze = await goTo('waze', 1);
    check(
      waze.origin === 'https://waze.com' &&
        waze.pathname === '/ul' &&
        waze.searchParams.get('ll') === destination &&
        waze.searchParams.get('navigate') === 'yes',
      `Waze abre la ruta a las coordenadas del cliente (${destination})`,
    );
    const gmaps = await goTo('gmaps', 2);
    check(
      gmaps.origin === 'https://www.google.com' &&
        gmaps.pathname === '/maps/dir/' &&
        gmaps.searchParams.get('destination') === destination &&
        gmaps.searchParams.get('travelmode') === 'driving',
      `Google Maps traza la ruta en auto hasta ${destination}`,
    );
    const wa = await goTo('whatsapp', 3);
    check(
      wa.href === `https://wa.me/${a.customer.phone.replace(/\D/g, '')}`,
      'WhatsApp abre el chat con el cliente',
    );
    check(
      page.url().startsWith(WEB),
      'abrir los mapas no saca a la persona de la app en la prueba',
    );

    // Sale a entregar: el permiso ya está dado, no vuelve a explicar.
    await tid(page, 'act-out').click();
    await tid(page, 'step-cash').waitFor({ timeout: 20_000 });
    check(
      (await tid(page, 'location-sheet').count()) === 0,
      'con el permiso dado, salir a entregar no vuelve a explicar la ubicación',
    );
    check(
      (await tid(page, 'step-cash').innerText()).includes(`Cobrar ${formatDOP(expectedDueA)}`) &&
        (await tid(page, 'act-collect').innerText()).includes(
          `Ya cobré ${formatDOP(expectedDueA)}`,
        ) &&
        (await tid(page, 'act-delivered').count()) === 0,
      'en camino: el primer paso es cobrar y todavía no hay botón de entregar',
    );
    await shot(page, 'en-camino-cobrar');

    // Con el pedido en camino, la ubicación llega al API y el cliente la ve.
    const first = await waitUntil(
      `la ubicación de ${a.code} llega al API`,
      async () => {
        const t = await trackingOf(a);
        return t.available ? t : false;
      },
      40_000,
    );
    check(
      near(first.latitude, HERE.latitude) && near(first.longitude, HERE.longitude),
      `el cliente de ${a.code} ve al repartidor en (${first.latitude}, ${first.longitude})`,
    );
    const post = need(locationPosts[0], 'el primer envío de ubicación');
    check(
      post.orderId === a.id && near(post.latitude, HERE.latitude),
      `la app manda su posición con el pedido en camino (${a.code})`,
    );
    const outsideRd = await callRaw(driver, '/v1/driver/location', 'POST', {
      latitude: 40.7128,
      longitude: -74.006,
    });
    check(outsideRd.status === 400, 'el API rechaza una posición fuera de República Dominicana');

    // Vuelve a la lista con la entrega en camino: el aviso confirma que se comparte la ubicación.
    await btn(page, 'Volver').click();
    await seen(page, 'Mis entregas').waitFor();
    await tid(page, 'location-active').waitFor({ timeout: 20_000 });
    check(
      (await tid(page, `delivery-${a.code}`).innerText()).includes('En camino'),
      'en la lista, la entrega sale como "En camino" y la app avisa que comparte la ubicación',
    );
    await shot(page, 'lista-en-camino');
    await tid(page, `delivery-${a.code}`).click();
    await tid(page, 'step-cash').waitFor();

    // El API revisa el efectivo ANTES que el PIN: sin cobrar no gasta intentos.
    const early = await callRaw(driver, `/v1/driver/orders/${a.id}/transition`, 'POST', {
      to: 'delivered',
      pin: await pinOf(a),
    });
    check(
      early.status === 409 && early.code === 'cash_not_collected',
      'sin cobrar el efectivo, el API no deja entregar',
    );
    check(
      (await adminOrder(a)).pinAttemptsLeft === 5,
      'ese intento sin cobrar no gasta intentos del PIN',
    );

    // Cobro en efectivo
    await tid(page, 'act-collect').click();
    await tid(page, 'act-collect').waitFor({ state: 'detached' });
    check(
      (await tid(page, 'act-delivered').innerText()).includes('Pedir PIN y entregar') &&
        (await tid(page, 'step-cash').innerText()).includes('Efectivo cobrado'),
      'cobrado el efectivo, el siguiente paso es pedirle el PIN al cliente',
    );
    const collected = (await adminOrder(a)).payments.find((p) => p.method === 'cash');
    check(
      collected?.status === 'captured' && collected.capturedAmount === expectedDueA,
      `el API registró el efectivo cobrado: ${formatDOP(expectedDueA)}`,
    );
    await shot(page, 'efectivo-cobrado');

    // PIN incorrecto dos veces (error y contador), luego el correcto
    const pinA = await pinOf(a);
    const wrongA = wrongPinOf(pinA);
    const tryPin = async (pin: string) => {
      await tid(page, 'pin-input').fill(pin);
      await tid(page, 'pin-confirm').click();
    };
    const pinError = async (text: string) =>
      waitUntil(
        `el mensaje "${text}"`,
        async () => (await tid(page, 'pin-error').innerText()) === `PIN incorrecto. ${text}`,
        10_000,
      );
    await tid(page, 'act-delivered').click();
    await tid(page, 'pin-sheet').waitFor();
    await shot(page, 'pin-vacio');
    check(
      await tid(page, 'pin-confirm').isDisabled(),
      'el botón de confirmar espera los 4 dígitos del PIN',
    );
    await tryPin(wrongA);
    await pinError(attemptsText(4));
    check(
      (await adminOrder(a)).pinAttemptsLeft === 4,
      'el PIN incorrecto gastó un intento: quedan 4',
    );
    await shot(page, 'pin-incorrecto');
    await tryPin(wrongA);
    await pinError(attemptsText(3));
    check((await adminOrder(a)).pinAttemptsLeft === 3, 'segundo PIN incorrecto: quedan 3');
    check(
      (await tid(page, 'step-pin').innerText()).includes(attemptsText(3)),
      'el paso del PIN recuerda cuántos intentos quedan',
    );

    // Mientras tanto el repartidor se movió: el cliente ve la posición nueva (la app la manda sola).
    await ctx.setGeolocation(MOVED);
    const movedAt = Date.now();
    await waitUntil(
      `la posición nueva de ${a.code} llega al cliente`,
      async () => {
        const t = await trackingOf(a);
        return (
          t.available && near(t.latitude, MOVED.latitude) && near(t.longitude, MOVED.longitude)
        );
      },
      45_000,
    );
    check(
      locationPosts.length >= 2,
      `el seguimiento del cliente se mueve con el repartidor hasta (${MOVED.latitude}, ${MOVED.longitude}) en ${Math.round((Date.now() - movedAt) / 1000)} s`,
    );

    await tryPin(pinA);
    await seen(page, 'Mis entregas').waitFor({ timeout: 20_000 });
    await tid(page, `delivery-${a.code}`).waitFor({ state: 'detached', timeout: 20_000 });
    const doneA = await adminOrder(a);
    check(
      doneA.status === 'delivered' &&
        doneA.pinVerifiedAt !== null &&
        doneA.pinOverrideReason === null &&
        doneA.timeline.filter(
          (t) => t.fromStatus === t.toStatus && t.note.startsWith('PIN incorrecto'),
        ).length === 2,
      `${a.code} quedó entregado con el PIN correcto y dos intentos fallidos en su historial`,
    );
    const mineA = await customerOrder(a);
    check(
      mineA.status === 'delivered' && mineA.deliveryPin === null,
      'entregado el pedido, el cliente ya no ve el PIN',
    );
    const after = await trackingOf(a);
    check(
      !after.available && after.reason === 'not_out_for_delivery',
      'entregado el pedido, el cliente deja de ver la ubicación del repartidor',
    );

    // Lo cobrado y entregado hoy queda en la caja y en el historial del administrador.
    const mine = need(
      (
        await call<{ phone: string; collected: number; balance: number }[]>(admin, '/v1/admin/cash')
      ).find((r) => r.phone === e164(DRIVER)),
      'fila del repartidor en el cuadre de caja',
    );
    check(
      mine.collected === expectedDueA && mine.balance === expectedDueA,
      `el cuadre de caja le carga ${formatDOP(expectedDueA)} al repartidor`,
    );
    const today = new Date().toISOString().slice(0, 10);
    check(
      doneA.deliveredAt?.slice(0, 10) === today &&
        (await call<OrderDTO[]>(admin, '/v1/admin/orders?status=delivered')).some(
          (o) => o.id === a.id && o.driverId === driverId,
        ),
      `${a.code} aparece entre las entregas de hoy del repartidor`,
    );
    await shot(page, 'lista-tras-entregar');

    // ───── Entrega ya pagada: 5 PIN incorrectos la bloquean ─────
    await page.emulateMedia({ colorScheme: 'light' }); // el repartidor también trabaja a pleno sol
    await tid(page, `delivery-${b.code}`).click();
    await seen(page, 'Ya está pagado: no cobres nada').waitFor();
    await tid(page, 'waze').click();
    await waitUntil(
      'la app abre la ruta de la entrega sin coordenadas',
      async () => outbound.length >= 4,
    );
    const wazeB = new URL(outbound[3]!);
    check(
      wazeB.searchParams.get('q') ===
        `${b.address.line1}, ${b.address.sector}, ${b.address.city}, República Dominicana` &&
        !wazeB.searchParams.has('ll'),
      'sin coordenadas, Waze busca la dirección escrita (calle, sector, ciudad y país)',
    );
    await tid(page, 'act-out').click();
    await tid(page, 'step-pin').waitFor({ timeout: 20_000 });
    check(
      (await tid(page, 'step-cash').count()) === 0 &&
        (await tid(page, 'act-delivered').innerText()).includes('Pedir PIN y entregar'),
      'una entrega ya pagada va directo al PIN, sin paso de cobro',
    );
    const pinB = await pinOf(b);
    const wrongB = wrongPinOf(pinB);
    await tid(page, 'act-delivered').click();
    await tid(page, 'pin-sheet').waitFor();
    for (const left of [4, 3, 2, 1]) {
      await tryPin(wrongB);
      await pinError(attemptsText(left));
    }
    check(
      (await seen(page, /Es tu último intento/).count()) === 1,
      'con un solo intento, la app avisa que es el último',
    );
    await shot(page, 'pin-ultimo-intento');
    await tryPin(wrongB);
    await tid(page, 'pin-locked').waitFor();
    const lockText = await tid(page, 'pin-error').innerText();
    check(
      /bloquead/.test(lockText) && /administrador/.test(lockText),
      `al quinto fallo el pedido queda bloqueado: "${lockText}"`,
    );
    await shot(page, 'pin-bloqueado');
    check(
      (await tid(page, 'pin-whatsapp-admin').count()) === 1 &&
        (await tid(page, 'pin-call-admin').count()) === 1,
      'el bloqueo ofrece llamar y escribir por WhatsApp al administrador',
    );
    check(
      (await tid(page, 'pin-input').count()) === 0,
      'bloqueado, la hoja ya no deja escribir el PIN',
    );
    await tid(page, 'pin-close').click();
    await tid(page, 'pin-locked-notice').waitFor();
    check(
      (await tid(page, 'step-pin').getAttribute('aria-label'))?.endsWith(', bloqueado') === true &&
        (await tid(page, 'act-delivered').count()) === 0,
      'el detalle muestra el paso del PIN bloqueado y no hay botón de entregar',
    );
    await tid(page, 'admin-whatsapp').click();
    await waitUntil('la app abre WhatsApp del administrador', async () => outbound.length >= 5);
    check(
      outbound[4] === `https://wa.me/${ADMIN_CONTACT}`,
      'el botón de WhatsApp abre el chat con el administrador',
    );
    await shot(page, 'detalle-bloqueado');

    const lockedB = await adminOrder(b);
    check(
      lockedB.status === 'out_for_delivery' && lockedB.pinAttemptsLeft === 0,
      `${b.code} sigue en camino, bloqueada (0 intentos)`,
    );
    const lockedTry = await callRaw(driver, `/v1/driver/orders/${b.id}/transition`, 'POST', {
      to: 'delivered',
      pin: pinB,
    });
    check(
      lockedTry.status === 423 && lockedTry.code === 'pin_locked',
      'bloqueada, ni el PIN correcto la entrega desde el repartidor (423)',
    );

    // El administrador la cierra sin PIN, con motivo; la app lo refleja sola.
    const tooShort = await callRaw(admin, `/v1/admin/orders/${b.id}/transition`, 'POST', {
      to: 'delivered',
      pinOverrideReason: 'corto',
    });
    check(
      tooShort.status === 400 && tooShort.code === 'pin_override_required',
      'el administrador no puede entregar sin PIN si no escribe un motivo de verdad',
    );
    const REASON = `El cliente confirmó por teléfono que recibió el pedido (${OVERRIDE_MARKER})`;
    await call(admin, `/v1/admin/orders/${b.id}/transition`, 'POST', {
      to: 'delivered',
      pinOverrideReason: REASON,
    });
    const doneB = await adminOrder(b);
    check(
      doneB.status === 'delivered' &&
        doneB.pinVerifiedAt === null &&
        doneB.pinOverrideReason === REASON &&
        doneB.timeline.some((t) => t.note.includes(REASON)),
      `${b.code} quedó entregada sin PIN con el motivo del administrador`,
    );
    const customerB = await customerOrder(b);
    check(
      customerB.pinOverrideReason === null && customerB.deliveryPin === null,
      'el cliente no ve el motivo interno ni el PIN',
    );
    // Privacidad: el motivo es de administración. El cliente dueño no lo lee en ninguna de sus pantallas.
    const listedB = (await call<OrderDTO[]>(customer, '/v1/orders')).find((o) => o.id === b.id);
    check(
      listedB !== undefined &&
        !exposesOverrideReason(customerB) &&
        !exposesOverrideReason(listedB) &&
        hasNeutralDeliveryNote(customerB) &&
        hasNeutralDeliveryNote(listedB),
      'el cliente no ve el motivo de "Entregar sin PIN" ni en GET /v1/orders/:id ni en GET /v1/orders: su historial dice "Entrega confirmada por administración"',
    );
    check(
      exposesOverrideReason(doneB) &&
        doneB.timeline.some((t) => t.note === `Entrega sin PIN autorizada: ${REASON}`),
      'el administrador sí ve el motivo, en el pedido y en su historial',
    );
    await seen(page, 'Esta entrega ya no está activa').waitFor({ timeout: 30_000 });
    check(true, 'la app del repartidor se entera sola de que la entrega ya no está activa');
    await shot(page, 'entrega-cerrada-por-admin');
    await seen(page, 'Ver mis entregas').click();
    await seen(page, 'Mis entregas').waitFor();
    await tid(page, `delivery-${b.code}`).waitFor({ state: 'detached' });

    // ───── Estado final ─────
    const mineLeft = await call<OrderDTO[]>(driver, '/v1/driver/orders');
    check(
      mineLeft.length === 1 && mineLeft[0]!.id === c.id,
      `al repartidor solo le queda ${c.code}, la entrega fallida por reprogramar`,
    );
    await tid(page, `delivery-${c.code}`).waitFor();
    check(
      (await tid(page, `delivery-${a.code}`).count()) === 0,
      'la lista ya no trae lo entregado',
    );

    // La entrega fallida se puede reintentar: vuelve a salir y pide cobrar.
    await tid(page, `delivery-${c.code}`).click();
    await tid(page, 'act-out').waitFor();
    check(
      (await tid(page, 'act-out').innerText()).includes('Reintentar entrega'),
      'la entrega fallida ofrece "Reintentar entrega"',
    );
    await tid(page, 'act-out').click();
    await tid(page, 'step-cash').waitFor({ timeout: 20_000 });
    check(
      (await adminOrder(c)).status === 'out_for_delivery',
      `${c.code} vuelve a salir a entregar y pide cobrar de nuevo`,
    );
    await btn(page, 'Volver').click();
    await seen(page, 'Mis entregas').waitFor();
    await shot(page, 'lista-final');

    // ───── Errores del navegador y respuestas del API ─────
    const want = [
      ...Array<string>(6).fill('POST /v1/driver/orders/:id/transition 409'), // 2 de A + 4 de B
      'POST /v1/driver/orders/:id/transition 423', // el quinto de B
    ];
    const got = [...failures].sort();
    check(
      JSON.stringify(got) === JSON.stringify([...want].sort()),
      `el API solo respondió con error en los PIN provocados a propósito${
        got.length === want.length ? '' : `: ${got.join(' | ')}`
      }`,
    );
    check(
      outside.length === 0,
      `la app no pidió nada fuera del API${outside.length ? `: ${outside[0]}` : ''}`,
    );
    check(
      errors.length === 0,
      `sin errores de consola/JS${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
    );
    console.log(`\n✔ Recorrido del repartidor completo. ${shots.length} capturas en ${OUT}\n`);
  } catch (e) {
    if (current) {
      await current.screenshot({ path: `${OUT}/FALLO.png` }).catch(() => {});
      console.error(`URL: ${current.url()}`);
      console.error(
        `Texto visible:\n${(
          await current
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 600)}`,
      );
    }
    if (errors.length)
      console.error(`Errores del navegador:\n- ${errors.slice(0, 5).join('\n- ')}`);
    if (failures.length) console.error(`Respuestas con error del API:\n- ${failures.join('\n- ')}`);
    // Del log del API solo lo que no es el registro de cada petición (nivel 30 de pino).
    const apiTail = apiLog.text
      .split('\n')
      .filter((l) => l.trim() && !l.includes('"level":30'))
      .slice(-15);
    if (apiTail.length) console.error(`API:\n${apiTail.join('\n')}`);
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
