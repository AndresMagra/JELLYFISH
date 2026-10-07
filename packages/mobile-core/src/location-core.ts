/**
 * Lógica de la ubicación del repartidor SIN dependencias de React Native ni de Expo (se prueba en
 * Node con Vitest). `location.ts` la conecta con expo-location y con React.
 */
import { isInDominicanRepublic } from '@jellyfish/shared';

/** Una lectura del GPS ya normalizada. `timestamp` en ms (reloj del teléfono). */
export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  timestamp: number;
}

/** El API acepta 1 actualización cada 4 s por repartidor; nosotros mandamos cada ~15 s. */
export const BROADCAST_INTERVAL_MS = 15_000;
/** Mínimo entre dos envíos aunque el GPS entregue lecturas más seguidas. */
export const MIN_SEND_GAP_MS = 12_000;
/** expo-location: tiempo (Android) y distancia (ambos) entre lecturas del seguidor. */
export const WATCH_TIME_INTERVAL_MS = 12_000;
export const WATCH_DISTANCE_INTERVAL_M = 25;
/** Tope de espera cuando el GPS no responde. */
export const POSITION_TIMEOUT_MS = 10_000;
/** Si una lectura es más vieja que esto, se pide una nueva en vez de reenviarla. */
export const MAX_FIX_AGE_MS = 45_000;

interface ExpoLocationLike {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp?: number;
}

export function fixFromExpo(loc: ExpoLocationLike, now: number = Date.now()): GeoFix {
  const accuracy = loc.coords.accuracy;
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    accuracyM:
      typeof accuracy === 'number' && Number.isFinite(accuracy) ? Math.max(0, accuracy) : null,
    timestamp: typeof loc.timestamp === 'number' ? loc.timestamp : now,
  };
}

/** El API rechaza coordenadas fuera de RD (un simulador en California, un GPS sin señal). */
export function isReportable(fix: Pick<GeoFix, 'latitude' | 'longitude'>): boolean {
  return isInDominicanRepublic(fix.latitude, fix.longitude);
}

/** Cuerpo de POST /v1/driver/location. La precisión se redondea a metros enteros. */
export function toLocationBody(
  fix: GeoFix,
  orderId?: string | null,
): { latitude: number; longitude: number; accuracyM?: number; orderId?: string } {
  return {
    latitude: fix.latitude,
    longitude: fix.longitude,
    ...(fix.accuracyM !== null ? { accuracyM: Math.round(fix.accuracyM) } : {}),
    ...(orderId ? { orderId } : {}),
  };
}

// ───────────── Permiso ─────────────

export type LocationPermissionState =
  /** Aún no se ha leído. */
  | 'unknown'
  | 'granted'
  /** Nunca se ha preguntado. */
  | 'undetermined'
  /** Se negó, pero el sistema todavía deja preguntar. */
  | 'denied'
  /** Se negó para siempre: solo se cambia en los Ajustes del teléfono. */
  | 'blocked';

export function permissionStateFrom(r: {
  granted: boolean;
  canAskAgain?: boolean;
  status?: string;
}): LocationPermissionState {
  if (r.granted) return 'granted';
  if (r.status === 'undetermined') return 'undetermined';
  return r.canAskAgain === false ? 'blocked' : 'denied';
}

/** Texto para la persona según el permiso; null cuando está todo bien. */
export function permissionMessage(state: LocationPermissionState): string | null {
  switch (state) {
    case 'granted':
    case 'unknown':
      return null;
    case 'undetermined':
      return 'Activa tu ubicación para que tus clientes vean tu avance.';
    case 'denied':
      return 'No tenemos permiso para ver tu ubicación. Actívala para que tus clientes vean tu avance.';
    case 'blocked':
      return 'La ubicación está apagada para esta app. Actívala en Ajustes del teléfono para que tus clientes vean tu avance.';
  }
}

// ───────────── Errores ─────────────

export type LocationErrorCode = 'timeout' | 'permission' | 'unavailable';

export class LocationError extends Error {
  constructor(
    public readonly code: LocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocationError';
  }
}

export const LOCATION_MESSAGES: Record<LocationErrorCode, string> = {
  timeout: 'Tu teléfono tardó mucho en darnos tu ubicación. Revisa que el GPS esté prendido.',
  permission: 'No tenemos permiso para ver tu ubicación.',
  unavailable: 'No pudimos leer tu ubicación. Revisa que el GPS esté prendido.',
};

/**
 * Espera una promesa, pero no más de `ms`. Si se acaba el tiempo falla con LocationError('timeout');
 * la promesa original sigue su curso sin dejar un rechazo sin atender.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LocationError('timeout', LOCATION_MESSAGES.timeout)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ───────────── Límites del servidor ─────────────

/** Si el error es un 429 del API, cuántos ms pide esperar (`details.retryAfterMs`); si no, null. */
export function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const { status, details } = error as { status?: unknown; details?: unknown };
  if (status !== 429) return null;
  const ms = (details as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : 4_000;
}

/** Códigos con los que el API dice que esta petición no se repetirá igual (no insistir con ella). */
export function isClientRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}

/**
 * Controla cuándo se puede mandar la siguiente posición: un solo envío a la vez, separación mínima,
 * 429 con `retryAfterMs` del servidor y espera creciente (hasta 60 s) cuando falla la red.
 */
export function createSendGate(opts: { minGapMs?: number; maxBackoffMs?: number } = {}) {
  const minGap = opts.minGapMs ?? MIN_SEND_GAP_MS;
  const maxBackoff = opts.maxBackoffMs ?? 60_000;
  let nextAllowedAt = 0;
  let inFlight = false;
  let failures = 0;
  return {
    canSend(now: number): boolean {
      return !inFlight && now >= nextAllowedAt;
    },
    begin(now: number): void {
      inFlight = true;
      nextAllowedAt = now + minGap;
    },
    succeed(): void {
      inFlight = false;
      failures = 0;
    },
    fail(now: number, error?: unknown): void {
      inFlight = false;
      const wait = retryAfterMs(error);
      if (wait !== null) {
        // El servidor manda: no se cuenta como fallo de red.
        nextAllowedAt = Math.max(nextAllowedAt, now + wait);
        return;
      }
      failures += 1;
      nextAllowedAt = Math.max(nextAllowedAt, now + Math.min(minGap * 2 ** failures, maxBackoff));
    },
    /** Para pruebas y para la interfaz. */
    get nextAllowedAt() {
      return nextAllowedAt;
    },
    get failures() {
      return failures;
    },
  };
}
