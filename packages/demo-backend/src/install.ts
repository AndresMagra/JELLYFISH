import {
  type DemoServer,
  type FetchInit,
  type FetchInput,
  createDemoServer,
  matchesBase,
} from './server';
import type { DemoOptions } from './types';

/** Dónde se instala: por defecto `globalThis` (en las pruebas, un objeto propio). */
export interface FetchTarget {
  fetch: typeof fetch;
}

export interface InstallOptions extends DemoOptions {
  /** Objeto cuyo `fetch` se reemplaza. Por defecto `globalThis`. */
  target?: FetchTarget;
}

export interface DemoHandle {
  readonly server: DemoServer;
  /** Devuelve `fetch` a como estaba. */
  uninstall(): void;
  /** Borra el estado guardado y vuelve a empezar. */
  reset(): void;
}

/** Instala un servidor ya creado en `target.fetch` (solo atiende las URLs del baseUrl). */
export function installServer(
  server: DemoServer,
  target: FetchTarget = globalThis as unknown as FetchTarget,
  passthrough?: typeof fetch,
): DemoHandle {
  const original: typeof fetch = passthrough ?? target.fetch.bind(target);
  const replacement = ((input: FetchInput, init?: FetchInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (matchesBase(url, server.baseUrl)) return server.fetch(input, init);
    return original(input, init);
  }) as typeof fetch;
  const before = target.fetch;
  target.fetch = replacement;
  return {
    server,
    uninstall() {
      if (target.fetch === replacement) target.fetch = before;
    },
    reset() {
      server.reset();
    },
  };
}

/**
 * Reemplaza `fetch` SOLO para las URLs que empiezan con `baseUrl`; todo lo demás (fotos, fuentes,
 * lo que sea) pasa al `fetch` de verdad. La app no cambia: sigue llamando a su API de siempre.
 */
export function installDemoBackend(options: InstallOptions): DemoHandle {
  const server = createDemoServer(options);
  return installServer(server, options.target, options.fetch);
}
