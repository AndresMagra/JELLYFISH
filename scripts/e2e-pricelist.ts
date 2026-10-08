/**
 * Recorrido de "Lista de precios" del panel de administración en Chromium contra el API real
 * (modo demo, con el catálogo semilla), usando el Excel REAL del dueño.
 *
 *   npx tsx scripts/e2e-pricelist.ts
 *
 * Variables:
 *   PRICELIST_XLSX   Excel a usar (por defecto data/private/lista-de-precios-27-09-2026.xlsx)
 *   E2E_MARGIN       beneficio de PRUEBA en % (por defecto 11; no es el del negocio)
 *   E2E_OUT          carpeta de capturas (por defecto tmp/e2e-pricelist, ignorada por git; en otra no se borra nada)
 *   E2E_SKIP_BUILD=1 reutiliza apps/admin/dist
 *
 * Los archivos del dueño son internos: este script solo los lee, no imprime sus cifras y las
 * variantes que genera para probar viven en la carpeta de capturas (ignorada) y se borran al final.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type CatalogItem,
  type Cell,
  catalogToCsv,
  consumerPrice,
  normalizeHeader,
  parseCatalogExport,
  parsePercentToBps,
  parsePriceListRows,
  type PriceListMeta,
} from '@jellyfish/catalog';
import { type AdminVariantDTO, formatDOP } from '@jellyfish/shared';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { type Page, chromium } from 'playwright-core';
import { readSheet } from 'read-excel-file/node';
import {
  CHROME,
  ISOLATED_API_ENV,
  assertPortFree,
  check,
  clearOwnShots,
  log,
  otpFor,
  root,
  run,
  serveStatic,
  start,
  stopAll,
  waitFor,
} from './e2e-lib';

const DEFAULT_OUT = `${root}/tmp/e2e-pricelist`;
const OUT = resolve(process.env.E2E_OUT ?? DEFAULT_OUT);
const API_PORT = 3961;
const WEB_PORT = 8061;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const ADMIN_PHONE = '809-555-0100';
const XLSX = resolve(
  process.env.PRICELIST_XLSX ?? `${root}/data/private/lista-de-precios-27-09-2026.xlsx`,
);
const MARGIN = process.env.E2E_MARGIN ?? '11';
const MARGIN_BPS = parsePercentToBps(MARGIN);
if (MARGIN_BPS === null) throw new Error(`E2E_MARGIN inválido: ${MARGIN}`);
const RULE = { marginBps: MARGIN_BPS, itbisMode: 'sobre' } as const;
const LIST_DATE = /\d{2}-\d{2}-\d{4}/.exec(XLSX)?.[0] ?? null;
if (!existsSync(XLSX)) {
  console.error(`No encuentro el Excel del dueño en ${XLSX} (PRICELIST_XLSX).`);
  process.exit(2);
}
const meta = JSON.parse(
  readFileSync(`${root}/data/catalog/lista-proveedor.meta.json`, 'utf8'),
) as PriceListMeta[];
const skuOfName = new Map(meta.map((m) => [normalizeHeader(m.lista), m.sku]));

const shots: string[] = [];
async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  shots.push(name);
  log(`captura ${name}.png`);
}

// ───────────── API: preparar y comprobar el estado del servidor ─────────────

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

async function adminCatalog(token: string): Promise<AdminVariantDTO[]> {
  const res = await fetch(`${API}/v1/admin/catalog`, { headers: auth(token) });
  return (await res.json()) as AdminVariantDTO[];
}

async function exportedItems(token: string): Promise<CatalogItem[]> {
  const res = await fetch(`${API}/v1/admin/catalog/export`, { headers: auth(token) });
  const parsed = parseCatalogExport(await res.text());
  if (parsed.errors.length > 0) throw new Error('El export del servidor no se pudo leer');
  return parsed.items;
}

async function setPhoto(token: string, id: string, photo: string) {
  const res = await fetch(`${API}/v1/admin/variants/${id}`, {
    method: 'PATCH',
    headers: json(token),
    body: JSON.stringify({ photo }),
  });
  if (!res.ok) throw new Error(`No se pudo poner la foto de prueba (${res.status})`);
}

async function importCsv(token: string, csv: string) {
  const res = await fetch(`${API}/v1/admin/catalog/import?dryRun=0`, {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'text/csv' },
    body: csv,
  });
  const body = (await res.json()) as { ok: boolean; errors: unknown[] };
  if (!body.ok) throw new Error(`No se pudo preparar el catálogo: ${JSON.stringify(body.errors)}`);
}

/** Lo único que una actualización de precios tiene permiso de cambiar. */
const PRICE_FIELDS = new Set(['price', 'priceSource', 'priceNote', 'cost', 'itbisBps']);
const withoutPriceFields = <T extends object>(o: T) =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([k]) => !PRICE_FIELDS.has(k) && k !== 'updatedAt' && k !== 'blockers',
    ),
  );

// ───────────── Excel: leer el real y fabricar variantes de prueba ─────────────

async function readRows(file: string) {
  const parsed = parsePriceListRows((await readSheet(file)) as unknown as Cell[][]);
  if (parsed.errors.length > 0) throw new Error('El Excel real tiene errores de lectura');
  return parsed.rows;
}

/** Copia del Excel con productos renombrados y precios multiplicados (solo para la prueba). */
function perturb(
  src: string,
  dst: string,
  edits: { rename?: [string, string][]; scale?: [number, number][] },
) {
  const zip = unzipSync(new Uint8Array(readFileSync(src)));
  let strings = strFromU8(zip['xl/sharedStrings.xml']!);
  for (const [from, to] of edits.rename ?? []) {
    if (!strings.includes(`>${from}<`)) throw new Error(`No encuentro "${from}" en el Excel`);
    strings = strings.replace(`>${from}<`, `>${to}<`);
  }
  zip['xl/sharedStrings.xml'] = strToU8(strings);
  let sheet = strFromU8(zip['xl/worksheets/sheet1.xml']!);
  for (const [line, factor] of edits.scale ?? []) {
    const re = new RegExp(`(<c r="D${line}"[^>]*><v>)([^<]+)(</v>)`);
    if (!re.test(sheet)) throw new Error(`No encuentro el precio de la fila ${line}`);
    sheet = sheet.replace(re, (_m, a: string, v: string, b: string) => {
      return `${a}${(Math.round(Number(v) * factor * 100) / 100).toString()}${b}`;
    });
  }
  zip['xl/worksheets/sheet1.xml'] = strToU8(sheet);
  writeFileSync(dst, zipSync(zip));
}

// ───────────── Recorrido ─────────────

async function main() {
  // Un API huérfano en el mismo puerto contaminaría la prueba sin avisar.
  await assertPortFree(API_PORT);
  await assertPortFree(WEB_PORT);
  mkdirSync(OUT, { recursive: true });
  // Las capturas se numeran en orden: las de una corrida anterior solo confundirían.
  clearOwnShots(OUT, DEFAULT_OUT);
  const rows = await readRows(XLSX);
  check(rows.length > 0, `el Excel del dueño se lee en Node (${rows.length} productos)`);
  const skuOf = (name: string) => skuOfName.get(normalizeHeader(name))!;
  check(
    rows.every((r) => skuOf(r.name)),
    'todos los productos del Excel tienen ficha en lista-proveedor.meta.json',
  );
  const price = (r: (typeof rows)[number]) => consumerPrice(r.listPrice, r.taxed, RULE);

  log('Iniciando API en modo demo con el catálogo semilla…');
  start(
    'npx',
    ['tsx', 'apps/api/src/server.ts'],
    {
      ...ISOLATED_API_ENV,
      JELLYFISH_DEMO: '1',
      JELLYFISH_SEED: '1',
      PORT: String(API_PORT),
      BOOTSTRAP_ADMIN_PHONE: ADMIN_PHONE,
      PUBLIC_API_URL: API,
    },
    root,
    true,
  );
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
  const tmpFiles: string[] = [];

  try {
    // ───── Panel ─────
    const ctx = await browser.newContext({
      viewport: { width: 1360, height: 900 },
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

    await page.goto(WEB);
    await page.getByTestId('login-phone').fill(ADMIN_PHONE);
    await page.getByTestId('login-send').click();
    await page.getByTestId('login-code').fill(await otpFor(`+1${ADMIN_PHONE.replace(/\D/g, '')}`));
    await page.getByTestId('login-verify').click();
    await page.getByRole('heading', { name: 'Resumen' }).waitFor({ timeout: 15_000 });
    const token = (await page.evaluate(() => localStorage.getItem('jellyfish.admin.token')))!;

    // ───── Preparar un catálogo "con vida": fotos, existencias, textos editados y un viejo ─────
    const skuA = skuOf(rows[1]!.name);
    const skuB = skuOf(rows[Math.min(20, rows.length - 1)]!.name);
    const skuC = skuOf(rows[rows.length - 1]!.name);
    let variants = await adminCatalog(token);
    const idOf = (sku: string) => variants.find((v) => v.sku === sku)!.id;
    for (const [sku, foto] of [
      [skuA, '/photos/e2e-a.jpg'],
      [skuB, '/photos/e2e-b.jpg'],
    ] as const) {
      await setPhoto(token, idOf(sku), foto);
    }
    await fetch(`${API}/v1/admin/inventory/adjust`, {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ variantId: idOf(skuA), type: 'receive', delta: 3750, note: 'e2e' }),
    });
    const base = await exportedItems(token);
    const groupA = base.find((i) => i.sku === skuA)!.group;
    const edited = base.map((i) =>
      i.group === groupA
        ? {
            ...i,
            description: 'DESCRIPCIÓN EDITADA POR EL DUEÑO (e2e)',
            cookingTip: 'CONSEJO PROPIO (e2e)',
            synonyms: [...i.synonyms, 'sinonimo-e2e'],
          }
        : i,
    );
    const viejo: CatalogItem = {
      ...base[0]!,
      sku: 'E2E-VIEJO',
      group: 'e2e-viejo',
      name: 'Producto viejo e2e',
      variant: '',
      price: 5_000,
      priceSource: 'usuario',
      priceNote: 'e2e',
      cost: null,
      stock: 1_000,
      itbisBps: 1800,
      photo: '/photos/e2e-viejo.jpg',
      synonyms: ['antiguo'],
      description: 'Ya no lo vende el proveedor',
      active: true,
    };
    await importCsv(token, catalogToCsv([...edited, viejo]));
    variants = await adminCatalog(token);
    check(
      variants.find((v) => v.sku === skuA)!.photo === '/photos/e2e-a.jpg' &&
        variants.find((v) => v.sku === skuA)!.onHand >= 3750 &&
        variants.some((v) => v.sku === 'E2E-VIEJO'),
      'catálogo de prueba listo: fotos, existencias, textos editados y un artículo que el listado no trae',
    );

    await page.locator('.nav').getByRole('link', { name: 'Lista de precios' }).click();
    await page.getByRole('heading', { name: 'Lista de precios' }).waitFor();
    check(
      (await page.getByTestId('pl-margin').inputValue()) === '',
      'el beneficio empieza vacío (no hay un valor por defecto)',
    );
    check(
      !(await page.getByTestId('pl-itbis-included').isChecked()),
      '"Mi listado ya incluye el ITBIS" empieza apagada',
    );
    check(await page.getByTestId('pl-empty').isVisible(), 'sin archivo se explica qué verás');
    check(
      (await page.getByTestId('pl-formula').innerText()).includes(
        'solo en los productos marcados con asterisco',
      ),
      'una línea explica cómo se calcula el precio de venta',
    );
    await shot(page, '01-vacio');

    // ───── Archivos que no sirven ─────
    await page.getByTestId('pl-file').setInputFiles({
      name: 'lista.xlsx',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('esto no es un excel'),
    });
    await page
      .getByTestId('pl-read-error')
      .getByText(/No pude leer ese archivo/)
      .waitFor();
    await page
      .getByTestId('pl-file')
      .setInputFiles({ name: 'lista.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b') });
    await page
      .getByTestId('pl-read-error')
      .getByText(/debe ser un archivo de Excel/)
      .waitFor();
    check(true, 'un archivo dañado o que no es .xlsx se rechaza con un mensaje claro (sin alert)');

    // ───── El Excel real ─────
    await page.getByTestId('pl-file').setInputFiles(XLSX);
    await page.getByTestId('pl-need-margin').waitFor();
    if (LIST_DATE) {
      check(
        (await page.getByTestId('pl-date').inputValue()) === LIST_DATE,
        'la fecha del listado se toma del nombre del archivo',
      );
    }
    check(
      (await page.getByTestId('pl-review-btn').count()) === 0,
      'sin beneficio no se puede revisar ni aplicar',
    );
    await page.getByTestId('pl-margin').fill('abc');
    await page.getByText('Escribe un porcentaje entre 0 y 1000').waitFor();
    await page.getByTestId('pl-margin').fill(MARGIN);
    await page.getByTestId('pl-table').waitFor();

    const rowCount = await page.locator('[data-testid^="pl-row-"]').count();
    check(
      rowCount === rows.length,
      `la vista previa muestra los ${rows.length} productos del Excel`,
    );
    const total = (id: string) =>
      page!.getByTestId(`pl-total-${id}`).locator('.pl-total-value').innerText().then(Number);
    check((await total('rows')) === rows.length, 'el total "En el listado" coincide');
    check(
      (await total('nuevo')) === 0 && (await total('sinFicha')) === 0,
      'ninguno es nuevo: todos están en el catálogo',
    );
    check(
      (await total('missing')) === 1,
      'el artículo viejo del catálogo se lista como "Ya no viene"',
    );

    let ok = 0;
    for (const r of rows) {
      const text = await page.getByTestId(`pl-row-${skuOf(r.name)}`).innerText();
      if (
        text.includes(formatDOP(price(r))) &&
        text.includes(formatDOP(r.listPrice)) &&
        text.includes(r.taxed ? 'Sí' : 'No')
      ) {
        ok++;
      }
    }
    check(
      ok === rows.length,
      `precio de venta, precio del listado e ITBIS correctos en las ${ok} filas`,
    );
    const first = rows.find((r) => r.taxed)!;
    await page.getByTestId('pl-itbis-included').check();
    await page
      .getByTestId(`pl-row-${skuOf(first.name)}`)
      .getByText(
        formatDOP(consumerPrice(first.listPrice, true, { ...RULE, itbisMode: 'incluido' })),
      )
      .first()
      .waitFor();
    await page.getByTestId('pl-itbis-included').uncheck();
    await page
      .getByTestId(`pl-row-${skuOf(first.name)}`)
      .getByText(formatDOP(price(first)))
      .first()
      .waitFor();
    check(
      true,
      '"Mi listado ya incluye el ITBIS" quita el ITBIS que se suma encima de los asteriscos',
    );
    await shot(page, '02-vista-previa', true);

    // ───── Revisar (prueba en seco) ─────
    const snapshot = JSON.stringify(await adminCatalog(token));
    await page.getByTestId('pl-review-btn').click();
    await page
      .getByTestId('pl-review')
      .getByText(/Revisión correcta/)
      .waitFor();
    check(
      JSON.stringify(await adminCatalog(token)) === snapshot,
      '"Revisar" no cambia absolutamente nada en el servidor',
    );
    check(
      (await page.evaluate(() => localStorage.getItem('jellyfish.admin.pricelist.margin'))) ===
        MARGIN,
      'el beneficio usado queda recordado en el navegador',
    );
    await shot(page, '03-revisado');

    // ───── Alguien edita una foto mientras se revisa: no se aplica nada (no se pisaría) ─────
    await setPhoto(token, idOf(skuB), '/photos/e2e-b2.jpg');
    const before = await adminCatalog(token);
    await page.getByTestId('pl-apply').click();
    await page.getByTestId('pl-changed').waitFor();
    check(
      JSON.stringify(await adminCatalog(token)) === JSON.stringify(before),
      'si el catálogo cambió mientras revisabas, "Aplicar" no guarda nada y pide revisar de nuevo',
    );
    check(
      await page.getByTestId('pl-apply').isDisabled(),
      '"Aplicar" queda apagado hasta revisar otra vez',
    );

    // ───── Revisar de nuevo y aplicar ─────
    await page.getByTestId('pl-review-btn').click();
    await page
      .getByTestId('pl-review')
      .getByText(/Revisión correcta/)
      .waitFor();
    await page.getByTestId('pl-apply').click();
    await page
      .getByTestId('pl-done')
      .getByText(/Precios aplicados/)
      .waitFor();
    await shot(page, '04-aplicado');

    // ───── Qué quedó en el servidor ─────
    const after = await adminCatalog(token);
    let priced = 0;
    for (const r of rows) {
      const v = after.find((x) => x.sku === skuOf(r.name))!;
      if (
        v.price === price(r) &&
        v.cost === r.listPrice &&
        v.itbisBps === (r.taxed ? 1800 : 0) &&
        v.priceSource === 'usuario' &&
        (LIST_DATE === null || v.priceNote.includes(LIST_DATE))
      ) {
        priced++;
      }
    }
    check(
      priced === rows.length,
      `en el servidor: precio, costo, ITBIS y nota correctos en ${priced}/${rows.length} productos`,
    );

    let kept = 0;
    for (const b of before) {
      const a = after.find((x) => x.sku === b.sku)!;
      if (JSON.stringify(withoutPriceFields(a)) === JSON.stringify(withoutPriceFields(b))) kept++;
    }
    check(
      kept === before.length && after.length === before.length,
      `fotos, existencias, activo y demás intactos en los ${kept} artículos (no se creó ni borró ninguno)`,
    );
    check(
      after.find((v) => v.sku === skuB)!.photo === '/photos/e2e-b2.jpg',
      'la foto cambiada durante la revisión es la que quedó (no se revirtió a la vieja)',
    );
    const vA = after.find((v) => v.sku === skuA)!;
    check(
      vA.photo === '/photos/e2e-a.jpg' && vA.onHand === before.find((v) => v.sku === skuA)!.onHand,
      'la foto y la existencia que ya tenía un producto siguen ahí',
    );
    const exportedAfter = await exportedItems(token);
    const itemA = exportedAfter.find((i) => i.sku === skuA)!;
    check(
      itemA.description === 'DESCRIPCIÓN EDITADA POR EL DUEÑO (e2e)' &&
        itemA.cookingTip === 'CONSEJO PROPIO (e2e)' &&
        itemA.synonyms.includes('sinonimo-e2e'),
      'la descripción, el consejo y los sinónimos editados se conservan',
    );
    const viejoAfter = exportedAfter.find((i) => i.sku === 'E2E-VIEJO')!;
    check(
      viejoAfter.active && viejoAfter.price === 5_000 && viejoAfter.stock === 1_000,
      'lo que el listado no trae se queda tal cual (no se borra ni se desactiva sin pedirlo)',
    );

    // ───── El mismo listado otra vez: todo igual ─────
    await page.reload();
    await page.getByRole('heading', { name: 'Lista de precios' }).waitFor();
    check(
      (await page.getByTestId('pl-margin').inputValue()) === MARGIN,
      'al volver, el beneficio recordado ya está puesto',
    );
    await page.getByTestId('pl-file').setInputFiles(XLSX);
    await page.getByTestId('pl-table').waitFor();
    check(
      (await total('igual')) === rows.length && (await total('cambia')) === 0,
      'subir el mismo listado después de aplicarlo: todo "Igual", nada que cambiar',
    );
    await shot(page, '05-todo-igual');

    // ───── Un listado nuevo: precio que se dispara, producto renombrado, otro que baja ─────
    const bigUp = rows[2]!;
    const bigDown = rows[3]!;
    const renamed = rows.find((r) => skuOf(r.name) === skuC)!;
    const variant = `${OUT}/variante-nueva.xlsx`;
    tmpFiles.push(variant);
    perturb(XLSX, variant, {
      rename: [[renamed.name, `${renamed.name} XL`]],
      scale: [
        [bigUp.line, 1.4],
        [bigDown.line, 0.6],
      ],
    });
    await page.getByTestId('pl-file').setInputFiles(variant);
    // La tabla del listado anterior sigue en pantalla hasta que se lee el nuevo archivo.
    await page
      .locator('[data-testid="pl-total-sinFicha"] .pl-total-value', { hasText: /^1$/ })
      .waitFor();
    const rowUp = page.getByTestId(`pl-row-${skuOf(bigUp.name)}`);
    const rowDown = page.getByTestId(`pl-row-${skuOf(bigDown.name)}`);
    check(
      ((await rowUp.getAttribute('class')) ?? '').includes('pl-big') &&
        (await rowUp.innerText()).includes('+') &&
        (await rowUp.innerText()).includes('Cambio grande'),
      'un producto que sube 40 % se resalta como cambio grande, con su +%',
    );
    check(
      ((await rowDown.getAttribute('class')) ?? '').includes('pl-big') &&
        (await rowDown.innerText()).includes('−'),
      'uno que baja 40 % también se resalta, con su −%',
    );
    check((await total('grandes')) === 2, 'el total cuenta 2 cambios grandes');
    check((await total('sinFicha')) === 1, 'el producto renombrado aparece como "Sin ficha"');
    check((await total('missing')) === 2, 'el renombrado y el viejo cuentan como "Ya no vienen"');
    await page.getByTestId('pl-filter-sin-ficha').click();
    check(
      (await page.locator('[data-testid^="pl-row-"]').count()) === 1,
      'el filtro "Sin ficha" deja solo ese producto',
    );
    await page.getByTestId('pl-filter-todos').click();
    await shot(page, '06-cambios-grandes', true);

    await page.getByTestId('pl-deactivate').check();
    await page.getByTestId('pl-review-btn').click();
    await page
      .getByTestId('pl-review')
      .getByText(/Revisión correcta/)
      .waitFor();
    await page.getByTestId('pl-apply').click();
    await page.getByTestId('pl-done').waitFor();
    check(
      (await page.getByTestId('pl-done').innerText()).includes('existencia 0'),
      'se avisa que los productos nuevos entran con existencia 0',
    );
    const after2 = await adminCatalog(token);
    const nuevoSku = `JF-NEW-${normalizeHeader(`${renamed.name} XL`).replaceAll('_', '-').toUpperCase().slice(0, 24)}`;
    const nuevo = after2.find((v) => v.sku === nuevoSku);
    check(
      nuevo !== undefined && nuevo.active && nuevo.onHand === 0 && nuevo.price === price(renamed),
      'el producto sin ficha se creó (activo, existencia 0, con su precio)',
    );
    const oldC = after2.find((v) => v.sku === skuC)!;
    const viejo2 = after2.find((v) => v.sku === 'E2E-VIEJO')!;
    check(
      !oldC.active && !viejo2.active && oldC.onHand === after.find((v) => v.sku === skuC)!.onHand,
      'con la casilla marcada, lo que ya no viene quedó desactivado (sin borrar ni perder su existencia)',
    );
    const up2 = after2.find((v) => v.sku === skuOf(bigUp.name))!;
    const upNew = (await readRows(variant)).find((r) => skuOf(r.name) === up2.sku)!;
    check(
      up2.price === price(upNew) &&
        up2.price !== price(bigUp) &&
        up2.photo === after.find((v) => v.sku === up2.sku)!.photo,
      'el producto que subió quedó con el precio nuevo y conserva su foto',
    );
    const shop = (await (await fetch(`${API}/v1/products?q=viejo`)).json()) as {
      items: { group: string }[];
    };
    check(
      shop.items.every((p) => p.group !== 'e2e-viejo'),
      'el producto desactivado deja de mostrarse a los clientes',
    );
    await shot(page, '07-segundo-listado-aplicado');

    // ───── Móvil, modo claro ─────
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const mp = await mobile.newPage();
    await mp.addInitScript(
      (t) => localStorage.setItem('jellyfish.admin.token', t),
      (await page.evaluate(() => localStorage.getItem('jellyfish.admin.token'))) ?? '',
    );
    await mp.goto(`${WEB}/lista-de-precios`);
    await mp.getByRole('heading', { name: 'Lista de precios' }).waitFor();
    await mp.getByTestId('pl-file').setInputFiles(XLSX);
    await mp.getByTestId('pl-margin').fill(MARGIN);
    await mp.getByTestId('pl-table').waitFor();
    const overflow = await mp.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const offenders =
      overflow > 1
        ? await mp.evaluate(() =>
            [...document.querySelectorAll('.main *')]
              .filter(
                (el) =>
                  el.getBoundingClientRect().right > window.innerWidth + 1 &&
                  !el.closest('.table-wrap'),
              )
              .slice(-10)
              .map(
                (el) =>
                  `${el.tagName.toLowerCase()}.${el.className}[${Math.round(el.getBoundingClientRect().width)}px]`,
              ),
          )
        : [];
    check(
      overflow <= 1,
      `en el celular la página no se desborda a los lados (la tabla se desliza sola)${offenders.length ? `: ${offenders.join(' | ')}` : ''}`,
    );
    await shot(mp, '08-movil', true);

    check(
      errors.length === 0,
      `sin errores de consola/JS en el navegador${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`,
    );
    console.log(
      `\n✔ Recorrido de "Lista de precios" completo. ${shots.length} capturas en ${OUT}\n`,
    );
  } catch (e) {
    if (page) {
      await page.screenshot({ path: `${OUT}/FALLO.png`, fullPage: true }).catch(() => {});
      console.error(`URL: ${page.url()}`);
      console.error(
        `Texto visible:\n${(
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 900)}`,
      );
    }
    if (errors.length)
      console.error(`Errores del navegador:\n- ${errors.slice(0, 5).join('\n- ')}`);
    throw e;
  } finally {
    for (const f of tmpFiles) rmSync(f, { force: true });
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
