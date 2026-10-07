/** Utilidades de red compartidas por los envíos a terceros (OTP y push). */

export type FetchLike = typeof fetch;

/** Forma mínima de logger (compatible con pino/Fastify): el objeto primero, el mensaje después. */
export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Logger por defecto: una línea JSON por evento. */
export const consoleLogger: Logger = {
  warn: (obj, msg) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Falla de transporte (sin respuesta HTTP): vencimiento del tiempo o error de red. */
export class TransportFailure extends Error {
  constructor(
    public readonly kind: 'timeout' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'TransportFailure';
  }
}

/**
 * `fetch` con tiempo máximo. El cuerpo se lee dentro del mismo plazo para que una respuesta que
 * se queda a medias tampoco cuelgue la petición. No sigue redirecciones: las credenciales no
 * deben viajar a otro destino.
 */
export async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const text = await res.text().catch(() => '');
    return { status: res.status, text };
  } catch (e) {
    if (controller.signal.aborted) {
      throw new TransportFailure('timeout', `sin respuesta en ${timeoutMs} ms`);
    }
    throw new TransportFailure('network', describeError(e));
  } finally {
    clearTimeout(timer);
  }
}

/** Nombre y código del error (p. ej. `TypeError ECONNRESET`), sin mensajes que puedan traer datos. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return 'error desconocido';
  const cause = (e as { cause?: { code?: unknown } }).cause;
  const code = typeof cause?.code === 'string' ? ` ${cause.code}` : '';
  return `${e.name}${code}`;
}

/**
 * URL apta para registros de acceso: oculta los tokens que viajan en la ruta
 * (`DELETE /v1/me/devices/:token`) o en el query (`?token=…`). Con un token de push cualquiera
 * podría mandarle notificaciones falsas a ese teléfono, así que no debe quedar en los logs.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/v1\/me\/devices\/)[^/?#]+/, '$1:token')
    .replace(/([?&]token=)[^&#]*/gi, '$1:token');
}

/** "+18095551234" → "+1809*****34": suficiente para ubicar el caso sin exponer el número. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return '***';
  return `${phone.slice(0, 5)}${'*'.repeat(phone.length - 7)}${phone.slice(-2)}`;
}

/**
 * Quita de un texto del proveedor lo que no debe llegar a los logs: los valores secretos que
 * conocemos, números de teléfono con cualquier formato, secuencias largas de dígitos (códigos) y
 * cadenas largas que parecen identificadores o tokens.
 */
export function redactText(text: string, secrets: readonly string[] = [], max = 200): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('***');
  out = out
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '***')
    .replace(/\d{4,}/g, '***')
    .replace(/[A-Za-z0-9_-]{24,}/g, '***');
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
