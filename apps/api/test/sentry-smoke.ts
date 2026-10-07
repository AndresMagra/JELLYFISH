/**
 * Prueba de humo con el SDK REAL de Sentry, sin red: un transporte falso recoge lo que se enviaría.
 * Corre en un proceso aparte (lo lanza security.test.ts) porque `Sentry.init` instala manejadores
 * globales de proceso que no deben vivir dentro del worker de las pruebas.
 *
 * Los datos "sensibles" llegan por la variable SMOKE_SECRETS (no están escritos aquí) para poder
 * comprobar que no aparecen en nada de lo que el SDK enviaría, ni siquiera en las líneas de código
 * que adjunta a cada marco de la pila. Imprime un JSON: { events: string[] } con los sobres.
 */
import * as Sentry from '@sentry/node';
import { createErrorReporter } from '../src/plugins/sentry';

const secrets = JSON.parse(process.env.SMOKE_SECRETS ?? '{}') as Record<string, string>;
const sent: string[] = [];
const transport = () => ({
  send: async (envelope: unknown) => {
    sent.push(JSON.stringify(envelope));
    return {};
  },
  flush: async () => true,
});

function makeError(message: string) {
  return new Error(message);
}

const reporter = await createErrorReporter(
  { sentryDsn: 'https://public@o0.ingest.sentry.io/1' },
  { NODE_ENV: 'production', SENTRY_RELEASE: 'prueba-1' },
  { sdkOptions: { transport } },
);

// Todo lo que el SDK suele adjuntar por su cuenta o por el código de la aplicación:
Sentry.setUser({ id: secrets.userId, username: secrets.name, ip_address: secrets.ip });
Sentry.setExtra('cuerpo', { code: secrets.code, phone: secrets.phone });
Sentry.setContext('pedido', { pin: secrets.pin });
Sentry.addBreadcrumb({ category: 'console', message: `OTP ${secrets.code} para ${secrets.phone}` });
Sentry.setTag('region', 'DO');

reporter.capture(makeError(`No se pudo cobrar a ${secrets.phone} con ${secrets.bearer}`), {
  method: 'POST',
  route: '/v1/orders/:id/pay',
  status: 500,
  requestId: 'req-1',
});
await reporter.flush(3000);
process.stdout.write(JSON.stringify({ events: sent }));
process.exit(0);
