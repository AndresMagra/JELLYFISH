import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** apps/api/src/routes → raíz del repositorio → data/catalog/photos. */
const DEFAULT_PHOTOS_DIR = fileURLToPath(
  new URL('../../../../data/catalog/photos', import.meta.url),
);

/**
 * Solo nombres planos de imagen: sin barras, sin segmentos "." ni "..", sin archivos ocultos. Es una
 * segunda barrera además de la que ya trae `@fastify/static`, y evita exponer otros archivos que
 * algún día caigan en la misma carpeta (notas, manifiestos).
 */
const SAFE_PHOTO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webp|png|jpe?g)$/;

/** `JF-RES-001.3fa9c1d2.webp`: el nombre cambia cuando cambia la imagen, así que puede ser inmutable. */
const HASHED_NAME = /\.[0-9a-f]{8,}\.[a-z0-9]+$/i;

const ONE_DAY = 86_400;
const ONE_YEAR = 31_536_000;

/**
 * Cabecera de caché según el nombre. `<sku>.webp` puede regenerarse con otra imagen, por eso vive
 * un día y luego se revalida con ETag (una respuesta 304 casi no pesa). Con hash en el nombre la
 * imagen nunca cambia, así que se cachea un año.
 */
export function photoCacheControl(fileName: string): string {
  return HASHED_NAME.test(fileName)
    ? `public, max-age=${ONE_YEAR}, immutable`
    : `public, max-age=${ONE_DAY}, stale-while-revalidate=${7 * ONE_DAY}`;
}

/**
 * GET /photos/<archivo> sirve las fotos del catálogo (`data/catalog/photos`, o `PHOTOS_DIR`).
 * Sin listado de carpetas ni subcarpetas. No cuenta contra el límite de peticiones: son archivos
 * pequeños y cacheables, y el CGNAT de las operadoras junta muchos teléfonos bajo una sola IP.
 */
export async function registerStaticRoutes(app: FastifyInstance): Promise<void> {
  const root = resolve(app.deps.config.photosDir ?? DEFAULT_PHOTOS_DIR);

  await app.register(fastifyStatic, {
    root,
    serve: false, // la ruta se declara abajo; el plugin solo aporta `reply.sendFile`
    index: false,
    list: false,
    dotfiles: 'deny',
    etag: true,
    lastModified: true,
    acceptRanges: true,
    cacheControl: false, // se pone por archivo en setHeaders, y solo cuando el archivo existe
    setHeaders: (reply, filePath) => {
      reply.header('cache-control', photoCacheControl(basename(filePath)));
      reply.header('x-content-type-options', 'nosniff');
      // Son imágenes públicas del catálogo que cargan el panel y la vista previa web desde otro
      // origen; sin esto, helmet (same-origin por defecto) las bloquearía.
      reply.header('cross-origin-resource-policy', 'cross-origin');
    },
  });

  app.get('/photos/*', { config: { rateLimit: false } }, async (req, reply) => {
    const name = (req.params as { '*'?: string })['*'] ?? '';
    if (!SAFE_PHOTO_NAME.test(name)) return reply.callNotFound();
    return reply.sendFile(name);
  });
}
