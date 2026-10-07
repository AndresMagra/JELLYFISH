/**
 * Prueba del cableado real de push.ts (cliente del API, sesión, almacenamiento seguro) con
 * react-native, expo-constants, expo-secure-store, expo-device y expo-notifications simulados.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const secure = new Map<string, string>();
  const handlers: { response?: (r: unknown) => void } = {};
  const notifications = {
    getPermissionsAsync: vi.fn(async () => ({ granted: true })),
    requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
    getExpoPushTokenAsync: vi.fn(async (_o: { projectId: string }) => ({
      data: 'ExponentPushToken[abc123]',
    })),
    setNotificationChannelAsync: vi.fn(async () => null),
    setNotificationHandler: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn((l: (r: unknown) => void) => {
      handlers.response = l;
      return { remove: vi.fn() };
    }),
    getLastNotificationResponseAsync: vi.fn(async () => null),
    AndroidImportance: { HIGH: 6 },
  };
  return {
    secure,
    handlers,
    notifications,
    rn: {
      Platform: { OS: 'android' as string },
      AppState: { addEventListener: () => ({ remove() {} }) },
    },
    constants: {
      expoConfig: { extra: { eas: { projectId: 'proj-123' as string | undefined } } },
      easConfig: null as { projectId?: string } | null,
    },
    device: { isDevice: true },
  };
});

vi.mock('react-native', () => mocks.rn);
vi.mock('expo-constants', () => ({ default: mocks.constants }));
vi.mock('expo-device', () => mocks.device);
vi.mock('expo-notifications', () => mocks.notifications);
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mocks.secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mocks.secure.set(k, v),
  deleteItemAsync: async (k: string) => void mocks.secure.delete(k),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import { configureApi } from '../src/api';
import {
  configureNotificationHandling,
  registerPushDevice,
  unregisterPushDevice,
} from '../src/push';

const ORDER = '5f1c1b2e-0a8e-4d55-9c1f-2f3f4a5b6c7d';
const fetchMock = vi.fn();
const onUnauthorized = vi.fn();

function reply(status: number, body?: unknown) {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.secure.clear();
  mocks.rn.Platform.OS = 'android';
  mocks.constants.expoConfig.extra.eas.projectId = 'proj-123';
  mocks.constants.easConfig = null;
  mocks.device.isDevice = true;
  mocks.notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => reply(200, { token: 'x' }));
  vi.stubGlobal('fetch', fetchMock);
  configureApi({ baseUrl: 'http://api.test/', getToken: () => 'sesion-actual', onUnauthorized });
});

describe('registerPushDevice (cableado real)', () => {
  it('registra el token en POST /v1/me/devices con la sesión y la plataforma', async () => {
    const token = await registerPushDevice();
    expect(token).toBe('ExponentPushToken[abc123]');
    expect(mocks.notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'proj-123',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/v1/me/devices');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'ExponentPushToken[abc123]',
      platform: 'android',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sesion-actual');
    expect(mocks.secure.get('jellyfish.pushToken')).toBe('ExponentPushToken[abc123]');
  });

  it('usa el projectId de easConfig si no está en extra', async () => {
    mocks.constants.expoConfig.extra.eas.projectId = undefined;
    mocks.constants.easConfig = { projectId: 'desde-eas' };
    await registerPushDevice();
    expect(mocks.notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'desde-eas',
    });
  });

  it('sin projectId devuelve null sin pedir permiso ni llamar al API', async () => {
    mocks.constants.expoConfig.extra.eas.projectId = undefined;
    expect(await registerPushDevice()).toBeNull();
    expect(mocks.notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('en web o en un simulador devuelve null sin lanzar', async () => {
    mocks.rn.Platform.OS = 'web';
    expect(await registerPushDevice()).toBeNull();
    mocks.rn.Platform.OS = 'ios';
    mocks.device.isDevice = false;
    expect(await registerPushDevice()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('si el API o la red fallan devuelve null y no guarda el token', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    expect(await registerPushDevice()).toBeNull();
    fetchMock.mockImplementation(async () => reply(500, { error: { code: 'x', message: 'x' } }));
    expect(await registerPushDevice()).toBeNull();
    expect(mocks.secure.has('jellyfish.pushToken')).toBe(false);
  });

  it('un 401 al registrar no cierra la sesión (silent401)', async () => {
    fetchMock.mockImplementation(async () =>
      reply(401, { error: { code: 'unauthorized', message: 'x' } }),
    );
    expect(await registerPushDevice()).toBeNull();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('unregisterPushDevice', () => {
  it('manda DELETE con el token codificado y con la sesión que se cierra', async () => {
    await registerPushDevice();
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => reply(204));
    const ok = await unregisterPushDevice({ authToken: 'sesion-vieja' });
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/v1/me/devices/ExponentPushToken%5Babc123%5D');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sesion-vieja');
    expect(mocks.secure.has('jellyfish.pushToken')).toBe(false);
    // Una segunda baja ya no tiene nada que hacer.
    fetchMock.mockClear();
    expect(await unregisterPushDevice()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('un 401 (sesión ya vencida) no dispara cierre de sesión y el token local se limpia', async () => {
    await registerPushDevice();
    fetchMock.mockImplementation(async () =>
      reply(401, { error: { code: 'unauthorized', message: 'x' } }),
    );
    expect(await unregisterPushDevice({ authToken: 'vencida' })).toBe(false);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(mocks.secure.has('jellyfish.pushToken')).toBe(false);
  });
});

describe('configureNotificationHandling', () => {
  it('abre el pedido al tocar la notificación y se puede apagar', async () => {
    const open = vi.fn();
    const stop = configureNotificationHandling({ onOrderOpened: open });
    await vi.waitFor(() =>
      expect(mocks.notifications.addNotificationResponseReceivedListener).toHaveBeenCalled(),
    );
    expect(mocks.notifications.setNotificationHandler).toHaveBeenCalled();
    mocks.handlers.response?.({
      notification: {
        request: { identifier: 'n1', content: { data: { type: 'order', orderId: ORDER } } },
      },
    });
    expect(open).toHaveBeenCalledWith(ORDER);
    stop();
  });

  it('en web no toca expo-notifications', async () => {
    mocks.rn.Platform.OS = 'web';
    const stop = configureNotificationHandling({ onOrderOpened: vi.fn() });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.notifications.setNotificationHandler).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
