import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { createPgliteDb, createPostgresDb } from './db/client';
import { runMaintenanceTick } from './maintenance';
import { validateProductionEnv } from './plugins/security';
import { createErrorReporter } from './plugins/sentry';
import { importCatalog, seedDemoStock, syncCategories } from './services/catalog';
import { type Logger, consoleLogger } from './services/http-util';
import { createOtpSender } from './services/otp-senders';
import { createZone, listZones } from './services/zones';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalogDir = `${root}data/catalog`;

async function main() {
  // En producción se revisa TODO de una vez (secretos, CORS, base, URL pública) antes de arrancar.
  if (process.env.NODE_ENV === 'production') {
    const check = validateProductionEnv(process.env);
    for (const warning of check.warnings) console.warn(`Aviso de configuración: ${warning}`);
    if (!check.ok) {
      console.error(
        `El API no puede arrancar en producción. Corrige la configuración:\n${check.errors.map((e) => `  - ${e}`).join('\n')}`,
      );
      process.exit(1);
    }
  }
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

  // Sin SENTRY_DSN no hace nada (y ni siquiera carga el SDK).
  const errorReporter = await createErrorReporter(config, process.env, { logger: consoleLogger });
  const app = await buildApp({ db, config, otpSender, logger: true, errorReporter });
  appLog = app.log;
  const timer = setInterval(() => {
    // Reservas vencidas (con aviso push tras el commit) y recibos de Expo: ver maintenance.ts.
    runMaintenanceTick(app).catch((e) => app.log.error(e, 'Tarea periódica falló'));
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
    await errorReporter.flush();
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
