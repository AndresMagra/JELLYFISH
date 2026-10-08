# JELLYFISH

Comida congelada a domicilio en República Dominicana: res, cerdo, aves, pescados y mariscos, con cobro en la app. Android + iPhone, panel de administración web y app para repartidores.

El catálogo es el del dueño: **38 artículos** (29 fichas) tomados de su listado de precios interno, con un beneficio del 15 % sobre el precio del listado y el ITBIS donde el listado lo marca con asterisco.

## Estado

| Pieza                                                                                                         | Estado                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/shared` — dinero DOP, ITBIS, pesos en libras, estados del pedido, textos legales, tokens de diseño  | Hecho, con pruebas (incluidas pruebas de propiedades)                    |
| `packages/catalog` + `data/catalog` — catálogo real de 38 artículos, importador CSV y del Excel del dueño     | Hecho, con pruebas                                                       |
| `apps/api` — catálogo, pedidos, inventario con reservas y lotes, cupones, PIN de entrega, bitácora, OTP, push | Hecho; probado en PGlite **y en PostgreSQL 16 real**                     |
| `packages/payments` — AZUL, efectivo, transferencia, simulador                                                | Hecho; **AZUL real sin probar** (faltan credenciales)                    |
| `apps/customer` — app del cliente (Expo)                                                                      | Hecha; probada como web en Chromium y en la vista previa                 |
| `apps/admin` — panel web                                                                                      | Hecho: pedidos, catálogo, lista de precios, inventario y lotes, cupones… |
| `apps/driver` — app del repartidor                                                                            | Hecha: entregas, PIN, ubicación, cobro en efectivo                       |
| `packages/demo-backend` — servidor de demostración dentro de la página                                        | Hecho: alimenta la vista previa en el teléfono                           |
| Fotos del catálogo                                                                                            | 38 miniaturas incluidas; **las de alta calidad se ponen desde local**    |
| Instalación en iPhone/Android reales, AZUL, SMS/WhatsApp, e-CF                                                | **Pendiente** (ver `docs/PRODUCCION.md` y `docs/APPS-MOVILES.md`)        |

## Cómo correrlo

```bash
npm install
npm test                 # toda la suite (Vitest + PGlite, Postgres embebido)
npm run test:pg          # el API contra PostgreSQL 16 real (arranca uno local; ver scripts/pg-local.ts)
npm run typecheck        # API + paquetes + las tres apps
npm run format:check     # Prettier
npm run catalog:check    # valida un CSV de inventario sin tocar nada
```

Recorridos de punta a punta en Chromium contra el API real (capturas en `tmp/`):

```bash
npm run e2e:customer     # app del cliente: buscar, carrito, OTP, dirección, cupón, efectivo y tarjeta, PIN, seguimiento, pedir de nuevo
npm run e2e:admin        # panel: catálogo y bloqueo, fotos, lotes y vencimientos, cupones, bitácora, entrega sin PIN, caja, móvil
npm run e2e:driver       # repartidor: 3 entregas, ubicación, cobro, PIN incorrecto y bloqueo, entrega fallida
npm run e2e:pricelist    # Lista de precios del panel con el Excel del dueño (local, nunca versionado)
npm run e2e:preview      # la vista previa web en iPhone y Pixel simulados, sin internet
```

Servidor en **modo demo** (catálogo semilla, existencias y zona de ejemplo, códigos OTP impresos en consola):

```bash
JELLYFISH_DEMO=1 JELLYFISH_SEED=1 PORT=3000 npm run start -w @jellyfish/api
```

> El modo demo permite vender artículos con precio **estimado** o ITBIS **sin confirmar**. Nunca lo uses con clientes reales. Sin `JELLYFISH_DEMO`, un artículo solo es visible si su precio fue confirmado y su ITBIS definido (ver `data/catalog/README.md`). El catálogo actual ya viene confirmado, así que se publica sin modo demo.

## Verla en tu teléfono

- **Sin instalar nada:** la vista previa web (`npm run preview:build`) es la misma app con un servidor de demostración dentro de la página. Ver `docs/VISTA-PREVIA.md`.
- **En tu red, con Expo Go:** `npm run demo:phone` levanta el API en modo demo y la app, y escribe el código QR. Ver `docs/APPS-MOVILES.md`.
- **Instalada de verdad:** compilaciones de EAS para Android (APK de prueba) e iPhone (TestFlight). Ver `docs/APPS-MOVILES.md`.

## Decisiones clave

- **Dinero** en enteros de centavos y **peso** en centilibras: cero errores de coma flotante.
- **Precios con ITBIS incluido** (como en góndola). El precio de venta sale del listado del dueño: `precio × 1.15 (beneficio) × 1.18 (si lleva asterisco)`, con un único redondeo (`consumerPrice` en `packages/catalog`). El ITBIS es por artículo y debe confirmarlo un contador. Si el listado ya incluyera el ITBIS, `npm run catalog:from-xlsx -- --itbis incluido` lo regenera con un solo comando.
- **El servidor recalcula todo** (precios, ITBIS, envío, descuento): la app nunca dicta un total.
- **Peso variable:** se pre-autoriza el estimado + 10 % y se cobra el peso real empacado.
- **Stock con reservas atómicas** (`on_hand − reserved ≥ cantidad` en un solo `UPDATE`), lotes con vencimiento (FEFO) y bitácora de movimientos.
- **Pedidos idempotentes** (`Idempotency-Key`) para reintentos en redes móviles inestables.
- **Entrega con PIN** de 4 dígitos que solo ve el cliente; el personal puede entregar sin PIN dejando un motivo que el cliente no ve.
- **El rol se lee de la base de datos**, no del token. Todo cambio del personal queda en la **bitácora** (sin PIN, códigos ni tokens).
- **Datos internos del dueño** (listado de precios, costos) viven solo en `data/private/` y nunca se versionan.

## Lo que todavía no está verificado

- **AZUL:** requiere afiliación del comercio y credenciales de pruebas (ver abajo).
- **Teléfonos reales:** el código móvil se probó como web, con la vista previa en iPhone/Pixel simulados y en las pruebas; no se ha instalado en un iPhone o Android físico (navegador seguro de pago, Keychain/Keystore, GPS, notificaciones push, EAS).
- **Envío de códigos OTP:** los remitentes de Twilio (SMS) y de WhatsApp Cloud están escritos y probados contra un servidor HTTP local, no contra los proveedores reales.
- **Fotos:** son imágenes ilustrativas generadas; las de alta calidad en resolución completa no están en el repositorio porque el servidor de fotos no es accesible desde el entorno de desarrollo en la nube. Se descargan desde una computadora normal: `docs/LOCAL.md` (detalles en `docs/features/photos.md`).
- **Reembolsos con AZUL y e-CF (DGII):** no integrados.

## Cobro (cómo funciona)

- **Tarjeta:** la app abre la página de pago alojada por la pasarela (AZUL) en un navegador embebido; los datos de tarjeta **nunca pasan por JELLYFISH**. La pasarela redirige al API, que **verifica el hash HMAC-SHA512**, registra el pago de forma idempotente y confirma el pedido.
- **Cobro inmediato (Sale):** la Payment Page de AZUL cobra al instante, sin retención. Para peso variable se cobra el total estimado; al empacar, si el peso real cuesta menos, la diferencia queda en la cola de **devoluciones pendientes**; si cuesta más (hasta +10 %), el negocio la absorbe; si pasa de ahí, no se puede empacar hasta ajustar porciones.
- **Pagos tardíos o duplicados:** si el banco aprueba después de que venció la reserva (o hay dos intentos aprobados), el dinero se registra y queda marcado para devolver — nunca se pierde de vista.
- **Efectivo contra entrega:** el repartidor registra el monto exacto antes de marcar "entregado"; el administrador ve el **cuadre de caja** por repartidor y liquida lo que entregan.
- **Transferencia:** el cliente sube la referencia y el administrador verifica y confirma.
- **Cupones:** porcentaje, monto fijo o envío gratis, con mínimo, tope, vigencia, usos totales y por persona (`docs/features/cupones.md`).
- **Reembolsos:** la API de reembolsos de AZUL **no está integrada**; el panel lleva la cola y el administrador registra la devolución hecha en el portal de AZUL (`mark-refunded`).

Variables de entorno de pagos (ver `apps/api/src/config.ts`): `AZUL_MERCHANT_ID`, `AZUL_MERCHANT_NAME`, `AZUL_MERCHANT_TYPE`, `AZUL_AUTH_KEY`, `AZUL_ENV` (`test`|`production`), `AZUL_HASH_ENCODING` (`utf8`|`utf16le`), `PUBLIC_API_URL`, `APP_SCHEME`, `TRANSFER_BANK`, `TRANSFER_ACCOUNT_NUMBER`, `TRANSFER_HOLDER`, `PAYMENTS_MOCK=1` (solo desarrollo).

### ⚠️ AZUL: qué falta verificar antes de cobrar a clientes reales

El orden de campos del hash, los endpoints y el formato de montos coinciden con una implementación pública de terceros, **no con la documentación oficial ni con el ambiente de pruebas de AZUL** (requiere afiliación). Primer paso al tener credenciales: una transacción de prueba en `pruebas.azul.com.do`; si AZUL rechaza el hash, probar `AZUL_HASH_ENCODING=utf16le`.

## App del cliente

```bash
cp apps/customer/.env.example apps/customer/.env   # EXPO_PUBLIC_API_URL
npm run start -w @jellyfish/customer               # Expo (QR para Expo Go, `w` para web)
```

- En el **emulador de Android** usa `http://10.0.2.2:3000`; en un **teléfono físico**, la IP de tu computadora.
- Se puede navegar y llenar el carrito **sin cuenta**; el celular (OTP) se pide al pagar.
- Búsqueda con sinónimos dominicanos, variantes (calibres, presentaciones), cupón, dirección con ubicación opcional, horario de entrega, tarjeta o efectivo, **PIN de entrega**, **seguimiento** del repartidor, **pedir de nuevo**, favoritos y notificaciones push. Detalle en `docs/features/app-cliente.md`.
- Fotos sobre fondo negro; las generadas llevan la etiqueta **«Imagen ilustrativa»**.
- Textos legales (términos, privacidad, devoluciones, cadena de frío) como borrador: **faltan los datos del negocio y la revisión de un abogado** (`packages/shared/src/business.ts`).

## Panel de administración

```bash
cp apps/admin/.env.example apps/admin/.env     # VITE_API_URL
npm run dev -w @jellyfish/admin                # http://localhost:5173
```

- Entra con tu celular (OTP). El **primer administrador** se define con `BOOTSTRAP_ADMIN_PHONE=809…` al arrancar el API; después agregas repartidores y personal desde **Equipo**.
- **Catálogo y precios** y **Lista de precios:** edita precio/ITBIS/costo; sube tu Excel para actualizar precios con el beneficio que elijas (primero muestra qué cambiaría). Cada artículo permite editar su **foto** y si es «Imagen ilustrativa».
- **Pedidos:** tablero que se actualiza solo; en el detalle se registran los pesos reales, se asigna repartidor, se cobra el efectivo y se cierra la entrega. La tarjeta **Entrega** muestra el estado del PIN y permite **«Entregar sin PIN»** con un motivo (mínimo 8 caracteres).
- **Inventario:** existencias, ajustes y **lotes con vencimiento**; el Resumen avisa de lo que vence en 7 días o ya venció.
- **Cupones** y **Bitácora** (esta última solo para el administrador): quién cambió qué y cuándo, sin datos secretos.
- **Pagos y caja:** devoluciones pendientes, transferencias por verificar y el cuadre de efectivo por repartidor.
- Producción: define `CORS_ORIGINS=https://tu-panel.example` en el API (por defecto, en producción, no acepta ningún origen web).

## App del repartidor

```bash
cp apps/driver/.env.example apps/driver/.env     # EXPO_PUBLIC_API_URL
npm run start -w @jellyfish/driver
```

Entra con su celular (el administrador lo agrega en **Equipo**). Ve sus entregas asignadas, abre la ruta en **Waze o Google Maps**, llama o escribe por WhatsApp al cliente, comparte su ubicación mientras va en camino, **cobra el monto exacto en efectivo** (no puede marcar «entregado» sin cobrar) y cierra la entrega con el **PIN** que le dice el cliente (5 intentos; después solo el personal puede cerrarla) o reporta por qué no pudo entregar. Comparte tema, componentes, sesión y login con la app del cliente mediante `packages/mobile-core`.

**Todavía no incluye:** pantalla de ganancias o historial del día.

> **Antes de abrir a clientes reales lee `docs/PRODUCCION.md`.**
