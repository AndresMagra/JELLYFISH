# Pasar a trabajar en tu computadora (y poner las fotos de alta calidad)

La nube sirvió para construir todo, pero **no puede descargar las fotos originales**: el servidor donde se generaron (`d8j0ntlcm91z4.cloudfront.net`) está bloqueado desde ese entorno. Desde tu computadora sí se puede. Esta guía es el paso a paso, en el orden en que conviene hacerlo.

> Hoy el repositorio trae, por cada uno de los 38 artículos, una **miniatura de 480×360** (`data/catalog/photos/<sku>.thumb.webp`). Es lo que se ve en la vista previa del teléfono. El objetivo de este paso es tener además la foto **completa** (`<sku>.webp`, hasta 1168 px de ancho) para la ficha del producto, y que la app use la miniatura solo en listas y tarjetas.

## 0. Qué necesitas

- **Node 22 o más nuevo** (`node -v`) y **Git**.
- Una conexión a internet normal (sin proxy corporativo que bloquee `cloudfront.net`; si lo hay, ver el final).
- Unos 15 minutos y ~10 MB libres.

## 1. Traer el proyecto

```bash
git clone https://github.com/AndresMagra/JELLYFISH.git
cd JELLYFISH
git checkout claude/festive-gates-ehxtbf
npm install
```

(Si ya tienes la carpeta: `git pull` dentro de ella.) Comprueba que todo está sano antes de tocar nada:

```bash
npm run typecheck
npm test            # unos minutos; todo debe pasar
```

## 2. Descargar las fotos de alta calidad

```bash
npm run photos:apply -- --dry-run       # (opcional) qué cambiaría en el catálogo; no escribe nada
npm run photos:fetch -- --rewrite
```

Qué hace `photos:fetch --rewrite`, por cada SKU de `data/catalog/photos.manifest.json`:

- baja la imagen original y la verifica (HTTP 200, es una imagen, ancho ≥ 480 px, ≤ 25 MB);
- guarda `data/catalog/photos/<sku>.webp` (ancho máximo 1168, calidad 85) y `<sku>.thumb.webp` (480 px, calidad 80);
- cambia en `data/catalog/products.seed.csv` la columna `foto` a `/photos/<sku>.webp` (así el API sirve las fotos él mismo y no dependes de un servidor externo). Una foto real que tú hayas puesto a mano **no se pisa**.

Al terminar debe decir que bajó 38 de 38. Si alguna falla, repite el comando: solo vuelve a bajar lo que falte (`--force` repite todo; `--only JF-MAR-001,JF-MAR-002` repite solo esas).

**Mira las fotos** (abre la carpeta `data/catalog/photos/`): fondo negro uniforme, el producto completo y sin texto raro. Si alguna se ve mal, anota su SKU: se regenera aparte (paso 6).

## 3. Comprobar que el catálogo sigue bien

```bash
npm run catalog:check                                   # 38 filas válidas, sin errores
npx vitest run packages/catalog packages/shared apps/api/test/photos.test.ts
```

## 4. Verlas en la app

La forma más simple, con el teléfono en la misma red Wi‑Fi:

```bash
npm run demo:phone
```

Escribe un código QR y las direcciones (ver `docs/APPS-MOVILES.md`). Abre una ficha de producto: debe verse la foto grande nítida, y en las tarjetas de la lista, la miniatura (la app pide `/photos/<sku>.thumb.webp` y, si no existiera, cae a la foto completa).

Para el servidor por separado: `PUBLIC_API_URL=http://TU-IP:3000 JELLYFISH_DEMO=1 JELLYFISH_SEED=1 PORT=3000 npm run start -w @jellyfish/api` (la `PUBLIC_API_URL` es la dirección que el teléfono puede alcanzar; si no, las fotos salen con `localhost` y el teléfono no las ve).

## 5. Guardar en Git

```bash
git status                          # deben aparecer data/catalog/photos/ y products.seed.csv
git add data/catalog
git commit -m "Fotos de alta calidad: foto completa y miniatura por artículo"
git push
```

No toques `data/private/` (tu listado de precios): está ignorado a propósito y nunca debe subirse.

## 6. Si una foto no te gusta: regenerarla

La regeneración usa el servicio de imágenes (Higgsfield) desde un chat de Claude con ese conector activo. En ese chat dile: _"regenera la foto del SKU JF-XXX-NNN: fondo negro absoluto, producto completo, sin texto"_. Cuando termine, actualiza el manifiesto y baja solo esa foto:

```bash
npm run photos:apply                                   # pone la nueva URL en el catálogo
npm run photos:fetch -- --rewrite --force --only JF-XXX-NNN
```

## 7. Volver a publicar la vista previa del teléfono

La vista previa usa las miniaturas (≈ 3 MB en total). Después de cambiar fotos:

```bash
npm run preview:build
```

y pídele a Claude que vuelva a publicar la página (la publicación se hace con su herramienta de artefactos, no desde tu computadora). Detalles en `docs/VISTA-PREVIA.md`.

## Si descargar falla

| Síntoma                         | Qué pasa                                       | Qué hacer                                                                                                              |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `fetch failed` / tiempo agotado | Red o cortafuegos que bloquea `cloudfront.net` | Prueba con otra red (datos del teléfono). Detrás de un proxy: `NODE_USE_ENV_PROXY=1 npm run photos:fetch -- --rewrite` |
| `HTTP 403` o `404` en un SKU    | La URL de ese SKU caducó o cambió              | Regenera esa foto (paso 6)                                                                                             |
| `ancho menor de 480`            | La imagen original es demasiado chica          | Regenerarla                                                                                                            |
| `npm install` falla con `sharp` | No bajó el binario de tu sistema               | `npm rebuild sharp` o actualizar Node                                                                                  |

## Trabajar en local sin gastar de más

- **Una tarea concreta por vez** («baja las fotos y dime cuáles se ven mal»): el uso se va sobre todo en tareas largas y en varios agentes a la vez.
- Pídele que **no lance flujos con muchos agentes** salvo que lo necesites; para cambios pequeños basta una sola sesión.
- Dile qué archivo o pantalla quieres cambiar: así no tiene que explorar todo el proyecto.
- Lo que se repite siempre está en `package.json` (scripts) y en `docs/`: pídele que lea el documento correspondiente en vez de reexplicarlo.
