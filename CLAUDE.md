# JELLYFISH — guía para Claude

App de **comida congelada a domicilio en República Dominicana** (res, cerdo, aves, pescados y mariscos). Es el negocio del dueño: vende a consumidor final. Monorepo npm workspaces, TypeScript estricto. Idioma del producto y de los textos: **español dominicano, tratamiento de tú**.

## Mapa

| Carpeta                             | Qué es                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api`                          | Fastify + Drizzle. PGlite (Postgres embebido) en desarrollo y pruebas, PostgreSQL en producción   |
| `apps/customer`, `apps/driver`      | Apps Expo (React Native) del cliente y del repartidor; comparten `packages/mobile-core`           |
| `apps/admin`                        | Panel web (Vite + React)                                                                          |
| `packages/shared`                   | Dinero, ITBIS, pesos, estados del pedido, tipos del API, textos legales                           |
| `packages/catalog` + `data/catalog` | Importador CSV/Excel y el catálogo real (38 artículos, 29 fichas)                                 |
| `packages/payments`                 | AZUL, efectivo, transferencia, simulador                                                          |
| `packages/demo-backend`             | Servidor de demostración dentro de la página (vista previa en el teléfono)                        |
| `scripts/`                          | e2e (Playwright), fotos, catálogo, vista previa, `pg-local.ts`                                    |
| `docs/`                             | `LOCAL.md` (paso a local), `APPS-MOVILES.md`, `VISTA-PREVIA.md`, `PRODUCCION.md`, `features/*.md` |

## Comandos

```bash
npm test                 # toda la suite (≈1 300 pruebas; unos minutos)
npm run test:pg          # el API contra PostgreSQL 16 real (necesita Postgres instalado)
npm run typecheck        # API + paquetes + tres apps
npm run format:check     # Prettier (el repo entero debe pasar)
npm run e2e:admin | e2e:customer | e2e:driver | e2e:pricelist | e2e:preview
npm run demo:phone       # API demo + Expo con QR para probar en el teléfono
```

Antes de dar algo por terminado: `npm run typecheck`, `npx vitest run <lo que tocaste>` y `npx prettier --check .`.

## Reglas que no se rompen

- **Dinero en centavos enteros** de DOP; **pesos en centilibras**; ITBIS en puntos básicos (1800 = 18 %). Nunca coma flotante para dinero.
- **Los precios en góndola incluyen ITBIS.** El servidor recalcula todo (precios, ITBIS, envío, descuento): la app nunca dicta un total.
- **Precio de venta** = precio del listado del dueño × 1.15 (beneficio) × 1.18 si el artículo lleva asterisco en el listado. **Confirmado por el dueño.** Un solo redondeo (`consumerPrice` en `packages/catalog/src/pricelist.ts`).
- **Datos internos del dueño** (el Excel de precios, costos) viven en `data/private/` y **nunca se versionan** (`.gitignore` ya lo cubre, también `*.xlsx`). El repositorio es público: no escribas costos ni el listado en ningún archivo, prueba, captura ni mensaje de commit. Las pruebas usan cifras inventadas.
- Las fotos generadas llevan la etiqueta **«Imagen ilustrativa»** (`photoIllustrative`). Las fotos van sobre fondo negro uniforme.
- Nada se publica a clientes si el precio es `estimado` o el ITBIS es `null` (salvo `JELLYFISH_DEMO=1`, que **nunca** se usa con clientes reales).
- Lo que el cliente nunca debe ver: el motivo interno de «Entregar sin PIN» y cualquier dato de la bitácora. El PIN de entrega solo lo ve el cliente dueño.
- Cada arreglo lleva una prueba que **falle sin él**. Los recorridos e2e no deben aceptar aserciones que siempre pasan.

## Cómo trabajar (ahorra uso)

- Una tarea concreta por vez. No lances flujos con muchos agentes en paralelo salvo que se pida: el uso se va ahí.
- Lee el documento que corresponde en `docs/` antes de explorar el código a ciegas.
- No hagas commit de `tmp/`, `dist-preview/`, `apps/*/dist` ni capturas. No abras un PR salvo que se pida; trabaja en la rama indicada y haz `git push`.
- Los comentarios del código van en español, pocos, y explican el porqué.

## Estado y pendientes (octubre 2026)

Hecho y probado: API, tres apps, panel completo (cupones, bitácora, lotes con vencimiento, fotos, entrega sin PIN), catálogo real, vista previa en teléfono simulado, PostgreSQL 16 real.

Pendiente: fotos de alta calidad en resolución completa (`docs/LOCAL.md`), probar en iPhone/Android físicos y compilar con EAS (`docs/APPS-MOVILES.md`), credenciales de AZUL, proveedores de OTP reales, datos del negocio y revisión legal de los textos, e-CF (DGII), repositorio a privado. Ideas sin hacer: línea «ITBIS incluido» en la app del cliente, pantalla de ganancias del repartidor.
