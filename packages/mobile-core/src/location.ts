/**
 * Ubicación en primer plano (expo-location): permiso con textos en español, lectura puntual con
 * tiempo límite y un seguidor que va mandando la posición mientras la app está abierta.
 *
 * Solo primer plano a propósito: no se pide ubicación en segundo plano (ver app.config.ts). La
 * lógica sin dependencias de React Native está en `location-core.ts`, con sus pruebas.
 */
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import {
  BROADCAST_INTERVAL_MS,
  type GeoFix,
  LOCATION_MESSAGES,
  LocationError,
  type LocationPermissionState,
  MAX_FIX_AGE_MS,
  POSITION_TIMEOUT_MS,
  WATCH_DISTANCE_INTERVAL_M,
  WATCH_TIME_INTERVAL_MS,
  createSendGate,
  fixFromExpo,
  isReportable,
  permissionMessage,
  permissionStateFrom,
  retryAfterMs,
  withTimeout,
} from './location-core';

/** Estado del permiso SIN preguntar nada. */
export async function getForegroundLocationPermission(): Promise<LocationPermissionState> {
  try {
    return permissionStateFrom(await Location.getForegroundPermissionsAsync());
  } catch {
    return 'undetermined';
  }
}

export interface PermissionResult {
  state: LocationPermissionState;
  granted: boolean;
  /** Texto en español para mostrar cuando no se concedió; null si está concedido. */
  message: string | null;
}

/**
 * Pide el permiso de ubicación (solo mientras la app está abierta) si hace falta y todavía se
 * puede preguntar. Muestra antes tu propia explicación: el diálogo del sistema aparece una vez.
 */
export async function ensureForegroundLocationPermission(): Promise<PermissionResult> {
  let state: LocationPermissionState;
  try {
    let r = await Location.getForegroundPermissionsAsync();
    if (!r.granted && r.canAskAgain !== false)
      r = await Location.requestForegroundPermissionsAsync();
    state = permissionStateFrom(r);
  } catch {
    state = 'denied';
  }
  return { state, granted: state === 'granted', message: permissionMessage(state) };
}

/** Abre los Ajustes de la app (donde se activa un permiso que se negó para siempre). */
export function openAppSettings(): void {
  void Linking.openSettings().catch(() => {});
}

/**
 * Lee la posición una vez (precisión balanceada). Falla con `LocationError`
 * ('permission' | 'timeout' | 'unavailable') y mensaje en español si no hay permiso, el GPS no
 * responde a tiempo o está apagado.
 */
export async function getCurrentPosition(opts: { timeoutMs?: number } = {}): Promise<GeoFix> {
  if ((await getForegroundLocationPermission()) !== 'granted') {
    throw new LocationError('permission', LOCATION_MESSAGES.permission);
  }
  try {
    const loc = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      opts.timeoutMs ?? POSITION_TIMEOUT_MS,
    );
    return fixFromExpo(loc);
  } catch (e) {
    if (e instanceof LocationError) throw e;
    throw new LocationError('unavailable', LOCATION_MESSAGES.unavailable);
  }
}

// ───────────── Seguidor ─────────────

export type BroadcastStatus =
  /** Apagado (nada que compartir). */
  | 'off'
  | 'starting'
  /** Mandando la posición con normalidad. */
  | 'active'
  /** Falta el permiso (nunca se preguntó o se negó, pero se puede volver a preguntar). */
  | 'needs_permission'
  /** Permiso negado para siempre: solo se arregla en Ajustes. */
  | 'blocked'
  /** El GPS dice que estás fuera de República Dominicana: no se manda. */
  | 'outside'
  /** El GPS o el API no responden; se sigue intentando. */
  | 'unavailable';

export interface LocationBroadcastState {
  status: BroadcastStatus;
  permission: LocationPermissionState;
  /** Cuándo (ms) se confirmó el último envío al servidor. */
  lastSentAt: number | null;
  /** Último problema, en español (null si no hay). */
  error: string | null;
  /** Vuelve a leer el permiso sin preguntar (p. ej. después de volver de Ajustes). */
  recheckPermission: () => Promise<LocationPermissionState>;
  /** Pide el permiso si todavía se puede y actualiza el estado. */
  requestPermission: () => Promise<PermissionResult>;
}

/**
 * Mientras `enabled` y haya permiso, manda la posición con `send` cada ~15 s (o cada 25 m), nunca
 * más seguido que el límite del servidor y respetando el `retryAfterMs` de un 429. Se detiene al
 * apagarlo, al cerrar la pantalla o al perder el permiso. `send` puede cambiar entre renders sin
 * reiniciar el seguidor.
 */
export function useLocationBroadcast({
  enabled,
  send,
  intervalMs = BROADCAST_INTERVAL_MS,
}: {
  enabled: boolean;
  send: (fix: GeoFix) => Promise<unknown>;
  intervalMs?: number;
}): LocationBroadcastState {
  const [permission, setPermission] = useState<LocationPermissionState>('unknown');
  const [runtime, setRuntime] = useState<{
    status: 'starting' | 'active' | 'outside' | 'unavailable';
    error: string | null;
  }>({ status: 'starting', error: null });
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  // La puerta de envíos vive con el hook, no con cada arranque del seguidor: si se apaga y se
  // vuelve a prender enseguida (se entregó un pedido y salió otro), el límite entre envíos se respeta.
  const gateRef = useRef(createSendGate());

  const recheckPermission = useCallback(async () => {
    const state = await getForegroundLocationPermission();
    setPermission(state);
    return state;
  }, []);

  const requestPermission = useCallback(async () => {
    const result = await ensureForegroundLocationPermission();
    setPermission(result.state);
    return result;
  }, []);

  // El permiso se revisa al montar y cada vez que la app vuelve al frente (p. ej. desde Ajustes).
  useEffect(() => {
    void recheckPermission();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void recheckPermission();
    });
    return () => sub.remove();
  }, [recheckPermission]);

  useEffect(() => {
    if (!enabled) {
      setRuntime({ status: 'starting', error: null });
      setLastSentAt(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || permission !== 'granted') return;
    let cancelled = false;
    const gate = gateRef.current;
    let latest: GeoFix | null = null;
    let lastAttemptAt = 0;
    let watch: Location.LocationSubscription | null = null;

    const push = async (fix: GeoFix) => {
      latest = fix;
      if (cancelled) return;
      if (!isReportable(fix)) {
        setRuntime({ status: 'outside', error: null });
        return;
      }
      const now = Date.now();
      if (!gate.canSend(now)) return;
      gate.begin(now);
      lastAttemptAt = now;
      try {
        await sendRef.current(fix);
        gate.succeed();
        if (cancelled) return;
        setLastSentAt(Date.now());
        setRuntime({ status: 'active', error: null });
      } catch (e) {
        gate.fail(Date.now(), e);
        if (cancelled || retryAfterMs(e) !== null) return; // 429: el servidor pide esperar
        setRuntime({
          status: 'unavailable',
          error: e instanceof Error && e.message ? e.message : LOCATION_MESSAGES.unavailable,
        });
      }
    };

    const readAndPush = async () => {
      try {
        const fix = await getCurrentPosition({ timeoutMs: POSITION_TIMEOUT_MS });
        await push(fix);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof LocationError && e.code !== 'permission') {
          setRuntime({ status: 'unavailable', error: e.message });
        }
      }
    };

    setRuntime({ status: 'starting', error: null });
    void (async () => {
      try {
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: WATCH_TIME_INTERVAL_MS,
            distanceInterval: WATCH_DISTANCE_INTERVAL_M,
          },
          (loc) => void push(fixFromExpo(loc)),
          () => {
            if (!cancelled)
              setRuntime({ status: 'unavailable', error: LOCATION_MESSAGES.unavailable });
          },
        );
        if (cancelled) sub.remove();
        else watch = sub;
      } catch {
        if (!cancelled) setRuntime({ status: 'unavailable', error: LOCATION_MESSAGES.unavailable });
      }
    })();

    // Primera lectura inmediata (el seguidor puede tardar en dar la primera) y latido de respaldo:
    // iOS solo avisa si te moviste 25 m, y un repartidor parado no debe verse "sin señal".
    void readAndPush();
    const heartbeat = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      if (now - lastAttemptAt < intervalMs - 1_000) return;
      if (latest && now - latest.timestamp < Math.min(MAX_FIX_AGE_MS, intervalMs / 2)) {
        void push(latest);
      } else {
        void readAndPush();
      }
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      watch?.remove();
      watch = null;
    };
  }, [enabled, permission, intervalMs]);

  const status: BroadcastStatus = !enabled
    ? 'off'
    : permission === 'granted'
      ? runtime.status
      : permission === 'blocked'
        ? 'blocked'
        : permission === 'unknown'
          ? 'starting'
          : 'needs_permission';

  return {
    status,
    permission,
    lastSentAt,
    error: status === 'unavailable' || status === 'outside' ? runtime.error : null,
    recheckPermission,
    requestPermission,
  };
}
