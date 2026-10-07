/**
 * Postgres local y desechable para validar el API contra un servidor REAL (no solo PGlite).
 *
 *   tsx scripts/pg-local.ts test [args de vitest]   # arranca, corre vitest con TEST_DATABASE_URL y apaga
 *   tsx scripts/pg-local.ts start                   # arranca y deja corriendo (imprime la URL sin contraseña)
 *   tsx scripts/pg-local.ts url                     # imprime la URL completa: export TEST_DATABASE_URL=$(…)
 *   tsx scripts/pg-local.ts stop                    # apaga y borra los datos
 *
 * No necesita Docker. Busca los binarios en este orden: PG_BIN_DIR, el paquete npm
 * `embedded-postgres` (si está instalado) y el PostgreSQL del sistema (PATH, pg_config,
 * /usr/lib/postgresql/*, Homebrew). Postgres se niega a correr como root: si el proceso es root,
 * el servidor se lanza con un usuario sin privilegios (PG_RUN_AS, o `postgres`, o uno creado con
 * useradd). Los datos viven en un directorio temporal y se borran al apagar.
 *
 * Variables opcionales: PG_BIN_DIR, PG_RUN_AS, PG_LOCAL_PORT, PG_LOCAL_DIR (solo start/stop/url),
 * PG_TIMEZONE (por defecto UTC), PG_LOCALE (por defecto C.UTF-8), PG_LOCAL_KEEP=1 (no borrar datos).
 */
import { type SpawnSyncOptions, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const SUPERUSER = 'jellyfish';
const DEFAULT_TEST_PATH = 'apps/api/test';

interface Server {
  dir: string;
  port: number;
  password: string;
  bin: string;
  runAs: string | null;
  version: string;
}

// ───────────────────────── binarios ─────────────────────────

function hasPgBinaries(dir: string): boolean {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return ['initdb', 'pg_ctl', 'postgres'].every((b) => existsSync(join(dir, b + ext)));
}

function versionDirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((d) => /^\d+/.test(d))
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))
    .map((d) => join(base, d, 'bin'));
}

export function findPgBin(): { dir: string; origin: string } {
  const tried: string[] = [];
  const candidates: { dir: string; origin: string }[] = [];
  if (process.env.PG_BIN_DIR) candidates.push({ dir: process.env.PG_BIN_DIR, origin: 'PG_BIN_DIR' });
  candidates.push({
    dir: join(
      root,
      'node_modules/@embedded-postgres',
      `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`,
      'native/bin',
    ),
    origin: 'embedded-postgres',
  });
  const pgConfig = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' });
  if (pgConfig.status === 0) candidates.push({ dir: pgConfig.stdout.trim(), origin: 'pg_config' });
  for (const d of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (d) candidates.push({ dir: d, origin: 'PATH' });
  }
  for (const base of [
    '/usr/lib/postgresql',
    '/usr/local/opt',
    '/opt/homebrew/opt',
    '/usr/pgsql',
  ]) {
    for (const d of versionDirs(base)) candidates.push({ dir: d, origin: base });
  }
  for (const c of candidates) {
    tried.push(c.dir);
    if (hasPgBinaries(c.dir)) return c;
  }
  throw new Error(
    'No encontré binarios de PostgreSQL (initdb, pg_ctl, postgres).\n' +
      '  Opciones: apt install postgresql · brew install postgresql@16 · npm i (embedded-postgres ya es devDependency) · PG_BIN_DIR=/ruta/bin\n' +
      `  Buscado en: ${tried.slice(0, 8).join(', ')}…`,
  );
}

// ───────────────────────── utilidades ─────────────────────────

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

function userExists(name: string): boolean {
  return spawnSync('id', ['-u', name], { stdio: 'ignore' }).status === 0;
}

/** Usuario sin privilegios para el servidor cuando el proceso es root (Postgres no corre como root). */
function ensureRunAs(): string | null {
  if (!isRoot()) return null;
  const wanted = process.env.PG_RUN_AS;
  if (wanted) {
    if (!userExists(wanted)) throw new Error(`PG_RUN_AS=${wanted} no existe`);
    return wanted;
  }
  for (const name of ['postgres', 'jellyfish-pg']) {
    if (userExists(name)) return name;
  }
  const created = spawnSync(
    'useradd',
    ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'jellyfish-pg'],
    { encoding: 'utf8' },
  );
  if (created.status !== 0) {
    throw new Error(
      `Soy root y no pude crear un usuario sin privilegios (useradd): ${created.stderr.trim()}. ` +
        'Define PG_RUN_AS con un usuario existente.',
    );
  }
  return 'jellyfish-pg';
}

/** Ejecuta `cmd` como `runAs` (si lo hay) con runuser o setpriv. */
function asUser(runAs: string | null, cmd: string, args: string[]): [string, string[]] {
  if (!runAs) return [cmd, args];
  if (spawnSync('which', ['runuser'], { stdio: 'ignore' }).status === 0) {
    return ['runuser', ['-u', runAs, '--', cmd, ...args]];
  }
  return ['setpriv', [`--reuid=${runAs}`, `--regid=${runAs}`, '--init-groups', '--', cmd, ...args]];
}

function exec(
  runAs: string | null,
  cmd: string,
  args: string[],
  options: SpawnSyncOptions = {},
): { status: number; out: string } {
  const [c, a] = asUser(runAs, cmd, args);
  const r = spawnSync(c, a, { encoding: 'utf8', ...options });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

function chownTo(runAs: string | null, ...paths: string[]) {
  if (!runAs) return;
  const r = spawnSync('chown', ['-R', `${runAs}:`, ...paths], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`chown falló: ${r.stderr}`);
}

export function connectionUrl(s: Pick<Server, 'port' | 'password'>, masked = false): string {
  return `postgres://${SUPERUSER}:${masked ? '***' : s.password}@127.0.0.1:${s.port}/postgres`;
}

// ───────────────────────── ciclo de vida ─────────────────────────

export async function startServer(dir: string): Promise<Server> {
  const { dir: bin, origin } = findPgBin();
  const runAs = ensureRunAs();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const version = exec(null, join(bin, `postgres${ext}`), ['--version']).out.trim();

  mkdirSync(dir, { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  const data = join(dir, 'data');
  const run = join(dir, 'run'); // sockets y log
  mkdirSync(run, { recursive: true });
  const password = randomBytes(18).toString('hex');
  const pwfile = join(run, 'pw');
  writeFileSync(pwfile, password, { mode: 0o600 });
  // El usuario sin privilegios es dueño de todo el directorio: initdb crea `data` dentro.
  chownTo(runAs, dir);
  if (runAs && exec(runAs, 'test', ['-w', dir]).status !== 0) {
    throw new Error(
      `El usuario ${runAs} no puede escribir en ${dir} (¿un directorio padre sin permiso de paso?). ` +
        'Usa PG_LOCAL_DIR o TMPDIR en una ruta accesible, p. ej. /tmp.',
    );
  }

  const locale = process.env.PG_LOCALE ?? 'C.UTF-8';
  const init = exec(runAs, join(bin, `initdb${ext}`), [
    '-D',
    data,
    '-U',
    SUPERUSER,
    '-E',
    'UTF8',
    `--locale=${locale}`,
    '--auth=scram-sha-256',
    `--pwfile=${pwfile}`,
  ]);
  rmSync(pwfile, { force: true });
  if (init.status !== 0) throw new Error(`initdb falló (${version}):\n${init.out}`);

  const port = process.env.PG_LOCAL_PORT ? Number(process.env.PG_LOCAL_PORT) : await freePort();
  // fsync apagado: es un servidor desechable y así las pruebas corren mucho más rápido.
  const options = [
    `-p ${port}`,
    '-c listen_addresses=127.0.0.1',
    `-c unix_socket_directories=${run}`,
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
    '-c max_connections=300',
    '-c log_min_messages=warning',
    `-c timezone=${process.env.PG_TIMEZONE ?? 'UTC'}`,
  ].join(' ');
  const started = exec(runAs, join(bin, `pg_ctl${ext}`), [
    '-D',
    data,
    '-l',
    join(run, 'postgres.log'),
    '-w',
    '-t',
    '60',
    '-o',
    options,
    'start',
  ]);
  if (started.status !== 0) {
    let logTail = '';
    try {
      logTail = readFileSync(join(run, 'postgres.log'), 'utf8').split('\n').slice(-20).join('\n');
    } catch {
      /* sin log */
    }
    throw new Error(`pg_ctl start falló:\n${started.out}\n${logTail}`);
  }
  const server: Server = { dir, port, password, bin, runAs, version };
  console.error(`PostgreSQL listo: ${version} (binarios de ${origin}), puerto ${port}`);
  return server;
}

export function stopServer(s: Server) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  exec(s.runAs, join(s.bin, `pg_ctl${ext}`), ['-D', join(s.dir, 'data'), '-m', 'immediate', 'stop']);
  if (process.env.PG_LOCAL_KEEP === '1') {
    console.error(`Datos conservados en ${s.dir}`);
    return;
  }
  rmSync(s.dir, { recursive: true, force: true });
}

// ───────────────────────── estado para start/stop/url ─────────────────────────

const stateDir = () => process.env.PG_LOCAL_DIR ?? join(tmpdir(), 'jellyfish-pg');
const stateFile = () => join(stateDir(), 'state.json');

function readState(): Server {
  if (!existsSync(stateFile())) throw new Error('No hay un Postgres local en marcha (usa start)');
  return JSON.parse(readFileSync(stateFile(), 'utf8')) as Server;
}

// ───────────────────────── vitest ─────────────────────────

function vitestArgs(extra: string[]): string[] {
  const hasPath = extra.some((a) => !a.startsWith('-') && (a.includes('/') || a.endsWith('.ts')));
  return ['run', ...extra, ...(hasPath ? [] : [DEFAULT_TEST_PATH])];
}

async function runTests(extra: string[]): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'jellyfish-pg-test-'));
  let server: Server | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  const stopAll = () => {
    child?.kill('SIGTERM');
    if (server) stopServer(server);
    server = null;
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopAll();
      process.exit(130);
    });
  }
  try {
    server = await startServer(dir);
    const vitest = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest');
    return await new Promise<number>((done, fail) => {
      child = spawn(vitest, vitestArgs(extra), {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, TEST_DATABASE_URL: connectionUrl(server!) },
      });
      child.once('error', fail);
      child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    });
  } finally {
    stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const [command = 'test', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'test':
      process.exitCode = await runTests(rest);
      return;
    case 'start': {
      if (existsSync(stateFile())) throw new Error(`Ya hay uno en ${stateDir()}; usa stop primero`);
      const server = await startServer(stateDir());
      writeFileSync(stateFile(), JSON.stringify(server), { mode: 0o600 });
      console.log(connectionUrl(server, true));
      console.error('Para usarlo: export TEST_DATABASE_URL=$(npx tsx scripts/pg-local.ts url)');
      return;
    }
    case 'url':
      console.log(connectionUrl(readState()));
      return;
    case 'stop':
      stopServer(readState());
      console.error('PostgreSQL apagado');
      return;
    default:
      throw new Error(`Comando desconocido: ${command} (test | start | url | stop)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
