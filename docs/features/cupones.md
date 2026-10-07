# Cupones de descuento

Código: `apps/api/src/services/coupons.ts` (reglas, anti-abuso, administración),
`apps/api/src/routes/coupons.ts` (rutas admin), cambios en `services/orders.ts` (cotizar, crear,
empacar, cancelar), `routes/orders.ts` y `routes/catalog.ts` (`couponCode` en `POST /v1/orders` y
`POST /v1/quote`) y los DTO en `packages/shared/src/api-types.ts`.
Pruebas: `apps/api/test/coupons.test.ts`. Esquema: tablas `coupons` y `coupon_redemptions`,
columnas `orders.coupon_code` y `orders.discount` (ya existían; no se tocó el esquema).

## Variables de entorno

Ninguna. No hay secretos ni configuración nueva.

## Reglas del cupón

| Campo                    | Significado                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `kind` = `percent`       | `value` en puntos básicos (1000 = 10 %), de 1 a 10000. Redondea hacia abajo.         |
| `kind` = `fixed`         | `value` en centavos, mayor que 0.                                                    |
| `kind` = `free_delivery` | Sin descuento en productos: el envío queda en 0. `value` = 0 y sin `maxDiscount`.    |
| `minSubtotal`            | Subtotal mínimo (centavos, ITBIS incluido, antes del cupón).                         |
| `maxDiscount`            | Tope del descuento en centavos (útil con porcentajes).                               |
| `startsAt` / `endsAt`    | Ventana. `startsAt` es inclusivo, `endsAt` es exclusivo (en ese instante ya venció). |
| `maxRedemptions`         | Usos totales; `null` = ilimitado.                                                    |
| `perUserLimit`           | Usos por persona (1 a 1000, por defecto 1).                                          |
| `active`                 | Desactivado = para la persona es un cupón que no existe (no revela que existió).     |

El código se guarda siempre en mayúsculas, sin espacios, de 3 a 20 caracteres `A-Z 0-9 -`. Lo que
escribe el cliente se normaliza igual (espacios, incluso invisibles, minúsculas, guiones largos del
teclado, letras de ancho completo): `"  verano -10 "` encuentra `VERANO-10`.

## Dinero e ITBIS

- Los precios ya incluyen ITBIS. El descuento se reparte entre las líneas en proporción a su monto
  bruto (`allocateProportionally`, método del mayor resto): suma EXACTA en centavos, ninguna línea queda
  negativa ni con más descuento que su monto. El ITBIS se recalcula por línea sobre el neto, así que un
  descuento baja el ITBIS solo de las líneas gravadas (0 % y 18 % mezclados).
- El descuento nunca supera el subtotal ni el tope; el total nunca es negativo.
- **Un pedido no puede quedar en RD$ 0** (no se podría cobrar en tarjeta, efectivo ni transferencia):
  con la zona conocida, un cupón que lo deje así se rechaza ("Este cupón cubre todo el pedido…"). Un
  100 % con envío de pago sí sirve: el cliente paga el envío.
- El **pedido mínimo de la zona** y el **envío gratis por monto** se siguen midiendo sobre el subtotal
  ANTES del cupón. Es una decisión de negocio a confirmar con el dueño.
- **Envío gratis**: `orders.discount` queda en 0, `delivery_fee` en 0 y la redención guarda como
  `amount` el envío que se perdonó. Si el envío ya es gratis por monto, el cupón se rechaza ("Tu envío ya es
  gratis…") para no gastarlo. Sin dirección todavía se acepta y ahorra 0 hasta conocer la zona.
- `QuoteDTO.coupon.discount` = lo que ahorra el cliente (descuento en productos o envío perdonado).

### Al pesar y empacar (peso real)

- **Porcentaje**: se recalcula sobre el monto real (con el tope del cupón).
- **Monto fijo**: se mantiene lo pactado (como máximo el monto real).
- **Envío gratis**: el envío sigue en 0.
- `orders.discount` conserva lo pactado al pedir; `finalTotal`/`finalItbis` usan el descuento final y
  `coupon_redemptions.amount` queda con el descuento realmente aplicado.
- La pre-autorización de tarjeta (`authorizedAmount`) ahora calcula el colchón de peso variable sobre
  el monto BRUTO de esas líneas: un descuento fijo no baja cuando el peso sube y, con el colchón sobre el
  neto, el empacado habría dado `overweight` antes de tiempo. Sin cupón el número es idéntico al de siempre.
- El mínimo del cupón no se vuelve a exigir al pesar (la promesa se hizo al pedir).

## Flujo

- `POST /v1/quote` con `couponCode` (opcional). **Un cupón inválido no hace fallar la cotización**:
  responde 200 con `coupon: null` y `couponError` en español ("Este cupón venció", "Necesitas RD$ 1,125.25
  más para usarlo", "Ya usaste este cupón", "Este cupón ya se agotó", …). La cotización es pública pero el
  cupón se valida contra una persona: hace falta `Authorization`; sin sesión válida responde
  `couponError: "Inicia sesión para usar un cupón"` (y no consulta la base).
- `POST /v1/orders` con `couponCode`: si no sirve, **rechaza** con 409 `coupon_invalid` y
  `details.reason` (`not_found`, `not_started`, `expired`, `exhausted`, `user_limit`, `below_minimum`,
  `no_benefit`, `covers_all`). Código vacío o solo espacios = sin cupón.
- Dentro de la transacción del pedido se revalida todo con la fila del cupón **bloqueada**
  (`SELECT … FOR UPDATE`): dos pedidos simultáneos hacen cola y el segundo ve el uso del primero, así que
  no se pasan de `maxRedemptions` ni de `perUserLimit`. Luego se inserta `coupon_redemptions` y se fija
  `orders.coupon_code` / `orders.discount`.
- **Reintentos con la misma `Idempotency-Key`** (doble toque, red que se corta): si dos llegan a la vez, el que pierde la carrera devuelve el pedido del ganador en lugar de un error. Con cupón, el perdedor choca primero con el uso que tomó el ganador (`coupon_invalid`); `createOrder` lo trata como reintento. De paso se arregló la detección del índice único (`orders_idem_uq`): buscaba el texto en el mensaje del driver, que trae el SQL y no el error, así que con Postgres real el perdedor recibía un 500 (ahora se mira el SQLSTATE 23505 en la cadena de `cause`).
- **Liberar**: al pasar a `cancelled` (cancelación del cliente o del personal, o vencimiento de la reserva
  sin pago) se borra la redención en la misma transacción, y los límites se recuperan. El pedido cancelado
  conserva `coupon_code` y `discount` como historia. Mientras un pedido de tarjeta espera el pago, el uso
  está tomado (hasta 15 minutos).
- Orden de bloqueos: franja (advisory) → fila del cupón → inventario. Siempre el mismo, sin ciclos. La
  edición del cupón por el admin toma la misma fila.

## Anti-abuso

Máximo **10 cupones inexistentes por persona y por hora**. Cuentan los códigos DISTINTOS que no existen
(o están desactivados); repetir el mismo no gasta intentos, y un cupón vencido, agotado o que pide más
compra NO cuenta (cotizar el carrito con un cupón que aún no alcanza no te castiga). Al llegar a 10:
cotizar responde `couponError` ("Probaste demasiados cupones que no existen. Intenta de nuevo en N
minutos") y crear el pedido responde 429 `rate_limited`; mientras dura el bloqueo ni un cupón válido se
prueba, para que no sigan adivinando. Detalle en "Límites conocidos".

## Administración (JSON, `Authorization: Bearer …`)

| Ruta                                    | Quién        | Qué                                                                     |
| --------------------------------------- | ------------ | ----------------------------------------------------------------------- |
| `GET /v1/admin/coupons`                 | admin, staff | Lista (`CouponDTO`): usos, total descontado, `status`, `termsLocked`.   |
| `POST /v1/admin/coupons`                | solo admin   | Crea (201). Valida estricto: campos desconocidos se rechazan.           |
| `PATCH /v1/admin/coupons/:id`           | solo admin   | Activar/desactivar, descripción, fechas, límites, mínimo.               |
| `GET /v1/admin/coupons/:id/redemptions` | admin, staff | Quién lo usó: pedido, estado, nombre del cliente, monto (sin teléfono). |

- Crear: `code` (3 a 20 `A-Z0-9-`), `kind`, `value`, y opcionales `description` (hasta 140),
  `minSubtotal`, `maxDiscount`, `startsAt`, `endsAt` (ISO 8601 con zona), `maxRedemptions`,
  `perUserLimit`, `active`. Código repetido, incluso cambiando mayúsculas: 409 `coupon_exists`.
- Con usos (redenciones vigentes) **no se pueden cambiar `kind`, `value` ni `maxDiscount`** (409
  `coupon_locked`): el peso real recalcula con esos valores. Fechas, límites, mínimo, descripción y
  estado siguen editables. Si todos sus pedidos se cancelaron, vuelven a ser editables. Mandar el mismo
  valor no cuenta como cambio.
- `status`: `active`, `paused`, `scheduled`, `expired`, `exhausted`.

## Cómo probarlo

```bash
npx vitest run apps/api/test/coupons.test.ts                                   # PGlite
export TEST_DATABASE_URL=$(npx tsx scripts/pg-local.ts url)                     # con un Postgres local ya iniciado
npx vitest run apps/api/test/coupons.test.ts                                   # Postgres real: la concurrencia es de verdad
```

Con PGlite las transacciones se serializan solas (una sola conexión): la prueba de concurrencia pasa
aunque falte el bloqueo. **Contra un Postgres real sí lo detecta** (se verificó quitando el
`FOR UPDATE` en una copia aislada: 3 a 4 pruebas fallan). Los pedidos de esas pruebas van a franjas
distintas a propósito: el pedido ya serializa por franja y en la misma franja no se probaría el cupón.

## Límites conocidos

- **El contador de intentos inválidos vive en la memoria del proceso**: se reinicia con el API y, con
  varias instancias, el límite real es por instancia (el esquema está congelado; guardarlo en base de datos
  pide una tabla o columna nueva). Frena el abuso casual, no es un control de seguridad duro; el acceso ya
  exige una cuenta con OTP.
- Cancelar libera SIEMPRE el cupón, también desde `delivery_failed`. Si el negocio prefiere no devolverlo
  cuando el cliente no recibió su pedido, es un cambio de una línea en `transitionOrderInTx`.
- Un pedido reembolsado después de entregado (`refunded`) no libera la redención (solo cancelación y
  vencimiento, como se pidió).
- El mínimo de pedido de la zona y el envío gratis por monto se miden antes del cupón (ver arriba).
- Las apps (cliente y panel) aún no muestran el campo de cupón ni la pantalla de administración; este
  cambio es solo API y tipos compartidos. Cualquier mock del API (p. ej. la vista previa web) debe traer
  `coupon: null` en la cotización.
- Contra un Postgres real, `vitest` a veces reporta 1 "Unhandled Error" (`57P01 terminating connection due to administrator command`) al cerrar la base de pruebas. Ocurre también con las pruebas de pedidos de siempre (es el cierre del pool en `test-db.ts`) y no afecta ningún resultado.
