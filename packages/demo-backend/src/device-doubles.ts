/**
 * Lo que el visor donde se publica la vista previa NO deja hacer, resuelto dentro de la página:
 *
 *  - La ubicación del navegador se rechaza sin avisar → un doble de `navigator.geolocation` y de
 *    `navigator.permissions.query('geolocation')` que responde con un punto fijo de Santo Domingo, para que
 *    "Usar mi ubicación actual" funcione y se pueda enseñar.
 *  - `window.open` devuelve `null` casi siempre (y con `noopener` SIEMPRE) → la página no puede depender de
 *    abrir pestañas. Se reemplaza por un aviso claro, con un enlace de verdad cuando hay una dirección web.
 *
 * Sin dependencias del navegador: reciben `navigator` / `window` como parámetros, así se prueban en Node.
 */

/** Punto de ejemplo: Plaza de la Bandera, Santo Domingo (dentro de la zona que cubre la demostración). */
export const DEMO_POSITION = { latitude: 18.4861, longitude: -69.9312, accuracyM: 35 } as const;

// ───────────────────────── ubicación ─────────────────────────

interface PositionLike {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
}

type Success = (position: PositionLike) => void;
type Schedule = (fn: () => void, ms: number) => unknown;

export interface GeolocationDoubleOptions {
  now?: () => number;
  /** Para pruebas: en vez de `setTimeout`. */
  schedule?: Schedule;
  /** Cada cuántos milisegundos repite la posición `watchPosition`. */
  watchEveryMs?: number;
}

function makePosition(now: () => number): PositionLike {
  const coords = {
    latitude: DEMO_POSITION.latitude,
    longitude: DEMO_POSITION.longitude,
    accuracy: DEMO_POSITION.accuracyM,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  };
  return { coords, timestamp: now() };
}

/** Un `navigator.geolocation` falso, siempre con permiso y siempre en el mismo punto. */
export function createGeolocationDouble(options: GeolocationDoubleOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const schedule: Schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const every = options.watchEveryMs ?? 5000;
  const watchers = new Map<number, boolean>();
  let counter = 0;
  return {
    getCurrentPosition(success: Success, _error?: unknown, _options?: unknown): void {
      // Una pequeña espera: el GPS de verdad no responde en el mismo instante.
      schedule(() => success(makePosition(now)), 120);
    },
    watchPosition(success: Success, _error?: unknown, _options?: unknown): number {
      const id = ++counter;
      watchers.set(id, true);
      const tick = () => {
        if (!watchers.get(id)) return;
        success(makePosition(now));
        schedule(tick, every);
      };
      schedule(tick, 120);
      return id;
    },
    clearWatch(id: number): void {
      watchers.delete(id);
    },
  };
}

/** Lo que `navigator.permissions.query({ name: 'geolocation' })` responde: permiso concedido. */
export function createPermissionStatus() {
  const status = {
    name: 'geolocation',
    state: 'granted' as const,
    onchange: null as unknown,
    addEventListener(): void {},
    removeEventListener(): void {},
    dispatchEvent(): boolean {
      return false;
    },
  };
  return status;
}

interface NavigatorLike {
  geolocation?: unknown;
  permissions?: { query?: (descriptor: { name?: string }) => Promise<unknown> } | undefined;
}

export interface DoubleHandle {
  /** ¿Qué quedó instalado? (para la consola y las pruebas) */
  installed: { geolocation: boolean; permissions: boolean };
  uninstall(): void;
}

/**
 * Instala el doble de ubicación en `navigator`. Nunca lanza: en un navegador donde esas propiedades no se
 * pueden redefinir simplemente no queda instalado (y `installed` lo dice).
 */
export function installGeolocationDouble(
  nav: object,
  options: GeolocationDoubleOptions = {},
): DoubleHandle {
  const target = nav as NavigatorLike;
  const installed = { geolocation: false, permissions: false };
  const undo: (() => void)[] = [];

  try {
    const hadOwn = Object.prototype.hasOwnProperty.call(target, 'geolocation');
    const previous = Object.getOwnPropertyDescriptor(target, 'geolocation');
    Object.defineProperty(target, 'geolocation', {
      value: createGeolocationDouble(options),
      configurable: true,
      enumerable: true,
    });
    installed.geolocation = true;
    undo.push(() => {
      if (hadOwn && previous) Object.defineProperty(target, 'geolocation', previous);
      else delete (target as { geolocation?: unknown }).geolocation;
    });
  } catch {
    /* el navegador no deja redefinirla: la app mostrará su aviso normal de "no pudimos leer tu ubicación" */
  }

  try {
    const permissions = target.permissions;
    const original = permissions?.query?.bind(permissions);
    const query = (descriptor: { name?: string }): Promise<unknown> => {
      if (descriptor && descriptor.name === 'geolocation')
        return Promise.resolve(createPermissionStatus());
      if (original) return original(descriptor);
      return Promise.reject(new TypeError('Permiso no soportado'));
    };
    if (permissions && typeof permissions === 'object') {
      const hadOwn = Object.prototype.hasOwnProperty.call(permissions, 'query');
      const previous = Object.getOwnPropertyDescriptor(permissions, 'query');
      Object.defineProperty(permissions, 'query', {
        value: query,
        configurable: true,
        writable: true,
      });
      undo.push(() => {
        if (hadOwn && previous) Object.defineProperty(permissions, 'query', previous);
        else delete (permissions as { query?: unknown }).query;
      });
    } else {
      // Safari viejo y algunos visores no tienen `navigator.permissions`: se crea uno mínimo.
      Object.defineProperty(target, 'permissions', {
        value: { query },
        configurable: true,
        enumerable: true,
      });
      undo.push(() => {
        delete (target as { permissions?: unknown }).permissions;
      });
    }
    installed.permissions = true;
  } catch {
    /* igual que arriba */
  }

  return {
    installed,
    uninstall() {
      for (const fn of undo.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* nada que deshacer */
        }
      }
    },
  };
}

// ───────────────────────── abrir pestañas ─────────────────────────

export interface OpenNotice {
  /** Texto para la persona, en español. */
  text: string;
  /** Enlace de verdad (se abre con un toque, sin `window.open`) o null si no hay una dirección web. */
  href: string | null;
  /** Texto del enlace. */
  linkLabel: string;
}

const MAP_HOSTS = /(^|\.)(google\.com|maps\.apple\.com|openstreetmap\.org|goo\.gl|waze\.com)$/i;

/** Qué decirle a la persona cuando la app intenta abrir `url` en otra pestaña. */
export function noticeForOpen(url: string | URL | undefined | null): OpenNotice {
  const raw = url === undefined || url === null ? '' : String(url).trim();
  let href: string | null = null;
  let host = '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      href = parsed.href;
      host = parsed.hostname;
    }
  } catch {
    /* no es una dirección web */
  }
  const isMap = href !== null && (MAP_HOSTS.test(host) || /maps/i.test(href));
  const text = isMap
    ? 'Vista previa: aquí no se abre el mapa solo. En la app instalada este botón abre el mapa de tu teléfono con la posición del repartidor.'
    : 'Vista previa: aquí no se abren otras pestañas. En la app instalada este botón abre el enlace.';
  return { text, href, linkLabel: isMap ? 'Abrir el mapa' : 'Abrir el enlace' };
}

interface WindowLike {
  open?: unknown;
}

export interface OpenGuardHandle {
  uninstall(): void;
}

/**
 * Reemplaza `window.open`: nunca abre nada; avisa con `show` y devuelve `null` (lo mismo que el visor, pero
 * esta vez la persona lo ve). Con `noopener` el navegador ya devuelve `null` aunque abra la pestaña, así que
 * no hay forma de saber si "funcionó": por eso no se intenta.
 */
export function installOpenGuard(win: object, show: (notice: OpenNotice) => void): OpenGuardHandle {
  const target = win as WindowLike;
  const previous = Object.getOwnPropertyDescriptor(target, 'open');
  const hadOwn = previous !== undefined;
  const original = target.open;
  try {
    Object.defineProperty(target, 'open', {
      value: function open(url?: string | URL | null): null {
        try {
          show(noticeForOpen(url));
        } catch {
          /* mostrar el aviso nunca debe romper la app */
        }
        return null;
      },
      configurable: true,
      writable: true,
    });
  } catch {
    /* no se pudo reemplazar: queda el comportamiento del visor */
  }
  return {
    uninstall() {
      try {
        if (hadOwn && previous) Object.defineProperty(target, 'open', previous);
        else target.open = original;
      } catch {
        /* nada */
      }
    },
  };
}
