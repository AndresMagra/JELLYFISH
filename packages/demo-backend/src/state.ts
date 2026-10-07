import type { DemoState, KeyValueStorage } from './types';

export const STATE_VERSION = 1;

export function freshState(signature: string): DemoState {
  return {
    version: STATE_VERSION,
    signature,
    orderCounter: 1,
    users: [],
    sessions: {},
    otpRequests: {},
    addresses: [],
    orders: [],
    stock: {},
    devices: [],
  };
}

/** `localStorage` si existe y funciona (modo privado, bloqueo de datos o vista previa pueden fallar). */
export function defaultStorage(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!ls) return null;
    const probe = '__jf_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

/** Lee el estado guardado; si no existe, está dañado o es de otro catálogo, devuelve null. */
export function loadState(
  storage: KeyValueStorage | null,
  key: string,
  signature: string,
): DemoState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<DemoState> | null;
    if (!data || typeof data !== 'object') return null;
    if (data.version !== STATE_VERSION || data.signature !== signature) return null;
    if (
      !Array.isArray(data.users) ||
      !Array.isArray(data.orders) ||
      !Array.isArray(data.addresses) ||
      !Array.isArray(data.devices) ||
      typeof data.sessions !== 'object' ||
      typeof data.stock !== 'object' ||
      typeof data.orderCounter !== 'number'
    ) {
      return null;
    }
    return { ...freshState(signature), ...(data as DemoState) };
  } catch {
    return null;
  }
}

export function saveState(
  storage: KeyValueStorage | null,
  key: string,
  state: DemoState,
  last: { text: string },
): void {
  if (!storage) return;
  try {
    const text = JSON.stringify(state);
    if (text === last.text) return;
    storage.setItem(key, text);
    last.text = text;
  } catch {
    /* sin almacenamiento (cuota, modo privado): la demostración sigue en memoria */
  }
}

export function clearState(storage: KeyValueStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* nada que borrar */
  }
}
