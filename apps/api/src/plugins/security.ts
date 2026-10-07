import { createHash } from 'node:crypto';
import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyRequest, FastifyServerOptions } from 'fastify';
import type { Config } from '../config';
import { redactUrl } from '../services/http-util';

/**
 * Endurecimiento del API: cabeceras de seguridad, límites de cuerpo, límites de peticiones por ruta,
 * redacción de logs y validación del entorno de producción.
 */

// ───────────── Límites de cuerpo ─────────────

/** Casi todo el API recibe JSON pequeño; 256 KB sobra (un pedido de 60 líneas pesa ~10 KB). */
export const DEFAULT_BODY_LIMIT = 256 * 1024;
/** Solo la importación del catálogo en CSV puede ser grande (Excel con miles de filas). */
export const LARGE_BODY_LIMIT = 5 * 1024 * 1024;

/** Rutas (método + patrón de Fastify) que pueden pasar de DEFAULT_BODY_LIMIT. */
export const LARGE_BODY_ROUTES: readonly { method: string; url: string }[] = [
  { method: 'POST', url: '/v1/admin/catalog/import' },
];

// ───────────── Límite de peticiones más estricto ─────────────

export interface RateRule {
  /** Nombre para pruebas y documentación. */
  name: string;
  methods: readonly string[] | '*';
  /** Se compara con el patrón de la ruta registrada (p. ej. `/v1/driver/orders/:id/transition`). */
  url: RegExp;
  max: number;
  timeWindow: string;
  /**
   * `ip` (por defecto) o `token`: una cuenta con sesión cuenta aparte aunque comparta IP con otras. Las
   * redes móviles de República Dominicana comparten IP entre muchos teléfonos (CGNAT): con `ip`, varios
   * repartidores en la misma red se bloquearían entre sí. Sin cabecera de sesión se cae a la IP.
   */
  keyBy?: 'ip' | 'token';
}

/**
 * Se aplican a las rutas que NO traen su propio `config.rateLimit` (pedir y verificar el OTP ya definen
 * 10 por 10 minutos y se respeta). Por IP salvo que se indique `keyBy: 'token'`; sin TRUST_PROXY detrás
 * de un balanceador, todas las IP serían la del balanceador.
 */
export const STRICT_RATE_RULES: readonly RateRule[] = [
  // Cualquier ruta de acceso nueva nace con un límite bajo por defecto.
  { name: 'auth', methods: '*', url: /^\/v1\/auth\//, max: 20, timeWindow: '10 minutes' },
  // Entrega con PIN: además del bloqueo de 5 intentos por pedido, se frena a quien prueba pedidos.
  {
    name: 'driver-pin',
    methods: ['POST'],
    url: /^\/v1\/driver\/orders\/:id\/transition$/,
    max: 30,
    timeWindow: '1 minute',
    keyBy: 'token',
  },
  // La app manda posición cada pocos segundos; esto solo frena el abuso (el servicio ya limita a 1 cada 4 s).
  {
    name: 'driver-location',
    methods: ['POST'],
    url: /^\/v1\/driver\/location$/,
    max: 120,
    timeWindow: '1 minute',
    keyBy: 'token',
  },
];

// ───────────── Redacción de logs ─────────────

/** Campos que nunca deben llegar a un log, venga el objeto como `body` o como `req.body`. */
const SECRET_BODY_FIELDS = ['code', 'otp', 'pin', 'token', 'password', 'secret', 'phone'];

export const LOG_REDACT = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'headers.authorization',
    'headers.cookie',
    'res.headers["set-cookie"]',
    ...['body', 'req.body', 'request.body'].flatMap((base) =>
      SECRET_BODY_FIELDS.map((field) => `${base}.${field}`),
    ),
  ],
  censor: '[redacted]',
} as const;

const SENSITIVE_QUERY_KEY =
  /(token|code|pin|otp|secret|password|authorization|authhash|signature)/i;

/**
 * Oculta el valor de los parámetros sensibles del query (el enlace de pago lleva un token firmado,
 * la pasarela devuelve firmas). Se aplica DESPUÉS de `redactUrl` de http-util, que ya reemplazó el
 * token de push y `?token=` por `:token`; ese marcador se respeta.
 */
export function redactQuery(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      let key = pair.slice(0, eq);
      try {
        key = decodeURIComponent(key);
      } catch {
        // clave mal codificada: se compara tal cual
      }
      const value = pair.slice(eq + 1);
      return SENSITIVE_QUERY_KEY.test(key) && value !== ':token'
        ? `${pair.slice(0, eq)}=[redacted]`
        : pair;
    })
    .join('&');
  return `${url.slice(0, q)}?${query}`;
}

/** URL apta para un log de acceso: sin tokens en la ruta ni en el query. */
export const safeLogUrl = (url: string) => redactQuery(redactUrl(url));

/**
 * Opciones de pino para Fastify (mismo contrato que `AppDeps.logger`: `true` = salida estándar,
 * `{ stream }` = otro destino, para pruebas). Oculta cabeceras y campos secretos y los tokens de la URL.
 */
export function buildLoggerOptions(
  logger: boolean | { stream: NodeJS.WritableStream } | undefined,
): FastifyServerOptions['logger'] {
  if (!logger) return false;
  return {
    ...(typeof logger === 'object' ? { stream: logger.stream } : {}),
    redact: { paths: [...LOG_REDACT.paths], censor: LOG_REDACT.censor },
    serializers: {
      // Igual que el serializador por defecto de Fastify, salvo la URL.
      req: (req: FastifyRequest) => ({
        method: req.method,
        url: safeLogUrl(req.url ?? ''),
        version: req.headers?.['accept-version'] as string | undefined,
        host: req.host,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort,
      }),
    },
  } as FastifyServerOptions['logger'];
}

// ───────────── IP real detrás del balanceador ─────────────

/**
 * Fastify no acepta un número de saltos (lo trata como "no confiar en nadie", a propósito: no puede
 * comprobar quién es el vecino directo). Aquí se traduce a una función: se confía en los primeros N
 * saltos desde el API, así que la IP del cliente es la última entrada que añadió el balanceador a
 * X-Forwarded-For y un cliente no puede falsificarla mandando su propia cabecera. Solo es seguro si el
 * API no es alcanzable sino a través del balanceador; si no, usa la lista de IP/CIDR de TRUST_PROXY.
 */
export function toFastifyTrustProxy(
  trustProxy: Config['trustProxy'],
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (typeof trustProxy === 'number') return (_address, hop) => hop < trustProxy;
  return trustProxy;
}

// ───────────── Hooks de seguridad ─────────────

function methodsOf(method: string | readonly string[] | undefined): string[] {
  if (!method) return [];
  return (Array.isArray(method) ? [...method] : [method]).map((m) => String(m).toUpperCase());
}

/** Regla de límite de peticiones que corresponde a una ruta registrada, si la hay. */
export function rateRuleFor(method: string, url: string): RateRule | undefined {
  return STRICT_RATE_RULES.find(
    (r) => (r.methods === '*' || r.methods.includes(method)) && r.url.test(url),
  );
}

/** Clave del límite por sesión: huella de la cabecera Authorization (nunca el token entero); sin ella, la IP. */
export function tokenOrIpKey(req: { headers: { authorization?: string }; ip: string }): string {
  const auth = req.headers.authorization;
  return auth
    ? `t:${createHash('sha256').update(auth).digest('base64url').slice(0, 22)}`
    : `ip:${req.ip}`;
}

export function isLargeBodyRoute(method: string, url: string): boolean {
  return LARGE_BODY_ROUTES.some((r) => r.method === method && r.url === url);
}

/**
 * Debe registrarse ANTES de `@fastify/rate-limit`: ese plugin lee `config.rateLimit` de cada ruta en
 * su propio hook `onRoute`, y los hooks corren en orden de registro.
 */
export async function installSecurity(app: FastifyInstance, config: Config): Promise<void> {
  // Ajustes por ruta sin tocar los archivos de rutas de otras funciones.
  app.addHook('onRoute', (route) => {
    const methods = methodsOf(route.method as string | string[]);
    if (route.bodyLimit === undefined && methods.some((m) => isLargeBodyRoute(m, route.url))) {
      route.bodyLimit = LARGE_BODY_LIMIT;
    }
    const rule = methods.map((m) => rateRuleFor(m, route.url)).find(Boolean);
    const routeConfig = (route.config ??= {}) as { rateLimit?: unknown };
    if (rule && routeConfig.rateLimit === undefined) {
      routeConfig.rateLimit = {
        max: rule.max,
        timeWindow: rule.timeWindow,
        ...(rule.keyBy === 'token' ? { keyGenerator: tokenOrIpKey } : {}),
      };
    }
  });

  // API JSON: ninguna respuesta debe poder ejecutar ni incrustar nada. Las páginas HTML del pago
  // ponen su propia política y sobrescriben esta.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // El panel web y las apps leen el API desde otro origen (CORS): no se bloquea por CORP.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS solo en producción: en desarrollo (http://localhost) no tiene sentido y molesta al cambiar de puerto.
    hsts: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  // Datos de personas y de pedidos: ningún intermediario debe guardarlos. Si la ruta ya puso su
  // propia política (p. ej. fotos del catálogo) se respeta.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('cache-control') && req.url.startsWith('/v1/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}

// ───────────── Validación del entorno de producción ─────────────

export interface EnvCheck {
  ok: boolean;
  /** Impiden arrancar. */
  errors: string[];
  /** Conviene arreglarlas, pero el API arranca. */
  warnings: string[];
}

const WEAK_SECRET =
  /(changeme|change-me|cambiame|cambia[-_ ]?esto|your[-_ ]?secret|dev[-_ ]?secret|test[-_ ]?secret|secret[-_ ]?key|example|ejemplo|placeholder|password|contrase)/i;

/** Secreto de muestra, de pruebas o con patrón repetido (nunca imprime el valor). */
export function isWeakSecret(value: string): boolean {
  return WEAK_SECRET.test(value) || new Set(value).size < 8 || /^(.{1,20})\1+$/.test(value.trim());
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Revisa de una vez TODO lo que falta para arrancar en producción, con mensajes en español que
 * nombran la variable (nunca su valor). Función pura: el llamador decide si sale con error.
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv): EnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  const jwt = env.JWT_SECRET ?? '';
  if (!jwt) {
    errors.push(
      'JWT_SECRET: falta. Define un secreto aleatorio de al menos 32 caracteres (p. ej. `openssl rand -hex 32`).',
    );
  } else if (jwt.length < 32) {
    errors.push('JWT_SECRET: es demasiado corto; necesita al menos 32 caracteres.');
  } else if (isWeakSecret(jwt)) {
    errors.push(
      'JWT_SECRET: parece un valor de ejemplo o de desarrollo. Genera uno aleatorio (`openssl rand -hex 32`).',
    );
  }

  const pepper = env.OTP_PEPPER ?? '';
  if (!pepper) {
    errors.push('OTP_PEPPER: falta. Define un valor aleatorio de al menos 16 caracteres.');
  } else if (pepper.length < 16) {
    errors.push('OTP_PEPPER: es demasiado corto; necesita al menos 16 caracteres.');
  }

  const dbUrl = env.DATABASE_URL?.trim() ?? '';
  if (!dbUrl) {
    errors.push(
      'DATABASE_URL: falta. En producción el API necesita Postgres (postgres://usuario:clave@host/base); la base embebida solo es para desarrollo.',
    );
  } else if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
    errors.push('DATABASE_URL: debe empezar con postgres:// o postgresql://.');
  }

  const publicUrl = env.PUBLIC_API_URL?.trim() ?? '';
  if (!publicUrl) {
    errors.push(
      'PUBLIC_API_URL: falta. Es la dirección pública del API (https://api.tudominio.do); la pasarela de pago redirige ahí.',
    );
  } else {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== 'https:' || isLocalHost(url.hostname)) {
        errors.push(
          'PUBLIC_API_URL: debe ser una dirección pública con https:// (no localhost ni http).',
        );
      }
    } catch {
      errors.push('PUBLIC_API_URL: no es una dirección válida (https://api.tudominio.do).');
    }
  }

  const origins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    errors.push(
      'CORS_ORIGINS: falta. Lista los orígenes del panel web separados por comas (https://panel.tudominio.do); sin ella ningún sitio web podrá llamar al API.',
    );
  }
  for (const origin of origins) {
    if (origin === '*') {
      errors.push('CORS_ORIGINS: no puede ser "*"; lista los orígenes permitidos.');
      continue;
    }
    try {
      const url = new URL(origin);
      if (url.origin !== origin.replace(/\/+$/, '')) {
        errors.push(
          `CORS_ORIGINS: "${origin}" debe ser solo el origen (esquema, dominio y puerto), sin ruta.`,
        );
      } else if (url.protocol !== 'https:' && !isLocalHost(url.hostname)) {
        errors.push(`CORS_ORIGINS: "${origin}" debe usar https://.`);
      }
    } catch {
      errors.push(`CORS_ORIGINS: "${origin}" no es un origen válido (https://panel.tudominio.do).`);
    }
  }

  if (env.PAYMENTS_MOCK === '1') {
    errors.push('PAYMENTS_MOCK: el simulador de pagos no puede activarse en producción.');
  }

  if (env.JELLYFISH_DEMO === '1') {
    warnings.push(
      'JELLYFISH_DEMO=1: se permiten precios estimados e ITBIS sin confirmar. No lo uses con clientes reales.',
    );
  }
  const trust = env.TRUST_PROXY?.trim().toLowerCase();
  if (!trust || trust === '0' || trust === 'false') {
    warnings.push(
      'TRUST_PROXY: sin definir. Si el API está detrás de un balanceador, todas las personas compartirán la IP del balanceador en el límite de peticiones y la bitácora. Usa TRUST_PROXY=1 (número de balanceadores).',
    );
  } else if (trust === 'true') {
    warnings.push(
      'TRUST_PROXY=true confía en toda la cadena X-Forwarded-For y un cliente puede falsificar su IP. Usa el número de balanceadores (1) o sus direcciones.',
    );
  }
  if (!env.SENTRY_DSN?.trim()) {
    warnings.push('SENTRY_DSN: sin definir; los errores 5xx solo quedarán en los logs.');
  }

  return { ok: errors.length === 0, errors, warnings };
}
