/**
 * Punto de entrada del paquete que se mete en la página de la vista previa (un solo archivo IIFE).
 * Lee los datos del catálogo que dejó `scripts/build-preview.ts` en `__JF_DEMO_DATA__`, reemplaza
 * `fetch` para la dirección de demostración y deja `JellyfishDemo` a mano (reiniciar, estado).
 *
 * Se carga ANTES que el bundle de la app: cuando la app hace su primera petición ya está instalado.
 */
import { type DemoHandle, installDemoBackend } from './install';
import { DEMO_OTP_CODE } from './server';
import type { CategorySeed, PhotoSeed } from './types';

export interface BrowserDemoData {
  baseUrl: string;
  catalogCsv: string;
  categories: CategorySeed[];
  photos: PhotoSeed[];
  /** Identificador de la compilación (cambia si cambian los datos); invalida estados guardados viejos. */
  buildId?: string;
}

interface JellyfishDemoApi {
  handle: DemoHandle;
  otpCode: string;
  speed: number;
  /** Borra el estado de la demostración (y la sesión y el carrito de la app) y recarga. */
  restart(): void;
  summary(): { users: number; orders: number };
}

const g = globalThis as unknown as {
  __JF_DEMO_DATA__?: BrowserDemoData;
  JellyfishDemo?: JellyfishDemoApi;
  location?: { search: string; reload(): void };
  localStorage?: {
    length: number;
    key(i: number): string | null;
    removeItem(k: string): void;
  };
};

/** `?speed=2` acelera el ciclo del pedido (2 = el doble de rápido). Solo valores razonables. */
export function parseSpeed(search: string | undefined): number {
  if (!search) return 1;
  const raw = new URLSearchParams(search).get('speed');
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.1 && n <= 60 ? n : 1;
}

/** Borra todo lo que la app y la demostración guardan en este navegador (claves "jellyfish…"). */
export function clearStoredKeys(): void {
  try {
    const ls = g.localStorage;
    if (!ls) return;
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('jellyfish')) keys.push(k);
    }
    for (const k of keys) ls.removeItem(k);
  } catch {
    /* sin almacenamiento: no hay nada que borrar */
  }
}

function boot(): void {
  const data = g.__JF_DEMO_DATA__;
  if (!data) {
    console.error('[JELLYFISH demo] Faltan los datos del catálogo (__JF_DEMO_DATA__).');
    return;
  }
  const speed = parseSpeed(g.location?.search);
  const handle = installDemoBackend({
    baseUrl: data.baseUrl,
    catalogCsv: data.catalogCsv,
    categories: data.categories,
    photos: data.photos,
    speed,
    storageKey: `jellyfish.demo.${data.buildId ?? 'v1'}`,
  });
  g.JellyfishDemo = {
    handle,
    otpCode: DEMO_OTP_CODE,
    speed,
    restart() {
      clearStoredKeys();
      g.location?.reload();
    },
    summary: () => handle.server.summary(),
  };
}

boot();
