/**
 * Un alojamiento de prueba que se porta como el real: sirve la vista previa bajo la ruta que se le diga y
 * es ESTRICTO. Lo usan scripts/e2e-preview.ts (verificación con Chromium) y las pruebas de Vitest.
 *
 *  - Solo responde archivos PROPIOS: los que están en `publish-files.json` (justo lo que se publica) y la
 *    página. Cualquier otra ruta es 404; no devuelve index.html "por si acaso" (como muchos alojamientos
 *    estáticos), salvo que se pida el modo `fallback`.
 *  - El fragmento `artifact.html` se envuelve con un esqueleto equivalente al de la plataforma (doctype,
 *    meta viewport con viewport-fit=cover y su reset mínimo), igual que cuando se publica.
 *  - Manda una política de seguridad estricta: solo archivos propios, `data:` y `blob:`; ningún servidor
 *    externo para imágenes, fetch, XHR, WebSocket ni estilos.
 *  - Anota cada petición, para que las pruebas puedan afirmar qué se pidió (y que nada salió a otro origen).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';
import { wrapLikeHost } from './preview-shell';

/** La política de seguridad del alojamiento donde se publica (resumen de las reglas conocidas). */
export const HOST_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface Mount {
  /** Nombre corto (para los mensajes). */
  name: string;
  /** Ruta de la página, tal como la escribe la persona en el navegador. */
  page: string;
  /** Carpeta (con "/" al final) desde donde se sirven los archivos adjuntos. */
  filesDir: string;
  /**
   * 'host' = el fragmento artifact.html envuelto como lo hace la plataforma (lo que se publica);
   * 'index' = el index.html completo, sin envolver (otros alojamientos).
   */
  mode: 'host' | 'index';
  /** Peticiones que se SABE que darán 404 en esta modalidad (sondeo de carpeta). */
  expected404?: string[];
}

/** Las rutas bajo las que se verifica: raíz, subcarpetas, con archivo explícito y sin barra final. */
export const MOUNTS: Mount[] = [
  { name: 'raiz', page: '/', filesDir: '/', mode: 'host' },
  { name: 'x', page: '/x/', filesDir: '/x/', mode: 'host' },
  { name: 'xyz', page: '/x/y/z/', filesDir: '/x/y/z/', mode: 'host' },
  { name: 'xyz-artifact', page: '/x/y/z/artifact.html', filesDir: '/x/y/z/', mode: 'host' },
  { name: 'x-index', page: '/x/index.html', filesDir: '/x/', mode: 'host' },
  { name: 'raiz-artifact', page: '/artifact.html', filesDir: '/', mode: 'host' },
  { name: 'raiz-index', page: '/index.html', filesDir: '/', mode: 'host' },
  { name: 'xyz-index', page: '/x/y/z/index.html', filesDir: '/x/y/z/', mode: 'host' },
  // Una carpeta con espacio (el navegador la escribe "/mi%20vista/"): las rutas se comparan ya codificadas.
  { name: 'espacio', page: '/mi vista/', filesDir: '/mi vista/', mode: 'host' },
  // Sin barra final y los archivos en la carpeta hermana: los <script src> relativos aciertan.
  { name: 'sinbarra-hermana', page: '/artifact/abc', filesDir: '/artifact/', mode: 'host' },
  // Sin barra final y los archivos dentro de la ruta: los relativos fallan y el plan B los busca.
  {
    name: 'sinbarra-dentro',
    page: '/artifact/def',
    filesDir: '/artifact/def/',
    mode: 'host',
    expected404: ['/artifact/js/', '/artifact/jf-probe.json'],
  },
  // El index.html completo (sin envolver), por si se aloja en otro lado.
  { name: 'index-completo', page: '/vista/', filesDir: '/vista/', mode: 'index' },
];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
};

export interface LoggedRequest {
  url: string;
  status: number;
}

export interface Host {
  origin: string;
  port: number;
  /** Peticiones que llegaron al servidor, en orden. */
  requests: LoggedRequest[];
  close(): Promise<void>;
}

export interface HostOptions {
  /** Carpeta dist-preview/ ya construida. */
  dist: string;
  /** Primer puerto que se intenta (si está ocupado se prueba el siguiente, hasta 4999). Por defecto 4311. */
  port?: number;
  mounts?: Mount[];
  /** Nombres de rutas donde las URLs desconocidas (pantallas internas) devuelven la página, como un alojamiento con "SPA fallback". */
  fallback?: string[];
  /** Cambia la política de seguridad (p. ej. para probar que SÍ se detecta una violación). */
  csp?: string | null;
  /** Atiende `/host.html`: la página dentro de un marco aislado (sin acceso a localStorage). */
  sandboxFrame?: string;
}

/** Lo que se puede pedir a la página: exactamente los archivos del mapa de publicación. */
export function publishedPaths(dist: string): Set<string> {
  const publish = JSON.parse(readFileSync(join(dist, 'publish-files.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  return new Set(Object.keys(publish.files));
}

/** Escucha en el primer puerto libre desde `start` (los puertos propios de las pruebas son 3100–4999). */
async function listenFrom(server: Server, start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return (server.address() as AddressInfo).port;
  }
  throw new Error(`No hay un puerto libre entre ${start} y ${end}`);
}

export async function startHost(options: HostOptions): Promise<Host> {
  const dist = resolve(options.dist);
  const mounts = options.mounts ?? MOUNTS;
  const allowed = publishedPaths(dist);
  const fallback = new Set(options.fallback ?? []);
  const csp = options.csp === undefined ? HOST_CSP : options.csp;
  const requests: LoggedRequest[] = [];
  const pageHtml = new Map<string, string>();
  const pageFor = (m: Mount): string => {
    let html = pageHtml.get(m.mode);
    if (html === undefined) {
      html =
        m.mode === 'host'
          ? wrapLikeHost(readFileSync(join(dist, 'artifact.html'), 'utf8'))
          : readFileSync(join(dist, 'index.html'), 'utf8');
      pageHtml.set(m.mode, html);
    }
    return html;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }
    const send = (status: number, type: string, body: string | Buffer, withCsp = true) => {
      requests.push({ url: url.pathname, status });
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        ...(csp && withCsp ? { 'content-security-policy': csp } : {}),
      });
      res.end(body);
    };

    if (options.sandboxFrame && path === '/host.html') {
      // La página anfitriona (el visor) NO lleva la política: la lleva la página que se publica.
      return send(
        200,
        TYPES['.html']!,
        `<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts allow-forms" src="${options.sandboxFrame}" style="border:0;width:390px;height:800px"></iframe></body>`,
        false,
      );
    }

    // 1) La página: la ruta exacta de alguna modalidad.
    const page = mounts.find((m) => m.page === path);
    if (page) return send(200, TYPES['.html']!, pageFor(page));

    // 2) Un archivo adjunto publicado, en la carpeta de alguna modalidad.
    for (const m of [...mounts].sort((a, b) => b.filesDir.length - a.filesDir.length)) {
      if (!path.startsWith(m.filesDir)) continue;
      const rel = path.slice(m.filesDir.length);
      if (allowed.has(rel)) {
        const file = join(dist, rel);
        if (existsSync(file) && statSync(file).isFile()) {
          return send(200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file));
        }
      }
    }

    // 3) Alojamiento con "SPA fallback": una pantalla interna devuelve la página de la modalidad.
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      const owner = mounts.find(
        (m) =>
          fallback.has(m.name) &&
          (path.startsWith(m.page.endsWith('/') ? m.page : `${m.page}/`) ||
            (m.page.endsWith('/') ? false : path.startsWith(m.page))),
      );
      if (owner) return send(200, TYPES['.html']!, pageFor(owner));
    }

    send(404, 'text/plain; charset=utf-8', 'No encontrado');
  });

  const port = await listenFrom(server, options.port ?? 4311, 4999);
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
