import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATION_MESSAGES,
  LocationError,
  MIN_SEND_GAP_MS,
  createSendGate,
  fixFromExpo,
  isClientRejection,
  isReportable,
  permissionMessage,
  permissionStateFrom,
  retryAfterMs,
  toLocationBody,
  withTimeout,
} from '../src/location-core';

describe('fixFromExpo / isReportable / toLocationBody', () => {
  it('normaliza la lectura del GPS', () => {
    expect(
      fixFromExpo({ coords: { latitude: 18.47, longitude: -69.93, accuracy: 12.6 }, timestamp: 5 }),
    ).toEqual({ latitude: 18.47, longitude: -69.93, accuracyM: 12.6, timestamp: 5 });
    expect(fixFromExpo({ coords: { latitude: 18.4, longitude: -69.9 } }, 99)).toEqual({
      latitude: 18.4,
      longitude: -69.9,
      accuracyM: null,
      timestamp: 99,
    });
  });
  it('solo reporta coordenadas dentro de República Dominicana', () => {
    expect(isReportable({ latitude: 18.4861, longitude: -69.9312 })).toBe(true); // Santo Domingo
    expect(isReportable({ latitude: 19.45, longitude: -70.69 })).toBe(true); // Santiago
    expect(isReportable({ latitude: 37.77, longitude: -122.42 })).toBe(false); // San Francisco
    expect(isReportable({ latitude: 18.48, longitude: 69.93 })).toBe(false); // signo invertido
    expect(isReportable({ latitude: Number.NaN, longitude: -69.9 })).toBe(false);
  });
  it('arma el cuerpo del API: precisión en metros enteros y orderId solo si hay', () => {
    const fix = { latitude: 18.5, longitude: -69.9, accuracyM: 12.6, timestamp: 1 };
    expect(toLocationBody(fix, 'o-1')).toEqual({
      latitude: 18.5,
      longitude: -69.9,
      accuracyM: 13,
      orderId: 'o-1',
    });
    expect(toLocationBody({ ...fix, accuracyM: null })).toEqual({
      latitude: 18.5,
      longitude: -69.9,
    });
  });
});

describe('permisos', () => {
  it('traduce la respuesta de expo-location', () => {
    expect(permissionStateFrom({ granted: true })).toBe('granted');
    expect(permissionStateFrom({ granted: false, status: 'undetermined', canAskAgain: true })).toBe(
      'undetermined',
    );
    expect(permissionStateFrom({ granted: false, status: 'denied', canAskAgain: true })).toBe(
      'denied',
    );
    expect(permissionStateFrom({ granted: false, status: 'denied', canAskAgain: false })).toBe(
      'blocked',
    );
  });
  it('mensajes en español solo cuando hay algo que decir', () => {
    expect(permissionMessage('granted')).toBeNull();
    expect(permissionMessage('unknown')).toBeNull();
    expect(permissionMessage('undetermined')).toContain('Activa tu ubicación');
    expect(permissionMessage('denied')).toContain('permiso');
    expect(permissionMessage('blocked')).toContain('Ajustes');
  });
});

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('entrega el valor si llega a tiempo', async () => {
    const p = withTimeout(Promise.resolve(7), 1000);
    await expect(p).resolves.toBe(7);
  });
  it('falla con LocationError timeout si el GPS no responde', async () => {
    const never = new Promise<number>(() => {});
    const p = withTimeout(never, 10_000);
    const assertion = expect(p).rejects.toMatchObject({
      code: 'timeout',
      message: LOCATION_MESSAGES.timeout,
    });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    p.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // todavía no se acaba el tiempo
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(await p.catch((e: unknown) => e)).toBeInstanceOf(LocationError);
  });
  it('propaga el error de la promesa original', async () => {
    await expect(withTimeout(Promise.reject(new Error('GPS roto')), 1000)).rejects.toThrow(
      'GPS roto',
    );
  });
});

describe('retryAfterMs / isClientRejection', () => {
  const rate = (retry?: unknown) => ({ status: 429, details: { retryAfterMs: retry } });
  it('lee retryAfterMs del 429 y lo limita a 60 s', () => {
    expect(retryAfterMs(rate(3200))).toBe(3200);
    expect(retryAfterMs(rate(10 * 60_000))).toBe(60_000);
  });
  it('un 429 sin dato usa 4 s (el límite del servidor)', () => {
    expect(retryAfterMs({ status: 429 })).toBe(4_000);
    expect(retryAfterMs(rate('x'))).toBe(4_000);
    expect(retryAfterMs(rate(-5))).toBe(4_000);
  });
  it('otros errores no son 429', () => {
    expect(retryAfterMs({ status: 500 })).toBeNull();
    expect(retryAfterMs(new Error('x'))).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
  it('detecta rechazos 4xx que no son 429', () => {
    expect(isClientRejection({ status: 403 })).toBe(true);
    expect(isClientRejection({ status: 404 })).toBe(true);
    expect(isClientRejection({ status: 429 })).toBe(false);
    expect(isClientRejection({ status: 500 })).toBe(false);
    expect(isClientRejection(undefined)).toBe(false);
  });
});

describe('createSendGate', () => {
  it('deja pasar el primer envío y separa los siguientes al menos 12 s', () => {
    const g = createSendGate();
    expect(g.canSend(1_000)).toBe(true);
    g.begin(1_000);
    expect(g.canSend(1_001)).toBe(false); // uno en vuelo
    g.succeed();
    expect(g.canSend(1_000 + MIN_SEND_GAP_MS - 1)).toBe(false);
    expect(g.canSend(1_000 + MIN_SEND_GAP_MS)).toBe(true);
  });
  it('un 429 respeta el retryAfterMs del servidor', () => {
    const g = createSendGate({ minGapMs: 1_000 });
    g.begin(0);
    g.fail(10, { status: 429, details: { retryAfterMs: 4_000 } });
    expect(g.canSend(3_999)).toBe(false);
    expect(g.canSend(4_010)).toBe(true);
    expect(g.failures).toBe(0); // el límite del servidor no es una falla de red
  });
  it('si falla la red espera cada vez más, hasta 60 s, y se recupera al tener éxito', () => {
    const g = createSendGate({ minGapMs: 12_000 });
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      g.begin(t);
      g.fail(t, new Error('sin red'));
      waits.push(g.nextAllowedAt - t);
      t = g.nextAllowedAt;
    }
    expect(waits).toEqual([24_000, 48_000, 60_000, 60_000, 60_000]);
    g.begin(t);
    g.succeed();
    expect(g.failures).toBe(0);
    expect(g.canSend(t + 12_000)).toBe(true);
  });
  it('un fallo no libera la espera de un 429 anterior', () => {
    const g = createSendGate({ minGapMs: 1_000 });
    g.begin(0);
    g.fail(0, { status: 429, details: { retryAfterMs: 30_000 } });
    g.begin(30_000);
    g.fail(30_000, new Error('x'));
    expect(g.canSend(30_500)).toBe(false);
  });
});
