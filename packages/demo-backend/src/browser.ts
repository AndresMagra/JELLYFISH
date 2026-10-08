/**
 * Punto de entrada del paquete que se mete en la página de la vista previa (un solo archivo IIFE).
 * Lee los datos del catálogo que dejó `scripts/build-preview.ts` en `__JF_DEMO_DATA__`, reemplaza
 * `fetch` para la dirección de demostración, instala los dobles de lo que el visor no deja hacer
 * (ubicación, abrir pestañas) y deja `JellyfishDemo` a mano (reiniciar, estado).
 *
 * Se carga ANTES que el bundle de la app: cuando la app hace su primera petición ya está instalado.
 * Este archivo solo tiene efectos (no exporta nada): las piezas probables están en sus propios módulos.
 */
import './zod-config'; // primero: ver el archivo
import { installGeolocationDouble, installOpenGuard } from './device-doubles';
import { type DemoHandle, installDemoBackend } from './install';
import { DEMO_OTP_CODE } from './server';
import { applyReset, clearStoredKeys, parseShortcuts, photoBaseFrom, storageOf } from './shortcuts';
import { type DocumentLike, createNoticeToast } from './toast';
import type { CategorySeed, PhotoSeed } from './types';

export interface BrowserDemoData {
  baseUrl: string;
  catalogCsv: string;
  categories: CategorySeed[];
  /** Fotos propias: `photos/<sku>.thumb.webp` (relativas a la carpeta de la página). */
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
  /** Qué dobles quedaron instalados (para revisar en la consola). */
  doubles: { geolocation: boolean; permissions: boolean };
}

/** Lo que se usa de `window` (sin depender de los tipos del DOM: este paquete también corre en Node). */
interface Win {
  __JF_DEMO_DATA__?: BrowserDemoData;
  __JF_ASSETS__?: string;
  JellyfishDemo?: JellyfishDemoApi;
  location: {
    pathname: string;
    search: string;
    hash: string;
    href: string;
    reload(): void;
    replace?(url: string): void;
  };
  navigator: object;
  document: DocumentLike;
  history?: { state: unknown; replaceState(state: unknown, title: string, url: string): void };
  localStorage?: { length: number; key(i: number): string | null; removeItem(k: string): void };
  sessionStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}

function boot(g: Win): void {
  const data = g.__JF_DEMO_DATA__;
  if (!data) {
    console.error('[JELLYFISH demo] Faltan los datos del catálogo (__JF_DEMO_DATA__).');
    return;
  }
  const startHref = g.location?.href;
  const { speed, reset } = parseShortcuts(g.location?.search, g.location?.hash);
  // Antes de instalar nada: el simulador y la app leen el estado guardado al arrancar.
  applyReset(reset, g);
  const handle = installDemoBackend({
    baseUrl: data.baseUrl,
    catalogCsv: data.catalogCsv,
    categories: data.categories,
    photos: data.photos,
    // Solo fotos propias: la página publicada no puede pedir nada a otros servidores.
    localPhotosOnly: true,
    photoBase: photoBaseFrom(g.location.href, g.__JF_ASSETS__),
    speed,
    storageKey: `jellyfish.demo.${data.buildId ?? 'v1'}`,
  });

  // El visor rechaza la ubicación sin avisar: un punto fijo de Santo Domingo, para poder enseñarla.
  const geo = installGeolocationDouble(g.navigator);
  // window.open devuelve null casi siempre: la app no depende de él, y la persona ve un aviso.
  installOpenGuard(g, createNoticeToast(g.document));

  g.JellyfishDemo = {
    handle,
    otpCode: DEMO_OTP_CODE,
    speed,
    doubles: geo.installed,
    restart() {
      clearStoredKeys(storageOf(g, 'localStorage'));
      // Se vuelve a la dirección con que se abrió la página, no a la pantalla interna donde esté la
      // persona: recargar "/profile" daría 404 en un alojamiento sin reescritura de rutas.
      if (startHref && g.location?.replace) g.location.replace(startHref);
      else g.location?.reload();
    },
    summary: () => handle.server.summary(),
  };
}

boot(globalThis as unknown as Win);
