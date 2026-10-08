/**
 * Atajos de la vista previa y utilidades del arranque que no necesitan navegador (se prueban en Node).
 *
 * En el visor donde se publica la página, de la dirección del enlace solo llega un `#ancla` simple (letras,
 * números, `.`, `_`, `~`, `-`): el `?speed=3` y el `?reset=1` no llegan. Por eso cada atajo tiene dos
 * formas: `?speed=3` (para cuando abres la página tú mismo) y `#rapido` (la que sí viaja en un enlace).
 */

/** Velocidades con nombre para el `#ancla`. */
export const SPEED_ANCHORS: Record<string, number> = {
  rapido: 3,
  muyrapido: 10,
  lento: 0.5,
};

export interface Shortcuts {
  /** 1 = tiempos normales (≈ 25 s por etapa del pedido). */
  speed: number;
  /** Borrar sesión, carrito y pedidos de ejemplo antes de arrancar. */
  reset: 'query' | 'anchor' | null;
}

function anchorName(hash: string | undefined): string {
  return (hash ?? '').replace(/^#/, '').toLowerCase();
}

/** `?speed=2` acelera el ciclo del pedido (2 = el doble de rápido). Solo valores razonables. */
export function parseSpeed(search: string | undefined, hash?: string): number {
  const raw = search ? new URLSearchParams(search).get('speed') : null;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.1 && n <= 60) return n;
  }
  return SPEED_ANCHORS[anchorName(hash)] ?? 1;
}

export function parseShortcuts(search: string | undefined, hash?: string): Shortcuts {
  const query = search ? new URLSearchParams(search).get('reset') === '1' : false;
  const anchor = anchorName(hash) === 'reiniciar';
  return {
    speed: parseSpeed(search, hash),
    reset: query ? 'query' : anchor ? 'anchor' : null,
  };
}

/**
 * La carpeta de la página como URL absoluta (con "/" al final), para resolver las fotos relativas.
 * `assets` es la carpeta de archivos sin la barra final ("" en la raíz, "/x/y" en una subcarpeta).
 */
export function photoBaseFrom(locationHref: string, assets: string | undefined): string | undefined {
  try {
    const dir = `${(assets ?? '').replace(/\/+$/, '')}/`;
    return new URL(dir, locationHref).href;
  } catch {
    return undefined;
  }
}

/**
 * `window.localStorage` / `sessionStorage` LANZAN al leerlos cuando el navegador los bloquea (modo privado,
 * datos de sitio bloqueados, marco aislado): se leen siempre por aquí.
 */
export function storageOf<T>(env: object, name: 'localStorage' | 'sessionStorage'): T | undefined {
  try {
    return (env as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

/** Claves que la demostración y la app guardan en el navegador. */
export const STORAGE_PREFIX = 'jellyfish';

interface StorageLike {
  length: number;
  key(i: number): string | null;
  removeItem(k: string): void;
}

/** Borra todo lo que la app y la demostración guardan en este navegador (claves "jellyfish…"). */
export function clearStoredKeys(storage: StorageLike | undefined): number {
  try {
    if (!storage) return 0;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
    return keys.length;
  } catch {
    return 0; // sin almacenamiento: no hay nada que borrar
  }
}

/** Marca de "ya se reinició en esta sesión del navegador" (no empieza con "jellyfish": el propio reinicio no la borra). */
export const RESET_FLAG = 'jf-reset-done';

interface ResetEnv {
  /** Se leen con `storageOf`: los getters pueden lanzar. */
  localStorage?: StorageLike;
  sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  history?: { state: unknown; replaceState(state: unknown, title: string, url: string): void };
  location: { pathname: string; search: string; hash: string };
}

/**
 * `?reset=1` borra la demostración cada vez que se abre esa dirección y se quita de la barra (para que
 * recargar no vuelva a borrar). `#reiniciar` es la forma que sí llega desde el enlace del visor: como el
 * ancla se queda en la dirección, borra UNA sola vez por sesión del navegador.
 * Devuelve true si borró.
 */
export function applyReset(reset: Shortcuts['reset'], env: ResetEnv): boolean {
  if (reset === null) return false;
  const session = storageOf<NonNullable<ResetEnv['sessionStorage']>>(env, 'sessionStorage');
  if (reset === 'anchor') {
    try {
      if (session?.getItem(RESET_FLAG)) return false;
    } catch {
      /* sin sessionStorage: se borra al abrir; no hay forma de recordar que ya se hizo */
    }
  }
  clearStoredKeys(storageOf<StorageLike>(env, 'localStorage'));
  if (reset === 'anchor') {
    try {
      session?.setItem(RESET_FLAG, '1');
    } catch {
      /* igual */
    }
  } else {
    try {
      const search = env.location.search
        .replace(/([?&])reset=1(&|$)/, (_m, lead: string, tail: string) => (tail ? lead : ''))
        .replace(/[?&]$/, '');
      env.history?.replaceState(env.history.state, '', env.location.pathname + search + env.location.hash);
    } catch {
      /* un marco que no deja reescribir la dirección: se queda con ?reset=1 */
    }
  }
  return true;
}
