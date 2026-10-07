# Entrega: PIN, ubicación del repartidor y pedir de nuevo

Código: `apps/api/src/services/delivery.ts`, `apps/api/src/routes/delivery.ts` (rutas nuevas),
`transitionOrder` en `services/orders.ts` (puerta del PIN) y los DTO en
`packages/shared/src/api-types.ts`. Pruebas: `apps/api/test/delivery.test.ts`.

## 1. PIN de entrega

- Al crear el pedido se genera un PIN de 4 dígitos (`crypto.randomInt`) dentro de la misma
  transacción (hook `afterCreate` compuesto en `app.ts`). Se guarda en `orders.delivery_pin`.
- **Quién lo ve:** solo el cliente dueño, en `OrderDTO.deliveryPin`, y solo con el pedido
  `confirmed`, `picking`, `packed`, `out_for_delivery` o `delivery_failed`. Para repartidor, personal,
  administrador y cualquier otro cliente siempre es `null`. Hay una sola función que arma el DTO
  (`toOrderDTO`, que recibe quién mira); sin `scope.userId` la vista es interna (sin PIN).
- **Entrega del repartidor:** `POST /v1/driver/orders/:id/transition` con `{ "to": "delivered", "pin": "1234" }`.
  El PIN se compara en tiempo constante. El cobro exacto en efectivo se revisa ANTES (un repartidor
  que no cobró recibe `cash_not_collected` sin gastar intentos).
- **Bloqueo:** 5 intentos fallidos por pedido. Se cuentan con eventos del pedido (`order_events`
  con estado de origen = destino y nota `PIN incorrecto (intento N de 5)`), así que sobreviven a
  reinicios y a varias instancias del API; el PIN tecleado nunca se guarda. Un pedido bloqueado
  solo se entrega con la anulación del personal. Los intentos se serializan con el `FOR UPDATE` del pedido.
- **Anulación:** `POST /v1/admin/orders/:id/transition` con `{ "to": "delivered", "pinOverrideReason": "…≥ 8 caracteres" }`
  (admin o staff). Se guarda en `orders.pin_override_reason` y en el evento. El cliente no ve ese motivo.
- Pedidos sin PIN (anteriores a esta función, o creados sin los hooks del API) se entregan como antes.
- La regla vive en `transitionOrderInTx`: cualquier camino que marque `delivered` pasa por ella.

| Código                                | HTTP | Cuándo                                                 |
| ------------------------------------- | ---- | ------------------------------------------------------ |
| `pin_required`                        | 400  | El repartidor no mandó PIN                             |
| `validation`                          | 400  | PIN que no son 4 dígitos (no cuenta como intento)      |
| `pin_incorrect`                       | 409  | PIN equivocado; `details.attemptsLeft`                 |
| `pin_locked`                          | 423  | Se acabaron los intentos (también con el PIN correcto) |
| `pin_override_required`               | 400  | Personal sin motivo de al menos 8 caracteres           |
| `cash_not_collected` / `wrong_amount` | 409  | Reglas de efectivo de siempre                          |

`OrderDTO` trae además `pinRequired`, `pinAttemptsLeft` (0 = bloqueado, `null` = sin PIN),
`pinVerifiedAt` y `pinOverrideReason` (solo vista interna).

## 2. Ubicación del repartidor

- `POST /v1/driver/location` (rol repartidor): `{ latitude, longitude, accuracyM?, orderId? }`.
  Solo coordenadas dentro de RD (lat 17.3 a 20.1, lng -72.1 a -68.2; `isInDominicanRepublic` en `@jellyfish/shared`).
  Con `orderId`, el pedido debe estar asignado a ese repartidor (403) y existir (404).
  Máximo una actualización cada 4 s por repartidor (429 `rate_limited`, `details.retryAfterMs`); se controla
  con un `INSERT … ON CONFLICT … WHERE` atómico, sin memoria del proceso. Una fila por repartidor, sin historial.
- `GET /v1/orders/:id/tracking` (solo el cliente dueño; otros reciben 404):
  `{ available: true, latitude, longitude, updatedAt, ageSeconds }` si el pedido está `out_for_delivery` y la
  posición tiene 180 s o menos; si no, `{ available: false, reason }` con `not_out_for_delivery`, `no_driver`,
  `no_position` o `stale`. Va con `Cache-Control: no-store` y no expone al repartidor.
- **Privacidad:** al pasar a `delivered`, `delivery_failed` o `cancelled` se borra la posición (hook
  `afterTransition`), salvo que ese repartidor aún lleve otro pedido en camino (entonces solo se desvincula
  del pedido terminado y se borra con el último).
- Direcciones: `latitude`/`longitude` del cliente se validan dentro de RD y viajan en `OrderDTO.address`
  (siempre presentes; `null` si no hay) para que el repartidor navegue con coordenadas.

## 3. Pedir de nuevo

`GET /v1/orders/:id/reorder` (cliente dueño). Devuelve cada línea contra el catálogo de HOY:
`unitPrice` actual (y `previousUnitPrice`), `requestedQuantity`, `quantity` (ajustada a existencias, máximo por
línea, mínimo y paso, por lo que siempre se puede cotizar) y `status`: `ok`, `reduced` o `unavailable` con `reason`.
Usa `variantBlockers` de `services/catalog.ts`, así que respeta el modo demo y la publicación igual que
`listProducts`. No toca el carrito ni el inventario. Si el mínimo subió desde la última compra, la línea sube
al mínimo (`ok` con `reason`).

## Variables de entorno

Ninguna nueva.

## Cómo probarlo

```
npx vitest run apps/api/test/delivery.test.ts
```

A mano (API en modo demo): crear un pedido en efectivo como cliente y leer `deliveryPin`; pasarlo a
`out_for_delivery` desde el panel; como repartidor, `collect` y luego `transition` con el `pin`.

## Límites conocidos

- Las apps móviles todavía no usan esto: la app del repartidor debe mandar `pin` al marcar la entrega (hoy
  recibirá `pin_required`), enviar la ubicación (GPS en segundo plano no se pudo probar aquí) y la del cliente
  debe mostrar el PIN, el mapa de seguimiento y el botón de pedir de nuevo.
- El seguimiento es por consulta repetida (polling), no en tiempo real.
- El PIN se guarda en texto plano en la base (el cliente tiene que poder verlo); es de bajo valor y de un solo uso.
- Latitud y longitud se validan por separado: no se exige mandar las dos juntas.
- Si la app del repartidor se cierra sin terminar la entrega, su última posición queda en la base hasta la
  siguiente transición (el cliente deja de verla a los 3 minutos). No hay limpieza periódica.
- La bitácora de auditoría (si registra cuerpos de petición) debe redactar el campo `pin`.
