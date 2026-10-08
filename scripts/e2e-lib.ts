/** Utilidades comunes de los recorridos e2e: procesos, servidor estático, esperas y OTP. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { extname, join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const CHROME =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** `group`: el proceso se lanzó aparte (`detached`) y se cierra junto con todo lo que arrancó. */
const children: { child: ChildProcess; group: boolean }[] = [];
export const apiLog = { text: '' };

/**
 * Variables de la shell que cambiarían la base, el código de acceso, el reporte de errores o las fotos
 * del API de prueba. Cada recorrido las deja sin definir al arrancarlo: con un `DATABASE_URL` exportado
 * el API correría contra otra base y el recorrido crearía cupones y pedidos ahí.
 */
export const ISOLATED_API_ENV = {
  DATABASE_URL: undefined,
  TEST_DATABASE_URL: undefined,
  PGLITE_DIR: undefined,
  DEMO_OTP_CODE: undefined,
  SENTRY_DSN: undefined,
  PHOTOS_DIR: undefined,
  // Pagos y avisos: con credenciales de AZUL en la shell, la tarjeta iría a la pasarela real.
  AZUL_MERCHANT_ID: undefined,
  AZUL_MERCHANT_NAME: undefined,
  AZUL_MERCHANT_TYPE: undefined,
  AZUL_AUTH_KEY: undefined,
  AZUL_TERMINAL_ID: undefined,
  AZUL_ENV: undefined,
  AZUL_HASH_ENCODING: undefined,
  TRANSFER_BANK: undefined,
  TRANSFER_ACCOUNT_TYPE: undefined,
  TRANSFER_ACCOUNT_NUMBER: undefined,
  TRANSFER_HOLDER: undefined,
  TRANSFER_RNC: undefined,
  EXPO_ACCESS_TOKEN: undefined,
  PUSH_ENABLED: undefined,
} satisfies Record<string, undefined>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (m: string) => console.log(`• ${m}`);

export function start(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = root,
  capture = false,
) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push({ child, group: true });
  const sink = (d: Buffer) => {
    if (capture) apiLog.text += d.toString();
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return child;
}

/** Anota un proceso que no se lanzó con `start` (el empaquetado de Expo) para que `stopAll` también lo cierre. */
export function track(child: ChildProcess, group = false) {
  children.push({ child, group });
  return child;
}

export function stopAll() {
  for (const { child, group } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (group && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
}

// Ctrl+C o un kill al recorrido no deben dejar el API (arrancado aparte, `detached`) corriendo.
let stopping = false;
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    stopAll();
    // Un instante para que Playwright cierre su navegador antes de salir.
    setTimeout(() => process.exit(code), 400);
  });
}
// Último recurso si el proceso muere por otra vía (una excepción fuera de main).
process.on('exit', stopAll);

/** ¿Alguien contesta en ese puerto? (un API anterior; algunos sistemas dejan abrir el puerto aunque esté ocupado). */
function answers(port: number, host: string): Promise<boolean> {
  return new Promise((ok) => {
    const socket = connect({ port, host, timeout: 1000 });
    const done = (answered: boolean) => {
      socket.destroy();
      ok(answered);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** ¿El sistema no deja abrir el puerto? */
function cannotBind(port: number): Promise<boolean> {
  return new Promise((ok, fail) => {
    const probe = createNetServer();
    probe.once('error', (e: NodeJS.ErrnoException) =>
      e.code === 'EADDRINUSE' ? ok(true) : fail(e),
    );
    probe.listen(port, () => probe.close(() => ok(false)));
  });
}

/** Falla antes de arrancar nada si otro proceso (un API que quedó abierto, otro recorrido) ya usa el puerto. */
export async function assertPortFree(port: number): Promise<void> {
  const taken = await Promise.all([
    answers(port, '127.0.0.1'),
    answers(port, '::1'),
    cannotBind(port),
  ]);
  if (taken.some(Boolean)) {
    throw new Error(
      `El puerto ${port} ya está en uso: cierra el proceso anterior (un API que quedó abierto u otro recorrido).`,
    );
  }
}

/** Nombre de las capturas numeradas de un recorrido (01-inicio.png) y de su captura de fallo. */
export const OWN_SHOT = /^(?:\d\d-[\w-]+|FALLO)\.png$/;

/**
 * Quita las capturas de una corrida anterior para que no se mezclen con las nuevas. Solo en la carpeta
 * por defecto del recorrido (bajo tmp/) y solo lo que lleva el nombre de sus capturas: con un
 * `E2E_OUT` dado por la persona no se borra nada, porque puede ser una carpeta compartida.
 */
export function clearOwnShots(outDir: string, defaultDir: string) {
  if (resolve(outDir) !== resolve(defaultDir)) return;
  for (const f of readdirSync(outDir)) if (OWN_SHOT.test(f)) rmSync(join(outDir, f));
}

export async function waitFor(url: string, tries = 90) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* aún no */
    }
    await sleep(1000);
  }
  throw new Error(`No respondió: ${url}`);
}

export function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<void> {
  return new Promise((ok, fail) => {
    const p = track(spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' }));
    p.on('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} falló (${code})`)),
    );
  });
}

/** Servidor estático de una app de una sola página (cualquier ruta devuelve index.html). */
export function serveStatic(dir: string, port: number) {
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
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  server.listen(port);
  return server;
}

export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`✖ ${message}`);
  log(`✔ ${message}`);
}

/** Lee el código OTP que el API (modo desarrollo) imprime en su consola. */
export async function otpFor(phoneE164: string): Promise<string> {
  const re = new RegExp(`Código para ${phoneE164.replace('+', '\\+')}: (\\d{6})`, 'g');
  for (let i = 0; i < 40; i++) {
    const m = [...apiLog.text.matchAll(re)].pop();
    if (m) return m[1]!;
    await sleep(300);
  }
  throw new Error(`No apareció el código OTP de ${phoneE164} en el log del API`);
}

/** Inicia sesión por la API (sin interfaz) y devuelve el token. Para preparar datos de prueba. */
export async function apiLogin(api: string, phone: string): Promise<string> {
  const e164 = `+1${phone.replace(/\D/g, '').slice(-10)}`;
  await fetch(`${api}/v1/auth/otp/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: e164 }),
  });
  const code = await otpFor(e164);
  const res = await fetch(`${api}/v1/auth/otp/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: e164, code }),
  });
  return ((await res.json()) as { token: string }).token;
}

// ───────────── Fugas en la bitácora ─────────────

const SECRET_KEYS =
  /^(code|otp|pin|token|password|secret|authorization|cookie|apikey|deliverypin)$/;
const FULL_PHONE = /(?:\+?1)?8[024]9\d{7}\b/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Claves y valores que jamás deben estar en un cuerpo guardado; `allowKeys` = claves públicas en esa ruta. */
export function leaksIn(
  value: unknown,
  secrets: ReadonlySet<string>,
  path = '$',
  allowKeys: ReadonlySet<string> = new Set(),
): string[] {
  if (typeof value === 'string') {
    if (secrets.has(value) || /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(value) || FULL_PHONE.test(value))
      return [`${path} = ${value.slice(0, 12)}…`];
    return [];
  }
  if (Array.isArray(value))
    return value.flatMap((v, i) => leaksIn(v, secrets, `${path}[${i}]`, allowKeys));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      return [
        ...(SECRET_KEYS.test(key) && !allowKeys.has(key) ? [`${path}.${k}`] : []),
        ...leaksIn(v, secrets, `${path}.${k}`, allowKeys),
      ];
    });
  }
  return [];
}

/** ¿El secreto aparece suelto en el texto? Los ids no cuentan: 4 dígitos caben por azar en un UUID. */
export function mentions(text: string, secret: string): boolean {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(text.replace(UUID, ' '));
}

/**
 * Dónde se filtra algo en una entrada de la bitácora: en el cuerpo guardado (claves y valores) o en
 * sus textos (resumen, ruta, id de la entidad). `textSecrets` son los secretos que se buscan dentro de
 * los textos; por defecto, todos. Un PIN de 4 dígitos puede coincidir con una cantidad del resumen
 * ("cantidad 4000"), así que quien lo conoce lo deja fuera de ese conjunto.
 */
export function leaksInEntry(
  entry: { action: string; summary: string; path: string; entityId: string; payload: unknown },
  secrets: ReadonlySet<string>,
  textSecrets: ReadonlySet<string> = secrets,
  allowKeys: ReadonlySet<string> = new Set(),
): string[] {
  const texts = { summary: entry.summary, path: entry.path, entityId: entry.entityId };
  return [
    ...leaksIn(entry.payload, secrets, `${entry.action}.payload`, allowKeys),
    ...Object.entries(texts).flatMap(([name, text]) =>
      [...textSecrets].some((s) => mentions(text, s)) ? [`${entry.action}.${name}`] : [],
    ),
  ];
}

// ───────────── Motivo de "Entregar sin PIN" ─────────────

// Un marcador que no puede aparecer por casualidad: dónde se vea, el motivo interno se filtró.
export const OVERRIDE_MARKER = 'MOTIVO-INTERNO-QX7';
/** Lo que ven el cliente y el repartidor en lugar de esa nota. */
export const OVERRIDE_PUBLIC_NOTE = 'Entrega confirmada por administración';

/** ¿El pedido (tal como lo recibió el cliente o el repartidor) deja ver el motivo interno? */
export function exposesOverrideReason(order: unknown): boolean {
  const text = JSON.stringify(order);
  return text.includes(OVERRIDE_MARKER) || text.includes('Entrega sin PIN autorizada');
}

/** ¿Su historial trae el texto neutro en el evento de entrega? */
export function hasNeutralDeliveryNote(order: {
  timeline: { toStatus: string; note: string }[];
}): boolean {
  return order.timeline.some((t) => t.toStatus === 'delivered' && t.note === OVERRIDE_PUBLIC_NOTE);
}
