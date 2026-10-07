/** Utilidades comunes de los recorridos e2e: procesos, servidor estático, esperas y OTP. */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const CHROME =
  process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const children: ChildProcess[] = [];
export const apiLog = { text: '' };

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
  children.push(child);
  const sink = (d: Buffer) => {
    if (capture) apiLog.text += d.toString();
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return child;
}

export function stopAll() {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* ya terminó */
    }
  }
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
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
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
