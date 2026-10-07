import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { type DbHandle, createPgliteDb, createPostgresDb } from '../src/db/client';

/**
 * Interruptor de base de datos de las pruebas.
 *
 * Sin `TEST_DATABASE_URL` cada prueba usa PGlite en memoria. Con ella (`npm run test:pg`) cada
 * llamada crea una BASE DE DATOS temporal en ese servidor, corre las migraciones reales con
 * `createPostgresDb` y la borra al cerrar. Se usa una base y no un esquema porque las migraciones
 * generadas por drizzle-kit califican las claves foráneas como "public"."tabla": con un esquema
 * por prueba apuntarían todas a las tablas de `public`.
 */
export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() || null;

export const usingRealPostgres = testDatabaseUrl !== null;

const quote = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function withAdmin<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Crea una base de datos vacía y devuelve su URL. */
async function createDatabase(adminUrl: string): Promise<{ name: string; url: string }> {
  const name = `jf_test_${process.pid}_${randomBytes(6).toString('hex')}`;
  await withAdmin(adminUrl, (c) => c.query(`CREATE DATABASE ${quote(name)}`));
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function createTestDb(): Promise<DbHandle> {
  if (!testDatabaseUrl) return createPgliteDb();

  const created = await createDatabase(testDatabaseUrl);
  let handle: DbHandle;
  try {
    handle = await createPostgresDb(created.url);
  } catch (e) {
    await dropDatabase(testDatabaseUrl, created.name);
    throw e;
  }
  let closing: Promise<void> | null = null;
  return {
    db: handle.db,
    close: () =>
      (closing ??= (async () => {
        await handle.close();
        await dropDatabase(testDatabaseUrl, created.name);
      })()),
  };
}

async function dropDatabase(adminUrl: string, name: string) {
  // FORCE cierra las conexiones que una prueba haya dejado abiertas.
  await withAdmin(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
}

/** Para pruebas que necesitan una base vacía SIN migrar (p. ej. probar el propio migrador). */
export async function createEmptyTestDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  if (!testDatabaseUrl) throw new Error('Requiere TEST_DATABASE_URL');
  const created = await createDatabase(testDatabaseUrl);
  return { url: created.url, drop: () => dropDatabase(testDatabaseUrl, created.name) };
}
