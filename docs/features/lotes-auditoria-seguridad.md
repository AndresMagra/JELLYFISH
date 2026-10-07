# Lotes con vencimiento, bitácora de auditoría y seguridad del API

Código: `apps/api/src/services/lots.ts`, `routes/lots.ts` (lotes); `services/audit.ts`, `routes/audit.ts`
(bitácora); `plugins/security.ts`, `plugins/sentry.ts` (seguridad); cambios mínimos en `app.ts`, `config.ts`,
`server.ts`, `routes/admin.ts`, `services/reports.ts` y `packages/shared/src/api-types.ts`.
Pruebas: `apps/api/test/lots.test.ts`, `audit.test.ts`, `security.test.ts` (+ `sentry-smoke.ts`, que lanza la
prueba con el SDK real de Sentry en un proceso aparte). Sin cambios en el esquema: se usan `stock_lots` y `audit_log`.

## 1. Lotes con vencimiento (FEFO: primero en vencer, primero en salir)

**Reglas**

- `variants.on_hand` y `inventory_movements` siguen siendo la fuente de verdad del TOTAL. Los lotes dicen de dónde
  vino y cuándo vence. Invariante: la suma de `qty_remaining` de un artículo nunca supera su `on_hand`; la diferencia es
  **stock sin lote** (existencias anteriores a esta función, ajustes al alza, pedidos cancelados ya empacados).
- Los lotes **nunca bloquean la venta**: lo vendible sigue siendo `on_hand − reserved`. Un lote vencido se avisa, no se esconde.
- **Todo lo que baja `on_hand` descuenta también los lotes en orden FEFO** (vencimiento más cercano primero; a igual fecha,
  el que entró antes): empacar un pedido, mermas (`waste`) y ajustes negativos (`adjust` con delta < 0).
  Si los lotes no cubren la baja, se vacían y el resto sale del stock sin lote, sin error.
- Lo que sube `on_hand` sin recepción de lote (ajuste al alza, `receive` suelto por `/inventory/adjust`) queda **sin lote**.
  Para entradas con vencimiento hay que usar la recepción de lotes.
- Cancelar un pedido ya `packed` devuelve el stock a `on_hand` pero **sin lote** (no se registra de qué lote salió cada libra).
- Importar el catálogo con `applyStock=1` fija `on_hand` a un valor absoluto: justo después se corre `reconcileLots`,
  que descuenta FEFO el exceso si los lotes quedaron por encima del inventario.
- "Vence hoy" todavía es válido (`daysLeft = 0`, estado `expiring`); vencido es estrictamente antes de hoy (hora de RD, UTC-4).

**Endpoints** (personal: `admin` y `staff`)

| Método y ruta                                                   | Qué hace                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/admin/inventory/lots`                                 | Recibe un lote: crea el lote y suma al stock en UNA transacción (`adjustStock('receive')`)     |
| `GET /v1/admin/inventory/lots?variantId=&includeEmpty=1&limit=` | Lotes en orden FEFO; por defecto solo con saldo                                                |
| `GET /v1/admin/inventory/expiring?days=30`                      | Lotes con saldo que vencen en ≤ `days` (0–365, por defecto 30), **incluye los ya vencidos**    |
| `GET /v1/admin/summary`                                         | Añade `expiringSoon` (lotes con saldo que vencen en 0–7 días) y `expired` (vencidos con saldo) |

Cuerpo de la recepción: `{ variantId, lotCode, expiresOn: "AAAA-MM-DD", quantity, unitCostCentavos?, note? }`.
`quantity` va en las mismas unidades que `/inventory/adjust`: **centilibras** si el artículo es `lb` (1 lb = 100) y unidades
si es `unit`. Validaciones: fecha de calendario real, no vencida hace más de 30 días ni a más de 5 años; cantidad entera > 0;
código de 1 a 40 caracteres sin caracteres de control; el mismo código no se repite en un artículo (sin importar mayúsculas):
`409 lot_exists`, para que un doble clic o un reintento no cuenten la mercancía dos veces. Respuesta `201` con `daysLeft`
y `status` (`expired`, `expiring`, `ok`).

Al empacar (`packed`), el hook `afterTransition` compuesto en `app.ts` descuenta `finalQuantity ?? quantity` de cada artículo,
dentro de la misma transacción del `pick` del inventario. Los artículos se procesan en orden de id, igual que `pick`, para no
provocar interbloqueos entre pedidos que se empacan a la vez; los lotes se bloquean con `FOR UPDATE`.

## 2. Bitácora de auditoría

- Hook `onResponse`: registra en `audit_log` toda petición `POST/PUT/PATCH/DELETE` bajo `/v1/admin` y `/v1/driver`
  (también las rechazadas: 401/403/4xx con su motivo). No audita lecturas (GET), rutas inexistentes (404), las rechazadas por
  límite de peticiones (429: auditarlas amplificaría el abuso) ni `POST /v1/driver/location` (llega cada pocos segundos y
  son coordenadas de una persona).
- Cada fila: actor (`id` y rol de la sesión; vacío si no hubo sesión), método, **ruta con el patrón registrado**
  (`/v1/admin/orders/:id/transition`, sin ids), acción legible (`orders.transition`, `catalog.patch_variant`, `inventory.receive_lot`…;
  las rutas nuevas reciben un nombre automático `entidad.verbo`), entidad e id (de la ruta, del cuerpo o, en altas, de la respuesta),
  estado HTTP, resumen en español, IP real y payload saneado.
- **Saneamiento**: se quitan las claves `code`, `otp`, `pin`, `token`, `password`, `secret`, `authorization` (y variantes como
  `pushToken`, `deliveryPin`, `client_secret`, `otpCode`); los teléfonos se guardan enmascarados (`+1809*****34`); los textos se
  recortan a 200 caracteres; profundidad máxima 4, 20 elementos por arreglo, 30 claves por objeto; si todo pasa de 4000 bytes se
  guarda solo un resumen (`_truncated`); un cuerpo de texto (el CSV de importación) guarda solo su tamaño. Los parámetros de
  consulta saneados van en `_query`. Se conservan `lotCode`, `couponCode` y `pinOverrideReason` (el motivo de una anulación de PIN es justo lo que auditoría necesita).
- **Intentos de acceso fallidos** (`POST /v1/auth/otp/verify` con 4xx): solo si el teléfono es de un `admin` o `staff`. Acción
  `auth.login_failed`, teléfono enmascarado y motivo; nunca el código tecleado.
- Un fallo al escribir **no rompe la respuesta**: se registra en el log (solo el nombre del error y la acción) y la petición ya había terminado.
  Las escrituras pendientes se esperan al cerrar el servidor (`onClose`).
- `GET /v1/admin/audit?limit=50&before=&actorId=&action=` (solo `admin`): más reciente primero, paginado por cursor
  `{ items, nextCursor }` (el cursor es `fecha|id`, así varias filas con la misma hora no se pierden ni se repiten; `before`
  también acepta una fecha ISO). `action` es exacta o por prefijo (`orders.*`). `limit` 1–200. Incluye `actorName`.
- La API no ofrece cómo editar ni borrar filas.

## 3. Seguridad

| Qué                   | Cómo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cabeceras             | `@fastify/helmet`: CSP `default-src 'none'; frame-ancestors 'none'…`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP `cross-origin` (el panel y las apps leen el API por CORS), HSTS solo con `NODE_ENV=production`. Las páginas HTML del pago conservan su propia política (necesitan estilos y el formulario a AZUL). Todo `/v1/*` sale con `Cache-Control: no-store` salvo que la ruta defina otro.                                                                                 |
| IP real               | `TRUST_PROXY` (ver abajo). Alimenta el límite de peticiones y `audit_log.ip`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Logs                  | pino `redact` de `authorization`, `cookie`, `set-cookie`, y `body.code/otp/pin/token/password/secret/phone` (también bajo `req.body`); el registro de acceso oculta `?token=`, `?code=`, `?AuthHash=`… de la URL.                                                                                                                                                                                                                                                                                                |
| Cuerpos               | 256 KB por defecto; 5 MB solo en `POST /v1/admin/catalog/import`. Exceso: `413 payload_too_large` en español.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Límites de peticiones | Se suman a los 300/min globales y a los 10/10 min de pedir/verificar OTP: cualquier `/v1/auth/*` nuevo 20/10 min; `POST /v1/driver/orders/:id/transition` (PIN) 30/min; `POST /v1/driver/location` 120/min. Se aplican por IP y por ruta desde `plugins/security.ts` sin tocar los archivos de rutas.                                                                                                                                                                                                            |
| Entorno de producción | `validateProductionEnv(env)` (pura): exige `JWT_SECRET` ≥ 32 y no de muestra, `OTP_PEPPER` ≥ 16, `DATABASE_URL` (postgres://), `PUBLIC_API_URL` (https, no localhost), `CORS_ORIGINS` (https, sin `*` ni rutas) y prohíbe `PAYMENTS_MOCK`. Devuelve `{ ok, errors, warnings }`; `server.ts` la corre antes de abrir nada, imprime TODOS los problemas juntos y sale con código 1. Avisos (no impiden arrancar): `JELLYFISH_DEMO=1`, `TRUST_PROXY` sin definir o `true`, sin `SENTRY_DSN`. Nunca imprime valores. |
| Sentry                | Opcional (`SENTRY_DSN`). Solo se reportan los 5xx desde el manejador de errores, con método, patrón de ruta, estado e id de petición. Se quitan petición, usuario, migas de pan, extras, contextos y variables locales; los textos pasan por un filtro de teléfonos y tokens; sin sesiones (llevan usuario e IP). Sin DSN no se carga el SDK. Si el SDK falla al iniciar, el API sigue sin reporte.                                                                                                              |

**TRUST_PROXY**: sin definir/`0`/`false` no se confía en `X-Forwarded-For`. Un número N (`1` = un balanceador delante) toma la
última IP que añadió el balanceador, así que un cliente no puede falsificarla enviando su propia cabecera; **solo es seguro si
el API no es alcanzable sino a través del balanceador**. Fastify no acepta un número directamente (lo trata como "no confiar en
nadie" por la misma razón), por eso `toFastifyTrustProxy` lo convierte en una función. Más estricto: lista de IP/CIDR separadas por
comas o `loopback`, `linklocal`, `uniquelocal` (p. ej. `TRUST_PROXY=uniquelocal` si el balanceador está en una red privada).
`true` confía en toda la cadena y permite falsificar la IP: evítalo. Un valor inválido hace fallar el arranque.

## Variables de entorno

| Variable         | Obligatoria                          | Para qué                                       |
| ---------------- | ------------------------------------ | ---------------------------------------------- |
| `TRUST_PROXY`    | recomendada detrás de un balanceador | `1`, lista IP/CIDR o `uniquelocal`; ver arriba |
| `SENTRY_DSN`     | no                                   | Activa el reporte de errores 5xx               |
| `SENTRY_RELEASE` | no                                   | Versión que se muestra en Sentry               |

Las demás (`JWT_SECRET`, `OTP_PEPPER`, `DATABASE_URL`, `PUBLIC_API_URL`, `CORS_ORIGINS`) ya existían; ahora se validan juntas al arrancar en producción.
Ninguna se guarda en archivos: todas por entorno. Falta añadir `TRUST_PROXY`, `SENTRY_DSN` y `SENTRY_RELEASE` a la tabla de `docs/PRODUCCION.md` (no era mi archivo).

## Cómo probarlo

```
npx vitest run apps/api/test/lots.test.ts apps/api/test/audit.test.ts apps/api/test/security.test.ts
export TEST_DATABASE_URL=$(npx tsx scripts/pg-local.ts url)   # las mismas pruebas contra PostgreSQL 16 real
```

A mano: `POST /v1/admin/inventory/lots` con un artículo, `GET /v1/admin/inventory/expiring?days=60`, empacar un pedido y repetir el
listado; `GET /v1/admin/audit?action=inventory.*`; `curl -i /health` para ver las cabeceras; `NODE_ENV=production npm start -w @jellyfish/api`
sin variables para ver la lista de lo que falta.

## Límites conocidos

- La bitácora crece sin límite: no hay purga automática (hay que definir cuánto tiempo conservarla; es una decisión legal/del negocio).
- Al empacar no se guarda de qué lote salió cada libra (no hay tabla de asignaciones): por eso cancelar un pedido ya empacado devuelve
  el stock sin lote y no hay "trazabilidad hacia adelante" (qué clientes recibieron el lote X) si hubiera que retirar un lote.
- Los lotes no se pueden editar ni dar de baja uno por uno desde la API: una baja manual descuenta FEFO. Una corrección de fecha o de
  cantidad de un lote hoy se haría con SQL.
- Un lote sin fecha (`expires_on` nulo) no se puede crear por la API; si existiera, se ordena al final y no cuenta como por vencer.
- Los límites de peticiones son por proceso (memoria): con varias instancias del API cada una cuenta aparte.
- Sentry: probado con el SDK real y un transporte falso (sin red); el envío a los servidores de Sentry y el panel no se han visto.
- `TRUST_PROXY` con número es correcto solo si nadie puede llegar al API saltándose el balanceador (reglas de red del hosting).
