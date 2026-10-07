import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_ACTION,
  FOREGROUND_BEHAVIOR,
  ORDER_CHANNEL_ID,
  type NotificationResponseLike,
  type NotificationsLike,
  type PermissionLike,
  type PushEnv,
  createResponseHandler,
  isExpoPushTokenShape,
  parseOrderPushData,
  registerPushDeviceWith,
  retryDelayMs,
  shouldRegisterOnForeground,
  startNotificationHandling,
  unregisterPushDeviceWith,
} from '../src/push-core';

const TOKEN = 'ExponentPushToken[abcDEF123_-xyz]';
const ORDER = '5f1c1b2e-0a8e-4d55-9c1f-2f3f4a5b6c7d';

function fakeNotifications(over: Partial<NotificationsLike> = {}): NotificationsLike {
  return {
    getPermissionsAsync: vi.fn(async (): Promise<PermissionLike> => ({ granted: true })),
    requestPermissionsAsync: vi.fn(async (): Promise<PermissionLike> => ({ granted: true })),
    getExpoPushTokenAsync: vi.fn(async () => ({ data: TOKEN })),
    setNotificationChannelAsync: vi.fn(async () => null),
    setNotificationHandler: vi.fn(),
    addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
    getLastNotificationResponseAsync: vi.fn(async () => null),
    AndroidImportance: { HIGH: 6 },
    ...over,
  };
}

function env(N: NotificationsLike | null, over: Partial<PushEnv> = {}): PushEnv {
  return {
    os: 'android',
    isDevice: true,
    projectId: 'proj-1',
    loadNotifications: async () => N,
    postDevice: vi.fn(async () => ({})),
    saveToken: vi.fn(async () => {}),
    ...over,
  };
}

const response = (
  data: unknown,
  id = 'n1',
  actionIdentifier?: string,
): NotificationResponseLike => ({
  ...(actionIdentifier !== undefined ? { actionIdentifier } : {}),
  notification: { request: { identifier: id, content: { data } } },
});

describe('parseOrderPushData', () => {
  it('lee {type:"order", orderId}', () => {
    expect(parseOrderPushData({ type: 'order', orderId: ORDER })).toBe(ORDER);
  });
  it('ignora otros tipos, formas raras y ids con caracteres peligrosos', () => {
    expect(parseOrderPushData({ type: 'promo', orderId: ORDER })).toBeNull();
    expect(parseOrderPushData({ type: 'order' })).toBeNull();
    expect(parseOrderPushData({ type: 'order', orderId: 42 })).toBeNull();
    expect(parseOrderPushData({ type: 'order', orderId: '../admin?x=1' })).toBeNull();
    expect(parseOrderPushData({ type: 'order', orderId: '' })).toBeNull();
    expect(parseOrderPushData(null)).toBeNull();
    expect(parseOrderPushData('order')).toBeNull();
  });
});

describe('isExpoPushTokenShape', () => {
  it('acepta las dos formas del token de Expo', () => {
    expect(isExpoPushTokenShape('ExponentPushToken[abc]')).toBe(true);
    expect(isExpoPushTokenShape('ExpoPushToken[abc]')).toBe(true);
  });
  it('rechaza lo demás', () => {
    expect(isExpoPushTokenShape('abc')).toBe(false);
    expect(isExpoPushTokenShape('ExponentPushToken[]')).toBe(false);
    expect(isExpoPushTokenShape(undefined)).toBe(false);
  });
});

describe('registerPushDeviceWith', () => {
  it('Android: crea el canal "pedidos" de importancia alta con vibración y registra el token', async () => {
    const N = fakeNotifications();
    const e = env(N);
    const r = await registerPushDeviceWith(e);
    expect(r).toEqual({ status: 'registered', token: TOKEN });
    expect(N.setNotificationChannelAsync).toHaveBeenCalledWith(
      ORDER_CHANNEL_ID,
      expect.objectContaining({ name: 'Pedidos', importance: 6, enableVibrate: true }),
    );
    expect(N.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(e.postDevice).toHaveBeenCalledWith({ token: TOKEN, platform: 'android' });
    expect(e.saveToken).toHaveBeenCalledWith(TOKEN);
  });

  it('el canal se crea ANTES de pedir el permiso (Android 13+)', async () => {
    const order: string[] = [];
    const N = fakeNotifications({
      setNotificationChannelAsync: vi.fn(async () => void order.push('canal')),
      getPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true })),
      requestPermissionsAsync: vi.fn(async () => {
        order.push('permiso');
        return { granted: true };
      }),
    });
    await registerPushDeviceWith(env(N));
    expect(order).toEqual(['canal', 'permiso']);
  });

  it('iOS: no crea canal y manda platform ios', async () => {
    const N = fakeNotifications();
    const e = env(N, { os: 'ios' });
    expect((await registerPushDeviceWith(e)).status).toBe('registered');
    expect(N.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(e.postDevice).toHaveBeenCalledWith({ token: TOKEN, platform: 'ios' });
  });

  it('no pregunta de nuevo si el permiso ya estaba concedido', async () => {
    const N = fakeNotifications();
    await registerPushDeviceWith(env(N));
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('web, simulador y sin projectId devuelven un estado sin tocar nada ni lanzar', async () => {
    const N = fakeNotifications();
    expect(await registerPushDeviceWith(env(N, { os: 'web' }))).toEqual({ status: 'unsupported' });
    expect(await registerPushDeviceWith(env(N, { isDevice: false }))).toEqual({
      status: 'unsupported',
    });
    expect(await registerPushDeviceWith(env(N, { projectId: undefined }))).toEqual({
      status: 'no_project',
    });
    expect(await registerPushDeviceWith(env(null))).toEqual({ status: 'unsupported' });
    expect(N.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it('permiso negado: no pide token ni llama al API', async () => {
    const N = fakeNotifications({
      getPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true })),
      requestPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: false })),
    });
    const e = env(N);
    expect(await registerPushDeviceWith(e)).toEqual({ status: 'denied', canAskAgain: false });
    expect(N.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(e.postDevice).not.toHaveBeenCalled();
  });

  it('con prompt:false no muestra el diálogo del sistema', async () => {
    const N = fakeNotifications({
      getPermissionsAsync: vi.fn(async () => ({ granted: false, canAskAgain: true })),
    });
    const r = await registerPushDeviceWith(env(N), { prompt: false });
    expect(r.status).toBe('denied');
    expect(N.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('un fallo al crear el canal no impide registrar', async () => {
    const N = fakeNotifications({
      setNotificationChannelAsync: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    expect((await registerPushDeviceWith(env(N))).status).toBe('registered');
  });

  it('errores de red o del API vuelven como status "error", nunca lanzan', async () => {
    const N = fakeNotifications();
    const r = await registerPushDeviceWith(
      env(N, {
        postDevice: async () => {
          throw new Error('sin red');
        },
      }),
    );
    expect(r).toEqual({ status: 'error', message: 'sin red' });
    const r2 = await registerPushDeviceWith(
      env(
        fakeNotifications({
          getExpoPushTokenAsync: async () => {
            throw new Error('ERR_NOTIFICATIONS_NO_EXPERIENCE_ID');
          },
        }),
      ),
    );
    expect(r2.status).toBe('error');
  });

  it('descarta un token con forma rara (no lo manda al API)', async () => {
    const N = fakeNotifications({ getExpoPushTokenAsync: async () => ({ data: 'no-es-token' }) });
    const e = env(N);
    expect((await registerPushDeviceWith(e)).status).toBe('error');
    expect(e.postDevice).not.toHaveBeenCalled();
  });
});

describe('unregisterPushDeviceWith', () => {
  it('borra el token del API (con la sesión que se cierra) y del teléfono', async () => {
    const deleteDevice = vi.fn(async () => {});
    const clearToken = vi.fn(async () => {});
    const ok = await unregisterPushDeviceWith(
      { loadToken: async () => TOKEN, clearToken, deleteDevice },
      'sesion-vieja',
    );
    expect(ok).toBe(true);
    expect(deleteDevice).toHaveBeenCalledWith(TOKEN, 'sesion-vieja');
    expect(clearToken).toHaveBeenCalled();
  });
  it('sin token guardado no llama al API', async () => {
    const deleteDevice = vi.fn();
    const ok = await unregisterPushDeviceWith({
      loadToken: async () => null,
      clearToken: async () => {},
      deleteDevice,
    });
    expect(ok).toBe(false);
    expect(deleteDevice).not.toHaveBeenCalled();
  });
  it('si falla la red igual limpia el token local y no lanza', async () => {
    const clearToken = vi.fn(async () => {});
    const ok = await unregisterPushDeviceWith({
      loadToken: async () => TOKEN,
      clearToken,
      deleteDevice: async () => {
        throw new Error('sin red');
      },
    });
    expect(ok).toBe(false);
    expect(clearToken).toHaveBeenCalled();
  });
});

describe('createResponseHandler', () => {
  it('abre el pedido al tocar la notificación', () => {
    const open = vi.fn();
    const h = createResponseHandler(open);
    expect(h(response({ type: 'order', orderId: ORDER }, 'a', DEFAULT_NOTIFICATION_ACTION))).toBe(
      true,
    );
    expect(open).toHaveBeenCalledWith(ORDER);
  });
  it('no repite la misma notificación (listener + última respuesta)', () => {
    const open = vi.fn();
    const h = createResponseHandler(open);
    h(response({ type: 'order', orderId: ORDER }, 'a'));
    h(response({ type: 'order', orderId: ORDER }, 'a'));
    expect(open).toHaveBeenCalledTimes(1);
    h(response({ type: 'order', orderId: ORDER }, 'b'));
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('ignora descartes, notificaciones que no son de pedido y respuestas rotas', () => {
    const open = vi.fn();
    const h = createResponseHandler(open);
    h(
      response(
        { type: 'order', orderId: ORDER },
        'c',
        'expo.modules.notifications.actions.DISMISSAL',
      ),
    );
    h(response({ type: 'promo' }, 'd'));
    h(null);
    h({} as NotificationResponseLike);
    expect(open).not.toHaveBeenCalled();
  });
  it('un error dentro de onOrderOpened no se propaga', () => {
    const h = createResponseHandler(() => {
      throw new Error('router no listo');
    });
    expect(() => h(response({ type: 'order', orderId: ORDER }))).not.toThrow();
  });
});

describe('startNotificationHandling', () => {
  it('muestra banner en primer plano y atiende toques', async () => {
    const open = vi.fn();
    let listener: ((r: NotificationResponseLike) => void) | undefined;
    const remove = vi.fn();
    const N = fakeNotifications({
      addNotificationResponseReceivedListener: vi.fn((l) => {
        listener = l;
        return { remove };
      }),
    });
    const stop = await startNotificationHandling(N, open);

    const call = vi.mocked(N.setNotificationHandler).mock.calls[0]?.[0];
    expect(await call?.handleNotification()).toEqual(FOREGROUND_BEHAVIOR);
    expect(FOREGROUND_BEHAVIOR.shouldShowBanner).toBe(true);

    listener?.(response({ type: 'order', orderId: ORDER }, 'x'));
    expect(open).toHaveBeenCalledWith(ORDER);
    stop();
    expect(remove).toHaveBeenCalled();
  });
  it('atiende la notificación que abrió la app cerrada', async () => {
    const open = vi.fn();
    const N = fakeNotifications({
      getLastNotificationResponseAsync: async () =>
        response({ type: 'order', orderId: ORDER }, 'frio'),
    });
    await startNotificationHandling(N, open);
    expect(open).toHaveBeenCalledWith(ORDER);
  });
  it('tolera una API rota sin lanzar', async () => {
    const N = fakeNotifications({
      setNotificationHandler: () => {
        throw new Error('x');
      },
      addNotificationResponseReceivedListener: () => {
        throw new Error('y');
      },
      getLastNotificationResponseAsync: async () => {
        throw new Error('z');
      },
    });
    await expect(startNotificationHandling(N, vi.fn())).resolves.toBeTypeOf('function');
  });
});

describe('reintentos y refresco', () => {
  it('retryDelayMs: 30 s, 2 min, 10 min y luego se rinde', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(600_000);
    expect(retryDelayMs(4)).toBeNull();
  });
  const base = { now: 10 * 3_600_000, lastOkAt: null, lastAttemptAt: null, lastStatus: null };
  it('al volver a la app: refresca tras 6 h, no antes', () => {
    expect(shouldRegisterOnForeground({ ...base, lastOkAt: base.now - 1000 })).toBe(false);
    expect(shouldRegisterOnForeground({ ...base, lastOkAt: base.now - 6 * 3_600_000 })).toBe(true);
  });
  it('sin registro previo reintenta, pero no en ráfaga ni si no aplica', () => {
    expect(shouldRegisterOnForeground(base)).toBe(true);
    expect(shouldRegisterOnForeground({ ...base, lastAttemptAt: base.now - 5_000 })).toBe(false);
    expect(shouldRegisterOnForeground({ ...base, lastStatus: 'unsupported' })).toBe(false);
    expect(shouldRegisterOnForeground({ ...base, lastStatus: 'no_project' })).toBe(false);
  });
});
