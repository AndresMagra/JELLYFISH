/**
 * Lógica de las notificaciones push SIN dependencias de React Native ni de Expo: todo lo que toca
 * el teléfono entra por interfaces pequeñas (`NotificationsLike`, `PushEnv`). Así se prueba con
 * Vitest en Node con una API de expo-notifications simulada. `push.ts` conecta esto con lo real.
 *
 * Regla de oro: nada de aquí debe poder romper el inicio de la app. Las funciones públicas
 * atrapan todo y devuelven un resultado; nunca lanzan.
 */
import type { DevicePlatformName, RegisterDeviceInput } from '@jellyfish/shared';

/** Canal de Android para avisos de pedidos (importancia alta: suena, vibra y sale como banner). */
export const ORDER_CHANNEL_ID = 'pedidos';

/** Identificador de la acción "tocar la notificación" (sin botones) en expo-notifications. */
export const DEFAULT_NOTIFICATION_ACTION = 'expo.modules.notifications.actions.DEFAULT';

// ───────────── Interfaces mínimas de expo-notifications ─────────────

export interface PermissionLike {
  granted: boolean;
  canAskAgain?: boolean;
  status?: string;
}

export interface ChannelConfigLike {
  name: string;
  importance: number;
  vibrationPattern?: number[];
  lightColor?: string;
  sound?: string | null;
  enableVibrate?: boolean;
  showBadge?: boolean;
}

export interface NotificationResponseLike {
  actionIdentifier?: string;
  notification: { request: { identifier: string; content: { data?: unknown } } };
}

export interface NotificationBehaviorLike {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

export interface NotificationsLike {
  getPermissionsAsync(): Promise<PermissionLike>;
  requestPermissionsAsync(request?: {
    ios?: { allowAlert?: boolean; allowBadge?: boolean; allowSound?: boolean };
  }): Promise<PermissionLike>;
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>;
  setNotificationChannelAsync(id: string, config: ChannelConfigLike): Promise<unknown>;
  setNotificationHandler(
    handler: { handleNotification: () => Promise<NotificationBehaviorLike> } | null,
  ): void;
  addNotificationResponseReceivedListener(listener: (r: NotificationResponseLike) => void): {
    remove(): void;
  };
  getLastNotificationResponseAsync(): Promise<NotificationResponseLike | null>;
  AndroidImportance: { HIGH: number };
}

// ───────────── Datos de la notificación ─────────────

/**
 * Saca el id del pedido de `data` de una notificación `{type:'order', orderId}`. Devuelve null si
 * no es de pedido o el id no tiene forma de id (no se navega con texto arbitrario).
 */
export function parseOrderPushData(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const { type, orderId } = data as { type?: unknown; orderId?: unknown };
  if (type !== 'order' || typeof orderId !== 'string') return null;
  return /^[A-Za-z0-9_-]{1,64}$/.test(orderId) ? orderId : null;
}

/** ¿Tiene forma de token de Expo? (el API valida lo mismo: ExponentPushToken[…] o ExpoPushToken[…]) */
export function isExpoPushTokenShape(token: unknown): token is string {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(token);
}

/** Cómo se muestra una notificación mientras la app está abierta: banner, lista y sonido. */
export const FOREGROUND_BEHAVIOR: NotificationBehaviorLike = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

/**
 * Crea el manejador de toques: llama `onOrderOpened(orderId)` una sola vez por notificación (la
 * misma respuesta puede llegar por el listener y por `getLastNotificationResponseAsync`) y solo
 * si la persona tocó la notificación (no si la descartó) y es de un pedido.
 */
export function createResponseHandler(onOrderOpened: (orderId: string) => void) {
  const seen: string[] = [];
  return (response: NotificationResponseLike | null | undefined): boolean => {
    try {
      if (!response) return false;
      const action = response.actionIdentifier;
      if (action !== undefined && action !== DEFAULT_NOTIFICATION_ACTION) return false;
      const request = response.notification.request;
      const orderId = parseOrderPushData(request.content.data);
      if (!orderId) return false;
      if (seen.includes(request.identifier)) return false;
      seen.push(request.identifier);
      if (seen.length > 30) seen.shift();
      onOrderOpened(orderId);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Activa el banner en primer plano y el toque en notificaciones (también la que abrió la app
 * estando cerrada). Devuelve cómo apagarlo. Nunca lanza.
 */
export async function startNotificationHandling(
  N: NotificationsLike,
  onOrderOpened: (orderId: string) => void,
): Promise<() => void> {
  const handle = createResponseHandler(onOrderOpened);
  let subscription: { remove(): void } | null = null;
  try {
    N.setNotificationHandler({ handleNotification: async () => FOREGROUND_BEHAVIOR });
  } catch {
    /* sin banner en primer plano, pero las notificaciones siguen llegando */
  }
  try {
    subscription = N.addNotificationResponseReceivedListener((r) => void handle(r));
  } catch {
    /* sin listener: tocar la notificación solo abre la app */
  }
  try {
    handle(await N.getLastNotificationResponseAsync());
  } catch {
    /* no hay notificación pendiente */
  }
  return () => {
    try {
      subscription?.remove();
    } catch {
      /* ya estaba quitado */
    }
  };
}

// ───────────── Registro del dispositivo ─────────────

export interface PushEnv {
  /** `Platform.OS` */
  os: string;
  /** `Device.isDevice`: false en simuladores y emuladores. */
  isDevice: boolean;
  /** `Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId` */
  projectId: string | null | undefined;
  loadNotifications(): Promise<NotificationsLike | null>;
  /** POST /v1/me/devices con el cliente del API. */
  postDevice(body: RegisterDeviceInput): Promise<unknown>;
  /** Último token registrado (para poder darlo de baja al cerrar sesión, incluso tras reiniciar). */
  saveToken(token: string): Promise<void>;
}

export type PushRegistration =
  | { status: 'registered'; token: string }
  /** Web, simulador o librería nativa ausente: no hay nada que registrar. */
  | { status: 'unsupported' }
  /** Falta el projectId de EAS (builds sin `EAS_PROJECT_ID`): sin push remotas. */
  | { status: 'no_project' }
  | { status: 'denied'; canAskAgain: boolean }
  /** Falló la red o el API: vale la pena reintentar. */
  | { status: 'error'; message: string };

/**
 * Pide permiso, obtiene el token de Expo y lo manda al API. Nunca lanza: todo problema vuelve como
 * un `status`. Orden: canal de Android ANTES del permiso (Android 13+ lo exige para poder preguntar).
 * Con `prompt: false` no muestra el diálogo del sistema (solo registra si ya hay permiso).
 */
export async function registerPushDeviceWith(
  env: PushEnv,
  options: { prompt?: boolean } = {},
): Promise<PushRegistration> {
  const prompt = options.prompt ?? true;
  try {
    if (env.os !== 'ios' && env.os !== 'android') return { status: 'unsupported' };
    if (!env.isDevice) return { status: 'unsupported' };
    if (!env.projectId) return { status: 'no_project' };

    const N = await env.loadNotifications();
    if (!N) return { status: 'unsupported' };

    if (env.os === 'android') {
      try {
        await N.setNotificationChannelAsync(ORDER_CHANNEL_ID, {
          name: 'Pedidos',
          importance: N.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF6B8A',
          sound: 'default',
          enableVibrate: true,
          showBadge: true,
        });
      } catch {
        /* sin canal propio se usa el canal por defecto */
      }
    }

    let permission = await N.getPermissionsAsync();
    if (!permission.granted && prompt && permission.canAskAgain !== false) {
      permission = await N.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      });
    }
    if (!permission.granted) {
      return { status: 'denied', canAskAgain: permission.canAskAgain !== false };
    }

    const { data: token } = await N.getExpoPushTokenAsync({ projectId: env.projectId });
    if (!isExpoPushTokenShape(token)) return { status: 'error', message: 'Token inválido' };

    await env.postDevice({ token, platform: env.os as DevicePlatformName });
    await env.saveToken(token).catch(() => {});
    return { status: 'registered', token };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Error desconocido' };
  }
}

export interface UnregisterEnv {
  loadToken(): Promise<string | null>;
  clearToken(): Promise<void>;
  /** DELETE /v1/me/devices/:token; `authToken` fuerza la sesión (la que se está cerrando). */
  deleteDevice(token: string, authToken?: string): Promise<unknown>;
}

/** Da de baja este teléfono en el API. Siempre borra el token guardado; nunca lanza. */
export async function unregisterPushDeviceWith(
  env: UnregisterEnv,
  authToken?: string,
): Promise<boolean> {
  let ok = false;
  try {
    const token = await env.loadToken();
    if (token) {
      await env.deleteDevice(token, authToken);
      ok = true;
    }
  } catch {
    /* el API devuelve 204 aunque no exista; si no hubo red, el token muerto se limpia al enviar */
  }
  try {
    await env.clearToken();
  } catch {
    /* nada que borrar */
  }
  return ok;
}

// ───────────── Cuándo (re)registrar ─────────────

/** Tiempo de espera antes de reintentar tras un fallo transitorio; null = ya no insistir. */
export function retryDelayMs(failedAttempts: number): number | null {
  const steps = [30_000, 120_000, 600_000];
  return steps[failedAttempts - 1] ?? null;
}

/** Al volver a la app: refrescar si pasaron más de 6 h desde el último registro bueno. */
export const REFRESH_AFTER_MS = 6 * 3_600_000;

export function shouldRegisterOnForeground(s: {
  now: number;
  lastOkAt: number | null;
  lastAttemptAt: number | null;
  lastStatus: PushRegistration['status'] | null;
}): boolean {
  if (s.lastStatus === 'unsupported' || s.lastStatus === 'no_project') return false;
  // Evita ráfagas: nunca dos intentos con menos de 30 s de diferencia.
  if (s.lastAttemptAt !== null && s.now - s.lastAttemptAt < 30_000) return false;
  if (s.lastOkAt === null) return true;
  return s.now - s.lastOkAt >= REFRESH_AFTER_MS;
}
