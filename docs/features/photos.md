# Fotos y campos de catálogo

Código: `packages/catalog/src/{import,types,photos}.ts`, `packages/shared/src/photo.ts`,
`apps/api/src/services/catalog.ts`, `apps/api/src/routes/static.ts`, `scripts/photos-apply.ts`,
`scripts/photos-fetch.ts`. Pruebas: `packages/catalog/test/{import,photos}.test.ts`,
`packages/shared/test/photo.test.ts`, `apps/api/test/{photos,photos-scripts}.test.ts`.

## 1. "Foto ilustrativa"

- `CatalogItem.photoIllustrative` (opcional en el tipo; ausente = `true`). `true` = imagen
  generada o de referencia, que la app rotula "Imagen ilustrativa"; `false` = foto real.
- CSV: columna opcional `foto_ilustrativa` (`si`/`no`, vacío = `si`), **última** de `CSV_COLUMNS`
  (después de `activo`, así un CSV viejo de 23 columnas sigue siendo válido). Alias sin acentos:
  `ilustrativa`, `imagen_ilustrativa`, `foto_ilustrativo`, `es_ilustrativa`, `foto_es_ilustrativa`.
  `no` en una fila sin `foto` da un aviso, no un error. Un valor que no es sí/no es un error con fila,
  SKU y campo.
- Base de datos: `variants.photo_illustrative` (ya existía). `importCatalog` la guarda y actualiza;
  `exportCatalogCsv` la exporta junto con la `foto` **tal como está guardada** (nunca la URL absoluta),
  así exportar y reimportar no pierde nada. Ojo: un CSV sin la columna deja `photo_illustrative = true`
  en lo que importa, igual que ya hace con `foto` (el CSV manda).
- Panel: `PATCH /v1/admin/variants/:id` acepta `photo` (se recorta; vacío la quita) y
  `photoIllustrative` (booleano). Cambiar una no toca la otra. `GET /v1/admin/catalog` devuelve
  ambas, sin absolutizar (es el valor que se edita).
- DTOs de la app: `VariantDTO.photoIllustrative`, `QuoteLineDTO.photoIllustrative` (carrito) y
  `ReorderLineDTO.photoIllustrative` (ya lo traía). `AdminVariantDTO.photoIllustrative`.

## 2. Miniaturas (`packages/shared/src/photo.ts`)

- `photoThumb(url)`: para `https://d8j0ntlcm91z4.cloudfront.net/…/hf_….png` devuelve `…/hf_…_min.webp`
  (conserva la cadena de consulta, es idempotente). Cualquier otra URL, otro host (incluido
  `d8j0ntlcm91z4.cloudfront.net.evil.example`), `http://` o ruta local se devuelve igual. Una prueba lo
  contrasta con las 38 `minUrl` reales del manifiesto.
- `isRemotePhoto(url)`: `http(s)://`.
- `absolutePhotoUrl(foto, base)`: `/photos/x.webp` → `<base>/photos/x.webp`; `https://…`, `fotos/x.jpg`,
  vacío y `//host/x` quedan intactos.

## 3. Manifiesto → CSV (`npm run photos:apply`)

Formato de `data/catalog/photos.manifest.json`:
`{ generatedWith, items: [{ sku, jobId, rawUrl, minUrl, illustrative, model, quality, aspect, attempts, verified, notes }] }`
(se valida con `parsePhotoManifest`: campos y tipos, `rawUrl` http(s), sin SKUs repetidos).

```bash
npm run photos:apply -- --dry-run     # muestra el efecto, no escribe
npm run photos:apply                  # escribe data/catalog/products.seed.csv
npm run photos:apply -- --csv x.csv --manifest y.json --strict
```

- Escribe `foto = rawUrl` y `foto_ilustrativa = si|no` (según `illustrative`) pasando por
  `parseCatalogCsv`/`catalogToCsv`. Precios y demás campos salen idénticos (probado celda por celda con
  el manifiesto y la semilla reales). La columna `foto_ilustrativa` se agrega si faltaba.
- Reporta SKUs que quedan sin foto, entradas huérfanas (SKU que no está en el CSV), entradas omitidas
  por `verified: false` (`--include-unverified` las aplica) y fotos reales del dueño conservadas
  (`foto_ilustrativa = no` con foto: `--force` las pisa).
- Idempotente: la segunda corrida dice "Sin cambios" y no toca el archivo. Si el CSV tiene errores o el
  manifiesto es inválido sale con código 1 sin escribir. `--strict` falla si hay SKUs sin foto o huérfanas.
- Si corres `photos:apply` **después** de `photos:fetch --rewrite`, vuelve a poner la URL del CDN
  (el manifiesto manda); repite `photos:fetch --rewrite`, que no vuelve a descargar nada.

## 4. Descargar las imágenes (`npm run photos:fetch`)

```bash
npm run photos:fetch                         # lo que falte → data/catalog/photos/
npm run photos:fetch -- --rewrite            # y foto=/photos/<sku>.webp en el CSV
npm run photos:fetch -- --force --only JF-MAR-001,JF-MAR-002 --concurrency 2
```

- Por SKU deja `<sku>.webp` (ancho máx. 1168, sin ampliar, calidad 85) y `<sku>.thumb.webp` (ancho 480,
  calidad 80), con `sharp`. Escribe a un temporal y renombra: un corte no deja archivos a medias.
- Verifica antes de guardar: HTTP 200, `content-type: image/*`, tope de 25 MB, formato png/jpeg/webp,
  ancho ≥ 480 px (una más chica saldría ampliada y borrosa) y que lo escrito sea webp con las
  dimensiones pedidas. Avisa (sin fallar) si el aspecto real se aleja más de 3 % del `aspect` del manifiesto.
- Reintenta 3 veces solo ante errores de red o 5xx. Un SKU que no sirva de nombre de archivo (`../x`) se rechaza.
- Omite lo ya descargado si ambos archivos existen y se leen bien (uno truncado se vuelve a bajar);
  `--force` lo repite. Sale con 1 si algo falló, pero con `--rewrite` igual reescribe lo que sí bajó.
- `--rewrite` solo cambia filas cuya `foto` es la `rawUrl` del manifiesto (o ya la ruta local): una foto
  real o puesta a mano del dueño no se pisa.
- Detrás de un proxy, `fetch` de Node no lo lee solo: usa `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).

## 5. Servir las fotos (`GET /photos/<archivo>`)

- Carpeta: `data/catalog/photos`, o `PHOTOS_DIR` (opcional). Si no existe todavía, el API arranca y
  responde 404 en `/photos/…`.
- Solo nombres planos de imagen (`.webp`, `.png`, `.jpg`): sin subcarpetas, archivos ocultos, otras
  extensiones, listado de carpetas ni `..` (también codificado). Solo GET y HEAD.
- Caché: `ETag` + `Last-Modified`; `public, max-age=86400, stale-while-revalidate=604800` para
  `<sku>.webp` (puede regenerarse con otra imagen) y `public, max-age=31536000, immutable` solo si el
  nombre lleva un hash entre puntos (`JF-RES-001.3fa9c1d2.webp`). Los 404 no se cachean.
- No cuenta contra el límite de 300 peticiones por minuto del API: son archivos cacheables y las
  operadoras comparten IP entre muchos teléfonos.
- Lleva `Cross-Origin-Resource-Policy: cross-origin` y `X-Content-Type-Options: nosniff`: el panel y la
  vista previa web (otro origen) deben poder mostrar las imágenes aunque el API active helmet.
- URLs absolutas: `GET /v1/products`, `/v1/products/:group` y `POST /v1/quote` devuelven `photo`
  absoluta cuando está guardada como `/photos/…`, usando `PUBLIC_API_URL`
  (`config.payments.publicBaseUrl`). En desarrollo sin `PUBLIC_API_URL` es `http://localhost:<PORT>`:
  para un teléfono real hay que definirla con la dirección alcanzable desde el teléfono.

## Variables de entorno

| Variable             | Uso                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------- |
| `PUBLIC_API_URL`     | Ya existía (pasarela de pago). Ahora también completa las rutas `/photos/…` en las DTO |
| `PHOTOS_DIR`         | Carpeta de fotos que sirve el API (por defecto `data/catalog/photos`)                  |
| `NODE_USE_ENV_PROXY` | Solo para `photos:fetch` detrás de un proxy corporativo                                |

## Cómo probarlo

```bash
npx vitest run packages/catalog packages/shared apps/api/test/photos.test.ts apps/api/test/photos-scripts.test.ts
npx tsx scripts/photos-apply.ts --dry-run
```

Las pruebas de `photos:fetch` usan un servidor HTTP local (sin red externa) que sirve PNG de colores
conocidos, páginas HTML, 404, 503 y archivos corruptos.

## Límites conocidos

- **No se probó contra el CDN real**: desde el entorno de desarrollo el proxy bloquea
  `cloudfront.net`. `photos:fetch` solo se ejecutó contra el servidor local de pruebas.
- `photoThumb` deja iguales las rutas locales (así se pidió): las miniaturas `<sku>.thumb.webp` se
  generan y se sirven, pero ninguna app las usa todavía hasta que `photoThumb` las conozca.
- Los nombres locales `<sku>.webp` no llevan hash: se revalidan a diario con ETag en vez de ser
  inmutables. Delante de un CDN real conviene nombrarlos con hash.
- `OrderItemDTO` (ítems de un pedido ya hecho) no lleva foto: `order_items` no guarda foto y el
  esquema está congelado. La foto viaja en la cotización y en pedir de nuevo.
- `ReorderLineDTO.photo` (`services/delivery.ts`) sigue saliendo sin absolutizar; falta pasarla por
  `absolutePhotoUrl(variant.photo, config.payments.publicBaseUrl)`.
- `photos:apply` reescribe el CSV en el formato canónico (coma, columnas en orden); un CSV de Excel con
  `;` queda convertido a coma.
