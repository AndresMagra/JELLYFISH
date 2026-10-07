import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPgliteDb, createPostgresDb } from './db/client';
import { importCatalog, seedDemoStock, syncCategories } from './services/catalog';
import { type Logger, consoleLogger } from './services/http-util';
import { createOtpSender } from './services/otp-senders';
import { expireStaleOrders } from './services/orders';
import { createZone, listZones } from './services/zones';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalogDir = `${root}data/catalog`;

async function main() {
  const config = loadConfig();

  // Valida el canal de OTP ANTES de abrir la base: en producción exige twilio o whatsapp con todas
  // sus credenciales y rechaza 'console'. Los fallos del proveedor se registran por el logger de
  // la app, que se conecta justo después de crearla.
  let appLog: Logger | undefined;
  const otpSender = createOtpSender(process.env, {
    ttlMinutes: config.otpTtlMinutes,
    logger: {
      warn: (o, m) => (appLog ?? consoleLogger).warn(o, m),
      error: (o, m) => (appLog ?? consoleLogger).error(o, m),
    },
  });

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

  const app = await buildApp({ db, config, otpSender, logger: true });
  appLog = app.log;
  const ctx = app.orderCtx;
  const timer = setInterval(() => {
    // Dentro de `push.scope` las cancelaciones por reserva vencida también avisan al cliente.
    app.push
      .scope(() => expireStaleOrders(ctx))
      .catch((e) => app.log.error(e, 'expireStaleOrders falló'));
    // Expo reporta tokens muertos en los recibos, minutos después del envío.
    app.push.checkReceipts().catch((e) => app.log.error(e, 'checkReceipts falló'));
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
