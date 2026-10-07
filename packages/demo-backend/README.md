# @jellyfish/demo-backend

Servidor de demostración que vive **dentro del navegador**: reemplaza `fetch` para la dirección del API y
contesta como el API real, con datos de ejemplo. Es lo que hace posible la vista previa web de la app del
cliente (ver [docs/VISTA-PREVIA.md](../../docs/VISTA-PREVIA.md)).

```ts
import { installDemoBackend } from '@jellyfish/demo-backend';

const demo = installDemoBackend({
  baseUrl: 'https://demo.jellyfish.local', // solo se atienden las URLs que empiezan así
  catalogCsv, // data/catalog/products.seed.csv
  categories, // data/catalog/categories.json
  photos, // [{ sku, url, illustrative }] del manifiesto de fotos
  speed: 1, // 2 = el pedido avanza el doble de rápido
});
demo.uninstall(); // devuelve fetch a como estaba
```

- Todo lo que no empieza con `baseUrl` pasa al `fetch` de verdad.
- Sin dependencias de Node: corre en el navegador (el bundle IIFE sale de `scripts/build-preview.ts`).
- Reutiliza el código real: `computeOrderTotals` y compañía de `@jellyfish/shared`, `parseCatalogCsv` y
  `groupProducts` de `@jellyfish/catalog`. No reescribe reglas de dinero.
- El estado (usuarios, direcciones, pedidos, existencias) se guarda en `localStorage` con `try/catch`; sin
  almacenamiento funciona igual, solo en memoria.
- El ciclo del pedido (confirmado → preparando → empacado → en camino con PIN → entregado) se calcula a partir
  del reloj cada vez que se consulta, así que sigue avanzando aunque la página haya estado cerrada y se
  prueba con un reloj falso.

## Pruebas

```bash
npx vitest run packages/demo-backend
```

- `contract.test.ts` levanta el **API real** (buildApp + PGlite) y este servidor, corre los mismos escenarios por
  HTTP en los dos y compara la forma de cada respuesta, los estados HTTP y los códigos y mensajes de error.
  Si cambia el API y el simulador no, falla.
- `contract-mutation.test.ts` demuestra que esa comparación detecta desviaciones (se "rompe" el simulador de
  siete maneras y cada una debe ser detectada).
- `lifecycle.test.ts` prueba el ciclo del pedido, la tarjeta simulada, la transferencia, los vencimientos y la
  persistencia con un reloj falso.
- `server.test.ts`, `coupons.test.ts`, `util.test.ts`: catálogo, búsqueda, zona, franjas, cotización, cuenta,
  direcciones, pedidos, cupones y `installDemoBackend`.
- `preview-shell.test.ts`, `demo-phone.test.ts`: las piezas de `scripts/build-preview.ts` y
  `scripts/demo-phone.ts`.

Las claves que el simulador ya devuelve (porque están en `packages/shared/src/api-types.ts`) pero que el API
real todavía no emite se anotan en `PENDING_IN_REAL_API` (`test/contract-lib.ts`); hoy está vacía.
