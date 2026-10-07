import type { Logger } from '../services/http-util';

/**
 * Reporte de errores (Sentry) opcional. Sin SENTRY_DSN no se carga ni se envía nada.
 * Regla de oro: Sentry solo recibe el tipo de error, el mensaje depurado, la pila y la ruta. Nunca
 * teléfonos, tokens, cabeceras, cuerpos de petición ni datos de la persona.
 */

export interface ErrorContext {
  method: string;
  /** Patrón de la ruta (`/v1/orders/:id`), nunca la URL con ids ni parámetros. */
  route: string;
  status: number;
  requestId?: string;
}

export interface ErrorReporter {
  /** Solo se llama con errores 5xx. Nunca debe lanzar. */
  capture(error: unknown, context: ErrorContext): void;
  /** Espera a que se vacíe la cola de envío (apagado ordenado). */
  flush(timeoutMs?: number): Promise<void>;
}

export const noopReporter: ErrorReporter = {
  capture() {},
  async flush() {},
};

/** Subconjunto de `@sentry/node` que usamos; permite un doble en las pruebas. */
export interface SentrySdk {
  init(options: Record<string, unknown>): unknown;
  captureException(error: unknown, hint?: Record<string, unknown>): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
}

/** Quita de un texto libre lo que parezca teléfono o token. */
export function scrubText(text: string): string {
  return text
    .replace(/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[token]')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [token]')
    .replace(/Expo(?:nent)?PushToken\[[^\]]*\]/g, '[token]')
    .replace(/\+?\(?\d[\d\s().-]{6,}\d/g, '[número]');
}

interface FrameLike {
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  vars?: unknown;
  [key: string]: unknown;
}

interface EventLike {
  message?: unknown;
  exception?: {
    values?: { value?: unknown; stacktrace?: { frames?: FrameLike[] } & Record<string, unknown> }[];
  };
  [key: string]: unknown;
}

/** Las líneas de código de cada marco también pasan por el filtro; las variables locales se quitan. */
function scrubFrame(frame: FrameLike): FrameLike {
  const { vars: _vars, ...rest } = frame;
  return {
    ...rest,
    ...(rest.pre_context ? { pre_context: rest.pre_context.map(scrubText) } : {}),
    ...(typeof rest.context_line === 'string'
      ? { context_line: scrubText(rest.context_line) }
      : {}),
    ...(rest.post_context ? { post_context: rest.post_context.map(scrubText) } : {}),
  };
}

/**
 * Último filtro antes de enviar: deja el evento sin datos de la petición ni de la persona, sin
 * migas de pan (podrían traer líneas de consola con códigos) y con los textos depurados.
 */
export function scrubEvent<T extends EventLike>(event: T): T {
  const out: EventLike = { ...event };
  delete out.request;
  delete out.user;
  delete out.breadcrumbs;
  delete out.extra;
  delete out.contexts;
  delete out.server_name;
  if (typeof out.message === 'string') out.message = scrubText(out.message);
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((v) => ({
        ...v,
        value: typeof v.value === 'string' ? scrubText(v.value) : v.value,
        ...(v.stacktrace?.frames
          ? { stacktrace: { ...v.stacktrace, frames: v.stacktrace.frames.map(scrubFrame) } }
          : {}),
      })),
    };
  }
  return out as T;
}

export interface SentryOptions {
  dsn: string;
  environment?: string;
  release?: string;
  /** Opciones extra del SDK (solo pruebas: un `transport` que no sale a la red). */
  extra?: Record<string, unknown>;
}

const DROPPED_INTEGRATIONS = new Set([
  'ProcessSession',
  'RequestData',
  'Console',
  'Http',
  'NodeFetch',
  'Express',
  'Fastify',
  'Hapi',
  'Hono',
  'Koa',
]);

export class SentryReporter implements ErrorReporter {
  constructor(
    private readonly sdk: SentrySdk,
    private readonly logger?: Pick<Logger, 'error'>,
  ) {}

  /** Inicializa el SDK con las opciones que no envían datos personales. */
  static init(sdk: SentrySdk, options: SentryOptions, logger?: Pick<Logger, 'error'>) {
    sdk.init({
      ...options.extra,
      dsn: options.dsn,
      environment: options.environment,
      release: options.release,
      sendDefaultPii: false,
      // Integraciones que adjuntan datos de la petición, de la persona (las sesiones envían usuario e
      // IP) o líneas de consola. Solo queda lo necesario para capturar y agrupar errores.
      integrations: (defaults: { name: string }[]) =>
        defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
      // Sin migas de pan: podrían incluir líneas de consola con teléfonos o códigos.
      maxBreadcrumbs: 0,
      beforeBreadcrumb: () => null,
      beforeSend: (event: EventLike) => scrubEvent(event),
    });
    return new SentryReporter(sdk, logger);
  }

  capture(error: unknown, context: ErrorContext): void {
    try {
      this.sdk.captureException(error, {
        tags: {
          method: context.method,
          route: context.route,
          status: String(context.status),
          ...(context.requestId ? { requestId: context.requestId } : {}),
        },
      });
    } catch (e) {
      this.logger?.error({ err: (e as Error).name }, 'Sentry.captureException falló');
    }
  }

  async flush(timeoutMs = 2000): Promise<void> {
    try {
      await this.sdk.flush(timeoutMs);
    } catch {
      // al apagar no hay nada útil que hacer con un fallo del envío
    }
  }
}

/**
 * Crea el reporte según el entorno. Sin DSN devuelve el reporte vacío y NO importa `@sentry/node`.
 * `sdk` solo se pasa en pruebas.
 */
export async function createErrorReporter(
  config: { sentryDsn: string | null },
  env: NodeJS.ProcessEnv,
  options: {
    sdk?: SentrySdk;
    logger?: Pick<Logger, 'error'>;
    sdkOptions?: Record<string, unknown>;
  } = {},
): Promise<ErrorReporter> {
  if (!config.sentryDsn) return noopReporter;
  // Un DSN mal puesto o un SDK que no carga no deben tumbar la tienda: se avisa y se sigue sin reporte.
  try {
    const sdk = options.sdk ?? ((await import('@sentry/node')) as unknown as SentrySdk);
    return SentryReporter.init(
      sdk,
      {
        dsn: config.sentryDsn,
        environment: env.NODE_ENV,
        release: env.SENTRY_RELEASE?.trim() || undefined,
        extra: options.sdkOptions,
      },
      options.logger,
    );
  } catch (e) {
    options.logger?.error(
      { err: (e as Error).name },
      'No se pudo iniciar Sentry: el API sigue sin reporte de errores',
    );
    return noopReporter;
  }
}
