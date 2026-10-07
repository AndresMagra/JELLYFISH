/** location.ts con expo-location y react-native simulados (la parte que no es un hook de React). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loc = vi.hoisted(() => ({
  getForegroundPermissionsAsync: vi.fn(),
  requestForegroundPermissionsAsync: vi.fn(),
  getCurrentPositionAsync: vi.fn(),
  watchPositionAsync: vi.fn(),
  Accuracy: { Balanced: 3 },
}));
vi.mock('expo-location', () => loc);
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove() {} }) },
  Linking: { openSettings: vi.fn(async () => {}) },
}));

import { LocationError } from '../src/location-core';
import {
  ensureForegroundLocationPermission,
  getCurrentPosition,
  getForegroundLocationPermission,
} from '../src/location';

const granted = { granted: true, status: 'granted', canAskAgain: true };
const undetermined = { granted: false, status: 'undetermined', canAskAgain: true };
const denied = { granted: false, status: 'denied', canAskAgain: true };
const blocked = { granted: false, status: 'denied', canAskAgain: false };

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('permiso de ubicación en primer plano', () => {
  it('lee el estado sin preguntar', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(undetermined);
    expect(await getForegroundLocationPermission()).toBe('undetermined');
    expect(loc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('si ya está concedido no vuelve a preguntar', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(granted);
    expect(await ensureForegroundLocationPermission()).toEqual({
      state: 'granted',
      granted: true,
      message: null,
    });
    expect(loc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('si nunca se preguntó, pide el permiso', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(undetermined);
    loc.requestForegroundPermissionsAsync.mockResolvedValue(granted);
    expect((await ensureForegroundLocationPermission()).granted).toBe(true);
    expect(loc.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('si se niega, explica en español qué hacer', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(undetermined);
    loc.requestForegroundPermissionsAsync.mockResolvedValue(denied);
    const r = await ensureForegroundLocationPermission();
    expect(r.state).toBe('denied');
    expect(r.message).toContain('permiso');
  });

  it('si se negó para siempre no insiste: manda a Ajustes', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(blocked);
    const r = await ensureForegroundLocationPermission();
    expect(r.state).toBe('blocked');
    expect(r.message).toContain('Ajustes');
    expect(loc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('si expo-location falla, no lanza', async () => {
    loc.getForegroundPermissionsAsync.mockRejectedValue(new Error('sin módulo'));
    expect((await ensureForegroundLocationPermission()).granted).toBe(false);
    expect(await getForegroundLocationPermission()).toBe('undetermined');
  });
});

describe('getCurrentPosition', () => {
  it('devuelve la lectura normalizada', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(granted);
    loc.getCurrentPositionAsync.mockResolvedValue({
      coords: { latitude: 18.47, longitude: -69.9, accuracy: 8.2 },
      timestamp: 123,
    });
    expect(await getCurrentPosition()).toEqual({
      latitude: 18.47,
      longitude: -69.9,
      accuracyM: 8.2,
      timestamp: 123,
    });
    expect(loc.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 3 });
  });

  it('sin permiso falla con LocationError permission y no usa el GPS', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(denied);
    await expect(getCurrentPosition()).rejects.toMatchObject({ code: 'permission' });
    expect(loc.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('si el GPS no responde a tiempo falla con timeout', async () => {
    vi.useFakeTimers();
    loc.getForegroundPermissionsAsync.mockResolvedValue(granted);
    loc.getCurrentPositionAsync.mockReturnValue(new Promise(() => {}));
    const p = getCurrentPosition({ timeoutMs: 2000 });
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(2001);
    await assertion;
  });

  it('un error del GPS se vuelve "unavailable" con mensaje en español', async () => {
    loc.getForegroundPermissionsAsync.mockResolvedValue(granted);
    loc.getCurrentPositionAsync.mockRejectedValue(new Error('Location provider is unavailable'));
    const e = await getCurrentPosition().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocationError);
    expect(e).toMatchObject({ code: 'unavailable' });
    expect((e as Error).message).toContain('GPS');
  });
});
