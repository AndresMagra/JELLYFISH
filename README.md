# JELLYFISH

Comida congelada a domicilio en República Dominicana: carnes (res, cerdo, chivo), aves, pescados y mariscos, con cobro en la app. Android + iPhone.

## Estado

| Pieza                                                                                        | Estado                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/shared` — dinero DOP, ITBIS, pesos en libras, estados del pedido, tokens de diseño | Hecho, con pruebas                           |
| `packages/catalog` + `data/catalog` — 112 artículos de RD, importador CSV                    | Hecho, con pruebas                           |
| `apps/api` — catálogo, pedidos, inventario con reservas, zonas/franjas, OTP, roles           | Hecho, con pruebas (134 en total)            |
| Pagos (AZUL, efectivo, transferencia) — `packages/payments`                                  | **Pendiente** (hito siguiente)               |
| App del cliente (Expo)                                                                       | **Pendiente**                                |
| Panel admin web                                                                              | **Pendiente**                                |
| App de repartidor                                                                            | **Pendiente**                                |
| Fotos del catálogo                                                                           | **Pendiente** (requiere aprobar presupuesto) |

## Cómo correrlo

```bash
npm install
npm test                 # 134 pruebas (Vitest + PGlite, Postgres real en memoria)
npm run typecheck
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
