# Catálogo JELLYFISH

Fuente de verdad del catálogo. Es **el catálogo real del dueño**: 38 artículos (29 fichas) sacados de su listado de precios interno. Se actualiza subiendo el Excel nuevo (panel → **Lista de precios**) o con `npm run catalog:from-xlsx`, y también se puede sustituir con un CSV propio del mismo formato.

## Archivos

| Archivo                     | Para qué sirve                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `categories.json`           | Categorías y subcategorías (slugs usados por el CSV)                                                                                           |
| `products.seed.csv`         | 38 artículos vendibles (29 fichas): res, cerdo, aves, pescados, mariscos y otros                                                               |
| `lista-proveedor.meta.json` | Datos curados por artículo (SKU, ficha, categoría, paso y mínimo, sinónimos, cómo cocinarlo). El Excel solo trae nombre, presentación y precio |
| `template.csv`              | Plantilla con 3 filas de ejemplo para tu inventario                                                                                            |
| `photos.manifest.json`      | Fotos generadas por SKU (URL, modelo, si pasó la revisión). Lo lee `npm run photos:apply`                                                      |
| `photos/`                   | Fotos ya descargadas (`<sku>.webp` y `<sku>.thumb.webp`), las sirve el API en `/photos/…`                                                      |

## De dónde sale el precio de venta

El Excel del dueño (`data/private/…xlsx`, **nunca se versiona**) trae el precio de lista por libra; la columna A marca con un asterisco los productos que pagan ITBIS. El precio de venta al consumidor es:

```
precio de venta = precio del listado × 1.15 (beneficio) × 1.18 (solo si lleva asterisco)
```

con un único redondeo al centavo (`consumerPrice` en `packages/catalog/src/pricelist.ts`). Todas las filas llevan `precio_fuente = usuario` y su ITBIS definido (`18` o `0`), así que el catálogo se publica sin modo demo.

```bash
npm run catalog:from-xlsx -- --xlsx data/private/lista-de-precios-27-09-2026.xlsx --margen 15
npm run catalog:from-xlsx -- --xlsx … --margen 15 --itbis incluido   # si el listado ya incluyera el ITBIS
```

El script no escribe nada si hay errores y **no guarda el costo** en el CSV (`--con-costo` lo guarda; es un dato interno: no lo subas a Git).

> **Pendiente de confirmar con el dueño y su contador:** se asumió que el listado **no incluye** ITBIS (por eso se suma 18 % a los artículos con asterisco). Si ya lo incluía, el modo `--itbis incluido` regenera todo con un comando. Afecta a 23 de los 38 artículos.

### Qué es "publicable"

Cada fila trae `precio_fuente` (`ancla`, `estimado` o `usuario`). Un artículo solo se muestra a clientes si: está activo, su precio no es `estimado` y su ITBIS fue confirmado (columna `itbis`: `0`, `18` o `exento`/`gravado`). El modo demo (`JELLYFISH_DEMO=1`) se salta esta regla; nunca lo uses con clientes reales.

Nota: "Dorada entera" y "Dorado entero" son dos líneas distintas del listado del dueño (besugo y mahi-mahi); verifica que los nombres coincidan con el producto real.

## Columnas del CSV

| Columna                       | Obligatoria | Detalle                                                                                                                         |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sku`                         | sí          | Único por fila                                                                                                                  |
| `grupo`                       | no          | Agrupa variantes (calibres, marcas) en una ficha. Si falta, se deriva del nombre                                                |
| `nombre`                      | sí          | Nombre del producto                                                                                                             |
| `variante`                    | no          | Etiqueta de la variante (`16/20`, `Cibao congelada`)                                                                            |
| `categoria`                   | sí          | Slug de `categories.json`                                                                                                       |
| `subcategoria`                | no          | Texto libre                                                                                                                     |
| `unidad`                      | sí          | `lb` (por libra) o `unit` (por unidad/combo)                                                                                    |
| `paso_lb` / `minimo_lb`       | no          | Incremento y mínimo al pedir por libra (por defecto 0.5 y 1)                                                                    |
| `peso_pieza_lb`               | no          | Peso aproximado de una pieza o combo                                                                                            |
| `precio`                      | sí          | RD$ por libra o por unidad, **con ITBIS incluido**, máximo 2 decimales                                                          |
| `precio_fuente`               | no          | `ancla`, `estimado` o `usuario` (por defecto `usuario`)                                                                         |
| `notas_precio`                | no          | De dónde salió el precio                                                                                                        |
| `costo`                       | no          | Para calcular margen                                                                                                            |
| `stock`                       | no          | Libras (si `lb`) o unidades (si `unit`)                                                                                         |
| `itbis`                       | no          | `0`, `18`, `exento`, `gravado`. Vacío = por confirmar                                                                           |
| `variable`                    | no          | `si` si el peso final puede variar (por defecto `si` en `lb`)                                                                   |
| `congelado`                   | no          | Por defecto `si`                                                                                                                |
| `sinonimos`                   | no          | Separados por `;` — alimentan la búsqueda                                                                                       |
| `descripcion`, `como_cocinar` | no          | Texto para la ficha                                                                                                             |
| `foto`                        | no          | URL `https://…` (hasta 300 caracteres), ruta pública `/photos/<sku>.webp` o vacío (ver «Fotos»); cualquier otra cosa se rechaza |
| `foto_ilustrativa`            | no          | `si` = imagen ilustrativa (la app lo rotula), `no` = foto real. Vacío = `si`                                                    |
| `activo`                      | no          | Por defecto `si`                                                                                                                |

El importador acepta cabeceras con o sin acentos, y archivos de Excel en español (separador `;` y coma decimal).

`foto_ilustrativa` es opcional y va al final: un CSV viejo sin esa columna sigue siendo válido y se importa como `si`. Acepta `si`/`no` (también `sí`, `true`/`false`, `1`/`0`) y las cabeceras `Foto ilustrativa`, `Ilustrativa` o `Imagen ilustrativa`. Marcar `no` en una fila sin `foto` da un aviso. La exportación del panel la incluye, así que exportar y volver a importar no pierde nada.

## Fotos

Una foto `foto` puede ser una URL completa (p. ej. del CDN de generación de imágenes), una ruta pública `/photos/<sku>.webp` que sirve el propio API, o vacío. El API vuelve absolutas las rutas `/photos/…` (con `PUBLIC_API_URL`) al responder, para que la app móvil pueda cargarlas.

```bash
npm run photos:apply -- --dry-run   # qué cambiaría en products.seed.csv según photos.manifest.json
npm run photos:apply                # escribe foto + foto_ilustrativa (no toca precios ni otros campos)
npm run photos:fetch -- --rewrite   # baja las imágenes a data/catalog/photos y deja foto=/photos/<sku>.webp
```

Detalles, opciones y límites: `docs/features/photos.md`.

## Validar sin tocar nada

```bash
npm run catalog:check                       # revisa la semilla
npm run catalog:check -- ruta/mi-inventario.csv
```

Muestra errores por fila (con SKU y campo), avisos (costo > precio, precios sospechosos) y cuántos artículos siguen bloqueados para publicar y por qué.
