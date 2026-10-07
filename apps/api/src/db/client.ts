import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { schema } from './schema';

/**
 * Los servicios dependen de este tipo y no de un driver concreto: funcionan igual con PGlite
 * (desarrollo y pruebas) y con node-postgres/Postgres gestionado (producción).
 * `db.transaction(async (tx) => …)` entrega un `tx` que también es `Db`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Postgres embebido (WASM). Sin `dataDir` vive en memoria. */
export async function createPgliteDb(options: { dataDir?: string } = {}): Promise<DbHandle> {
  const client = new PGlite(options.dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, close: () => client.close() };
}

/**
 * Postgres gestionado (producción). Mismo esquema y mismos servicios que PGlite.
 * OJO: este adaptador compila y usa la misma API de Drizzle, pero NO se ha ejecutado contra un
 * servidor real en el entorno de desarrollo (no hay Postgres ni Docker). Verificar en el primer
 * despliegue de staging antes de usarlo con clientes.
 */
export async function createPostgresDb(connectionString: string): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzlePg(pool, { schema });
  await migratePg(db, { migrationsFolder });
  return { db, close: () => pool.end() };
}
