# JELLYFISH

Comida congelada a domicilio en República Dominicana: carnes (res, cerdo, chivo), aves, pescados y mariscos, con cobro en la app. Android + iPhone.

## Estado

| Pieza                                                                                        | Estado                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/shared` — dinero DOP, ITBIS, pesos en libras, estados del pedido, tokens de diseño | Hecho, con pruebas                           |
| `packages/catalog` + `data/catalog` — 112 artículos de RD, importador CSV                    | Hecho, con pruebas                           |
| `apps/api` — catálogo, pedidos, inventario con reservas, zonas/franjas, OTP, roles           | Hecho, con pruebas                           |
| Pagos (AZUL, efectivo, transferencia) — `packages/payments`                                  | **Pendiente** (hito siguiente)               |
| App del cliente (Expo)                                                                       | **Pendiente**                                |
| Panel admin web                                                                              | **Pendiente**                                |
| App de repartidor                                                                            | **Pendiente**                                |
| Fotos del catálogo                                                                           | **Pendiente** (requiere aprobar presupuesto) |

## Cómo correrlo

```bash
npm install
npm test                 # 190 pruebas (Vitest + PGlite, Postgres real en memoria)
npm run typecheck        # API + paquetes + app del cliente
npm run e2e:customer     # recorre la app en Chromium contra el API real (capturas en tmp/e2e)
npm run catalog:check    # valida un CSV de inventario sin tocar nada
```

Servidor en **modo demo** (catálogo semilla, existencias y zona de ejemplo, códigos OTP impresos en consola):

```bash
JELLYFISH_DEMO=1 JELLYFISH_SEED=1 PORT=3000 npm run start -w @jellyfish/api
```

> El modo demo permite vender artículos con precio **estimado** o ITBIS **sin confirmar**. Nunca lo uses con clientes reales. Sin `JELLYFISH_DEMO`, un artículo solo es visible si su precio fue confirmado y su ITBIS definido (ver `data/catalog/README.md`).

## Decisiones clave

- **Dinero** en enteros de centavos y **peso** en centilibras: cero errores de coma flotante.
- **Precios con ITBIS incluido** (como en góndola); el ITBIS es por artículo y debe confirmarlo un contador.
- **El servidor recalcula todo** (precios, ITBIS, envío): la app nunca dicta un total.
- **Peso variable:** se pre-autoriza el estimado + 10 % y se cobra el peso real empacado.
- **Stock con reservas atómicas** (`on_hand − reserved ≥ cantidad` en un solo `UPDATE`) y bitácora de movimientos.
- **Pedidos idempotentes** (`Idempotency-Key`) para reintentos en redes móviles inestables.
- **El rol se lee de la base de datos**, no del token.

## Lo que todavía no está verificado

- **Postgres de producción:** el adaptador (`createPostgresDb`) usa la misma API de Drizzle pero **no se ha ejecutado contra un servidor real** (en el entorno de desarrollo no hay Postgres ni Docker). Las pruebas corren sobre PGlite.
- **Envío de códigos OTP:** solo existe el canal de consola (desarrollo). En producción el servidor se niega a arrancar hasta conectar SMS/WhatsApp.
- **Precios:** 13 son "ancla" (hallados vía buscador, sin verificar en tienda) y 99 son estimados. Ninguno es publicable hasta confirmarlo.
- **AZUL:** requiere afiliación del comercio y credenciales de pruebas.

## Cobro (cómo funciona)

- **Tarjeta:** la app abre la página de pago alojada por la pasarela (AZUL) en un navegador embebido; los datos de tarjeta **nunca pasan por JELLYFISH**. La pasarela redirige al API, que **verifica el hash HMAC-SHA512**, registra el pago de forma idempotente y confirma el pedido.
- **Cobro inmediato (Sale):** la Payment Page de AZUL cobra al instante, sin retención. Para peso variable se cobra el total estimado; al empacar, si el peso real cuesta menos, la diferencia queda en la cola de **devoluciones pendientes**; si cuesta más (hasta +10 %), el negocio la absorbe; si pasa de ahí, no se puede empacar hasta ajustar porciones.
- **Pagos tardíos o duplicados:** si el banco aprueba después de que venció la reserva (o hay dos intentos aprobados), el dinero se registra y queda marcado para devolver — nunca se pierde de vista.
- **Efectivo contra entrega:** el repartidor registra el monto exacto antes de marcar "entregado"; el administrador ve el **cuadre de caja** por repartidor y liquida lo que entregan.
- **Transferencia:** el cliente sube la referencia y el administrador verifica y confirma.
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
- Tarjeta: se abre la página de pago de la pasarela en el navegador seguro del sistema y se vuelve con `jellyfish://`.
- Modo claro/oscuro automático. Mientras no haya fotos reales, cada producto muestra un retrato con el ícono de su categoría.

**Qué se verificó:** el recorrido completo (buscar → producto → carrito → login con OTP → dirección → pedido en efectivo → pedido con tarjeta pagado en la pasarela simulada → pedidos → perfil) corre en Chromium con 0 errores de consola (`npm run e2e:customer`).
**Qué NO se ha verificado:** instalación en iPhone/Android, el navegador seguro nativo (`expo-web-browser`), teclado/`sms-otp`, almacenamiento seguro en Keychain/Keystore, notificaciones push, builds de EAS.
