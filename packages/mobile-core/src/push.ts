/**
 * Notificaciones push de las apps (cliente y repartidor).
 *
 *   const reg = usePushRegistration();           // en el layout raíz: registra el teléfono con sesión
 *   configureNotificationHandling({ onOrderOpened: (id) => router.push(...) });  // en un useEffect
 *
 * Cierra sesión sin hacer nada especial: `usePushRegistration` da de baja el teléfono en cuanto el
 * token de sesión desaparece (con el token anterior, que aún vale en el servidor).
 *
 * Todo es tolerante a fallos y nunca lanza. En web, simuladores y builds sin `EAS_PROJECT_ID` no
 * hace nada. La lógica (y sus pruebas) vive en `push-core.ts`.
 */
import Constants from 'expo-constants';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { api } from './api';
import {
  type NotificationsLike,
  type PushRegistration,
  registerPushDeviceWith,
  retryDelayMs,
  shouldRegisterOnForeground,
  startNotificationHandling,
  unregisterPushDeviceWith,
} from './push-core';
import { useSession } from './session';
import { secureStorage } from './storage';

const TOKEN_KEY = 'jellyfish.pushToken';

/** ID del proyecto de EAS (lo escribe app.config.ts en `extra.eas.projectId` si hay EAS_PROJECT_ID). */
function resolveProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const fromExtra = extra?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra) return fromExtra;
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === 'string' && fromEas ? fromEas : null;
}

let notificationsPromise: Promise<NotificationsLike | null> | null = null;
/** Carga expo-notifications solo cuando hace falta (nunca en web) y sin romper si falta. */
function loadNotifications(): Promise<NotificationsLike | null> {
  if (Platform.OS === 'web') return Promise.resolve(null);
  notificationsPromise ??= import('expo-notifications')
    .then((m): NotificationsLike => m)
    .catch(() => null);
  return notificationsPromise;
}

async function isRealDevice(): Promise<boolean> {
  try {
    const Device = await import('expo-device');
    return Device.isDevice;
  } catch {
    return false;
  }
}

async function register(prompt: boolean): Promise<PushRegistration> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return { status: 'unsupported' };
  const isDevice = await isRealDevice();
  return registerPushDeviceWith(
    {
      os: Platform.OS,
      isDevice,
      projectId: resolveProjectId(),
      loadNotifications,
      postDevice: (body) => api('/v1/me/devices', { method: 'POST', body, silent401: true }),
      saveToken: (token) => secureStorage.set(TOKEN_KEY, token),
    },
    { prompt },
  );
}

/**
 * Pide permiso (si falta), obtiene el token de Expo y lo registra en el API.
 * Devuelve el token, o null si no aplica (web, simulador, sin projectId, permiso negado, sin red).
 * Nunca lanza.
 */
export async function registerPushDevice(): Promise<string | null> {
  const r = await register(true);
  return r.status === 'registered' ? r.token : null;
}

/**
 * Da de baja este teléfono (al cerrar sesión). `authToken` permite hacerlo con la sesión que se
 * está cerrando aunque ya se haya borrado del dispositivo. Nunca lanza.
 */
export function unregisterPushDevice(opts: { authToken?: string } = {}): Promise<boolean> {
  return unregisterPushDeviceWith(
    {
      loadToken: () => secureStorage.get(TOKEN_KEY),
      clearToken: () => secureStorage.remove(TOKEN_KEY),
      deleteDevice: (token, authToken) =>
        api(`/v1/me/devices/${encodeURIComponent(token)}`, {
          method: 'DELETE',
          silent401: true,
          ...(authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : {}),
        }),
    },
    opts.authToken,
  );
}

/**
 * Banner en primer plano y toque en la notificación. `onOrderOpened` recibe el id del pedido de
 * `data` ({type:'order', orderId}); también se llama con la notificación que abrió la app cerrada.
 * Devuelve la función para apagarlo (úsala como retorno de un useEffect). Nunca lanza.
 */
export function configureNotificationHandling(opts: {
  onOrderOpened: (orderId: string) => void;
}): () => void {
  let disposed = false;
  let stop: (() => void) | null = null;
  void (async () => {
    try {
      const N = await loadNotifications();
      if (!N || disposed) return;
      const off = await startNotificationHandling(N, opts.onOrderOpened);
      if (disposed) off();
      else stop = off;
    } catch {
      /* sin notificaciones: la app funciona igual */
    }
  })();
  return () => {
    disposed = true;
    stop?.();
    stop = null;
  };
}

/**
 * Registra el teléfono mientras haya sesión: al iniciar sesión, al volver a la app cada 6 h o
 * tras un fallo, y con reintentos suaves si falla la red. Al cerrar sesión (token → null) da de
 * baja el teléfono. Poner UNA vez, en el layout raíz.
 */
export function usePushRegistration(): void {
  const token = useSession((s) => s.token);

  // Baja: observa el almacén de sesión, no el árbol de React, para no perder el token anterior.
  useEffect(() => {
    return useSession.subscribe((state, prev) => {
      if (prev.token && !state.token) void unregisterPushDevice({ authToken: prev.token });
    });
  }, []);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let running = false;
    const last = {
      lastOkAt: null as number | null,
      lastAttemptAt: null as number | null,
      lastStatus: null as PushRegistration['status'] | null,
    };

    const attempt = async (prompt: boolean) => {
      if (running || cancelled) return;
      running = true;
      last.lastAttemptAt = Date.now();
      try {
        const r = await register(prompt);
        if (cancelled) return;
        last.lastStatus = r.status;
        if (r.status === 'registered') {
          last.lastOkAt = Date.now();
          failures = 0;
        } else if (r.status === 'error') {
          failures += 1;
          const wait = retryDelayMs(failures);
          if (wait !== null) timer = setTimeout(() => void attempt(false), wait);
        }
      } finally {
        running = false;
      }
    };

    void attempt(true);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (shouldRegisterOnForeground({ now: Date.now(), ...last })) void attempt(false);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [token]);
}
