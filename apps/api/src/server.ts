import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPgliteDb, createPostgresDb } from './db/client';
import { ConsoleOtpSender } from './services/auth';
import { importCatalog, seedDemoStock, syncCategories } from './services/catalog';
import { expireStaleOrders } from './services/orders';
import { createZone, listZones } from './services/zones';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalogDir = `${root}data/catalog`;

async function main() {
  const config = loadConfig();
  const production = process.env.NODE_ENV === 'production';

  if (production && !process.env.OTP_SENDER) {
    throw new Error(
      'Producción requiere un canal real de OTP (SMS/WhatsApp). Aún no está conectado: ' +
        'implementa OtpSender y regístralo aquí antes de desplegar.',
    );
  }

  const handle = process.env.DATABASE_URL
    ? await createPostgresDb(process.env.DATABASE_URL)
    : await createPgliteDb({ dataDir: process.env.PGLITE_DIR });
  const { db } = handle;

  const categories = JSON.parse(readFileSync(`${catalogDir}/categories.json`, 'utf8'));
  await syncCategories(db, categories);
  if (process.env.JELLYFISH_SEED === '1') {
    const result = await importCatalog(db, readFileSync(`${catalogDir}/products.seed.csv`, 'utf8'));
    console.log(
      `Catálogo semilla: ${result.variantsCreated} artículos nuevos, ${result.variantsUpdated} actualizados`,
    );
    if (config.demo) {
      const n = await seedDemoStock(db);
      if (n > 0) console.log(`Modo demo: existencias de ejemplo para ${n} artículos`);
    }
  }

  if (config.demo && (await listZones(db, false)).length === 0) {
    // Valores de EJEMPLO para desarrollo: la tarifa real la define el dueño en el panel admin.
    await createZone(db, {
      name: 'Santo Domingo (demo)',
      areas: [
        'Santo Domingo',
        'Distrito Nacional',
        'Naco',
        'Piantini',
        'Evaristo Morales',
        'Bella Vista',
      ],
      feeCentavos: 15_000,
      minOrderCentavos: 80_000,
      freeOverCentavos: 400_000,
    });
  }

  const app = await buildApp({ db, config, otpSender: new ConsoleOtpSender(), logger: true });
  const ctx = app.orderCtx;
  const timer = setInterval(() => {
    expireStaleOrders(ctx).catch((e) => app.log.error(e, 'expireStaleOrders falló'));
  }, 60_000);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
  if (config.demo)
    app.log.warn(
      'MODO DEMO: se permiten precios estimados e ITBIS sin confirmar. No usar en producción.',
    );

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
