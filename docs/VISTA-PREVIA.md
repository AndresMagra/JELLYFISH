# Vista previa web de JELLYFISH

Una forma de **ver y tocar la app del cliente ya**, en tu iPhone o en tu Android, **sin instalar nada y sin
computadora**: abres un enlace privado y la app corre dentro del navegador del teléfono, con productos,
precios y pedidos de ejemplo.

## Qué es (y en qué se diferencia de la app instalada)

Es **la misma app** (Expo exportada a web). Lo único distinto es de dónde salen los datos: en la vista previa
no hay servidor en internet; dentro de la página vive un **servidor de demostración** (`packages/demo-backend`)
que contesta las mismas peticiones que contestaría el API de verdad, con las mismas reglas de dinero
(precios por libra, ITBIS incluido, envío, pedido mínimo, peso real al empacar), los mismos mensajes de
error y la misma forma de respuesta. Una prueba automática compara el servidor de demostración contra el API
real cada vez que se corren las pruebas, para que no se desvíen.

|               | Vista previa (web)                                                    | App instalada (iPhone/Android)       |
| ------------- | --------------------------------------------------------------------- | ------------------------------------ |
| Se abre con   | Un enlace en el navegador                                             | Tienda de apps / Expo Go             |
| Datos         | De ejemplo, guardados solo en tu teléfono                             | Reales, en el servidor               |
| Catálogo      | Los 38 productos reales con sus fotos ilustrativas                    | Igual                                |
| Entrar        | Cualquier celular dominicano; el código es **123456**                 | SMS o WhatsApp real                  |
| Tarjeta       | Se "aprueba" sola a los 2 segundos; no se abre ninguna pasarela       | Pasarela del banco (AZUL)            |
| Pedido        | Avanza solo, ≈ 25 s por etapa, hasta Entregado                        | Lo mueve el personal y el repartidor |
| Seguimiento   | Un repartidor simulado se mueve entre dos puntos de Santo Domingo     | GPS real del repartidor              |
| Avisos (push) | No hay                                                                | Sí                                   |
| Mapa          | "Ver en el mapa" abre el mapa de tu teléfono con ese punto de ejemplo | Igual, con el punto real             |

## Cómo abrirla en el teléfono

El dueño (o quien publique la página) te pasa un enlace. Ábrelo con el navegador del teléfono:

- **iPhone: Safari.** Para que quede como una app: toca el botón **Compartir** (el cuadrito con la flecha hacia
  arriba) → **Agregar a pantalla de inicio** → **Agregar**. Se abre a pantalla completa, con el ícono de la
  medusa y el fondo azul de la marca.
- **Android: Chrome.** Toca los tres puntos **⋮** → **Instalar app** (o **Agregar a la pantalla principal**) →
  **Instalar**.

Se puede usar también sin instalarla; instalarla solo la hace más cómoda.

**Arriba siempre ves una cinta amarilla** con el texto _VISTA PREVIA · datos de ejemplo · código de prueba
123456_. Es para que nadie confunda esto con la app de verdad. El botón **Reiniciar** de la cinta borra la
sesión, el carrito y los pedidos de ejemplo y empieza de cero.

### Qué probar

1. **Inicio, categorías y búsqueda.** Busca `camaron` (sin tilde) o `gambas` (sinónimo).
2. **Producto con variantes.** Camarón: elige un calibre (16/20, 21/25…). Se vende por libra; el total es un
   estimado y se ajusta al peso real.
3. **Carrito → pagar.** Te pide iniciar sesión: pon cualquier celular dominicano (`809-555-1234`) y el código
   **123456** (cualquier código de 6 dígitos sirve).
4. **Dirección.** Cubiertos: Naco, Piantini, Evaristo Morales, Bella Vista, Los Prados, Gazcue y otros sectores
   de la capital. Prueba también una ciudad como _Santiago_ para ver el aviso de "aún no llegamos".
   Pedido mínimo RD$ 800; envío RD$ 150, gratis desde RD$ 4,000.
5. **Pagar** con efectivo, tarjeta (se aprueba sola) o transferencia (escribe cualquier referencia; se "verifica"
   a los pocos segundos).
6. **Seguir el pedido.** Confirmado → Preparando → Empacado → **En camino** (con tu **PIN de entrega** de 4
   dígitos y el seguimiento del repartidor) → Entregado. Pesa de verdad: el total final puede variar un poco.
7. **Pedir de nuevo** desde un pedido entregado, **cancelar** mientras está Confirmado, **favoritos** y los
   textos legales en Perfil.
8. **Cupones de ejemplo** (en el carrito o al pagar): `BIENVENIDO10` (10 %, hasta RD$ 500, compra desde
   RD$ 1,000), `AHORRA200` (RD$ 200 menos desde RD$ 1,500) y `ENVIOGRATIS`.

### Atajos en la dirección del enlace

| Agrega al final del enlace | Hace                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `?speed=3`                 | El pedido avanza 3 veces más rápido (`?speed=0.5` más lento). |
| `?reset=1`                 | Empieza de cero: borra sesión, carrito y pedidos de ejemplo.  |

## Cómo reconstruirla y publicarla

Necesita una computadora con el proyecto (una sola vez por cambio).

```bash
npm run preview:build        # arma dist-preview/ (≈ 1–2 minutos)
npm run e2e:preview          # (opcional) la recorre con iPhone 14 y Pixel 7 simulados, sin internet
```

Qué hace `preview:build` (`scripts/build-preview.ts`):

1. Prepara los datos de ejemplo: `data/catalog/products.seed.csv`, `categories.json` y las fotos de
   `photos.manifest.json` (usa la versión liviana `minUrl`; la etiqueta "Imagen ilustrativa" sigue lo que diga cada
   foto).
2. Exporta la app del cliente a web con `EXPO_PUBLIC_API_URL=https://demo.jellyfish.local` y
   `EXPO_PUBLIC_DEMO=1` (ese interruptor solo se enciende en web; en un build nativo no hace nada).
3. Empaqueta el servidor de demostración en un solo archivo (esbuild) y lo carga **antes** que la app.
4. Parchea el bundle para que sirva en **cualquier subcarpeta**: rutas relativas para scripts, fuentes e
   imágenes y la base del router calculada al abrir la página.
5. Escribe `index.html` (cinta, metaetiquetas de iPhone/Android, ícono, manifest para instalarla) y los íconos
   a partir de `apps/customer/assets`.
6. Descarta las fuentes que el código no usa, **recorta las fuentes de íconos** a los glifos que la app dibuja
   (MaterialCommunityIcons pasa de 1.3 MB a ≈ 15 KB; si `subset-font` no estuviera instalado se publicarían
   completas, ≈ 1.7 MB más) y escribe `dist-preview/preview-manifest.json` con la lista de archivos, sus
   tamaños y si cumple los límites de publicación.

Resultado típico: **≈ 42 archivos, ≈ 3.3 MB** (sin sourcemaps; el más grande es la app, ≈ 1.9 MB; el
servidor de demostración pesa ≈ 140 KB y las fuentes de texto ≈ 0.5 MB). Límites de una página privada: ≤ 255
archivos, ≤ 16 MB por archivo y ≤ 64 MB en total; el script avisa (y falla) si algo los excede.

**Para publicar**, sube la carpeta `dist-preview/` completa tal cual (con sus subcarpetas `js/`, `assets/` e
`icons/`); `index.html` es la página. Puede quedar en la raíz o en una subcarpeta cualquiera
(`https://…/artifact/xyz/`): al abrirse, la página prueba dónde está pidiendo `jf-probe.json` y fija sola su
carpeta base. El enlace es privado: no pongas datos reales en la demostración.

Para verla en tu propia computadora antes de publicarla: `npx tsx scripts/e2e-preview.ts --serve` y abre la
dirección que escribe (hay una en la raíz y otra en una subcarpeta).

### Si cambia algo del API o de la app

- **Cambió el API** (un campo nuevo, un mensaje distinto): corre `npx vitest run packages/demo-backend`. Si la
  prueba de contrato falla, dice qué respuesta y qué campo se desvió; se arregla en `packages/demo-backend/src`.
- **Cambió la versión de Expo:** si `preview:build` se queja de que "no se pudo parchear el bundle", hay que
  actualizar los patrones de `patchAppBundle` en `scripts/preview-shell.ts` (la prueba
  `preview-shell.test.ts` los cubre).
- **Cambió el catálogo o las fotos:** basta volver a correr `preview:build`.

## Límites (qué NO hace)

- **Los datos son de ejemplo.** Nada sale de tu teléfono; los pedidos viven en el almacenamiento del navegador
  (`localStorage`). Si el navegador no lo permite (modo privado, datos bloqueados) la página funciona igual, pero
  al recargar se pierde todo.
- **No hay avisos (push).** Los navegadores del teléfono no los dan para esta página.
- **No hay GPS real.** El repartidor es una simulación entre dos puntos de Santo Domingo.
- **No hay pago real.** La tarjeta se aprueba sola; no se abre ni se cobra nada.
- **Las fotos necesitan internet** (están en un CDN): sin conexión se ven los íconos de cada categoría. Todo lo
  demás (la app y el servidor de demostración) viaja dentro de la página.
- **Existencias holgadas** (100–400 lb por artículo): si agotas alguna con muchos pedidos de prueba, usa
  **Reiniciar**.
- **Recargar dentro de una pantalla interna** (por ejemplo, el detalle de un producto) funciona gracias a un
  pequeño _service worker_ que solo existe en https o en localhost; en otros casos, al recargar vuelve al inicio.
  El _service worker_ no guarda nada en caché, así que nunca muestra una versión vieja.
- **iPhone:** la app de la pantalla de inicio y Safari **no comparten datos**: si entraste desde Safari, al abrir el
  ícono vas a empezar de cero (es normal). Además, Safari puede borrar los datos de una página que no está en la
  pantalla de inicio si no la usas en unas semanas; instalarla ayuda.
- Es una vista previa de **la app del cliente**; la del repartidor y el panel de administración no están aquí.

## Y si tienes computadora: la app real en tu teléfono (Expo Go)

```bash
npm run demo:phone                    # app del cliente
npm run demo:phone -- --app driver    # app del repartidor
npm run demo:phone -- --check         # solo revisa tu red (IP y firewall)
```

Arranca el API en modo demostración (con catálogo y pagos simulados), arranca Expo apuntando a la IP de tu red y
te muestra un código QR: en iPhone, ábrelo con la cámara (Expo Go); en Android, desde Expo Go →
_Scan QR code_. El teléfono y la computadora tienen que estar en el mismo Wi‑Fi. Detecta y te avisa de VPN, de
varias redes, de la IP que no sirve y del firewall (macOS, Windows y Linux). Con Ctrl+C apaga todo.

El código de verificación sale en esa misma consola (línea marcada con ★); cuando el API tenga la variable
`DEMO_OTP_CODE` será siempre `123456`.

## Si algo no sale bien

- **Pantalla "No pudimos abrir la vista previa":** casi siempre es conexión o que se publicó solo el
  `index.html`; hay que subir la carpeta completa. Toca _Reintentar_.
- **Se ve la app pero sin fotos:** el teléfono no alcanzó el CDN de las fotos; es normal sin internet.
- **Quedó "viejo" lo que ves:** ábrela con `?reset=1` al final del enlace.
- **Cambié algo y no se ve:** el enlace sirve archivos con nombre nuevo en cada compilación; vuelve a publicar la
  carpeta completa y borra la versión anterior.
