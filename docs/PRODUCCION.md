# Lista para salir a producción

Lo construido funciona de punta a punta en pruebas (API contra PostgreSQL real, recorridos en navegador de las tres apps y la vista previa en teléfonos simulados), pero **todavía no está listo para clientes reales**. Esta es la lista honesta de lo que falta, en orden.

## 1. Cosas que solo tú puedes conseguir

| Qué                                                | Por qué                                                                                                                          | Cómo                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Afiliación a AZUL** y credenciales de pruebas    | Sin ellas no se puede cobrar con tarjeta                                                                                         | Solicitar "comercio electrónico" a AZUL (Banco Popular). Con las credenciales de pruebas se valida el hash; ver `packages/payments/src/azul.ts` |
| **Datos bancarios** para transferencias            | Se muestran al cliente                                                                                                           | Variables `TRANSFER_*`                                                                                                                          |
| **Contador**: ITBIS por producto y **e-CF (DGII)** | Obligación fiscal; el sistema deja el ITBIS "por confirmar" a propósito                                                          | Confirmar con el contador. Según la búsqueda, el plazo para pequeñas empresas es el **15-nov-2026** (verificar)                                 |
| **Permisos sanitarios** y cadena de frío           | Vender y transportar perecederos                                                                                                 | Consultar Ministerio de Salud Pública                                                                                                           |
| **Abogado**: términos, privacidad, devoluciones    | Ley 358-05 (consumidor) y Ley 172-13 (datos); Apple/Google exigen política de privacidad                                         | Redactar y publicar las URLs                                                                                                                    |
| Cuentas de tiendas                                 | Publicar las apps                                                                                                                | Apple Developer (US$ 99/año) y Google Play (US$ 25 único)                                                                                       |
| **Confirmar el ITBIS** del listado                 | El catálogo ya usa tus precios +15 %; **se asumió que el listado NO incluye ITBIS** y que los artículos con asterisco suman 18 % | Si tu listado ya lo incluía: `npm run catalog:from-xlsx -- --itbis incluido`, o confirmarlo con el contador                                     |

## 2. Lo que falta construir / conectar

Ya hecho y probado: remitentes de OTP por SMS (Twilio) y WhatsApp (Meta), notificaciones push (Expo), PostgreSQL real (`npm run test:pg` y el trabajo `postgres` de CI), prueba de entrega con **PIN**, **ubicación** del repartidor, "pedir de nuevo", cupones, favoritos, lotes con vencimiento (FEFO), bitácora de auditoría, `helmet`, Sentry opcional y `TRUST_PROXY`.

- [ ] **Probar los remitentes de OTP con el proveedor real.** Existen y se probaron contra un servidor HTTP local; falta una prueba con una cuenta real (Twilio solo entrega a números verificados en cuenta de prueba). Con `OTP_SENDER=twilio|whatsapp` y sus variables; el API se niega a arrancar en producción sin un remitente real.
- [ ] **Postgres gestionado.** Ya se validó contra PostgreSQL 16; falta elegir proveedor, configurar `DATABASE_URL` y **copias de seguridad** de la base.
- [ ] **Reembolsos automáticos con AZUL.** Hoy se registran a mano desde el panel después de hacerlos en el portal de AZUL.
- [ ] **Reconciliación de pagos perdidos** (consultar a AZUL pagos pendientes). Hoy el panel permite "Confirmar que el pago llegó" a mano.
- [ ] **Fotos de alta calidad en resolución completa** en el repositorio (hoy hay miniaturas de 480×360). Se hace desde una computadora con acceso al servidor de fotos (`npm run photos:fetch -- --rewrite`; ver `docs/features/photos.md`).
- [ ] **Pantalla de ganancias o historial del día** en la app del repartidor.
- [ ] **Datos del negocio y revisión legal** de los textos (`packages/shared/src/business.ts`, `docs/features/app-cliente.md`).
- [ ] Facturación electrónica e-CF (proveedor certificado por la DGII).
- [ ] Reseñas y programa de puntos (fase posterior).
- [ ] Hacer **privado** el repositorio de GitHub (hoy es público; el listado de costos del dueño nunca se versiona, pero conviene igual).

## 3. Lo que no se ha probado en dispositivos

Todo el código móvil se ejecutó como **web** en Chromium (los mismos componentes y el mismo API) y la vista previa se recorrió en un iPhone y un Pixel **simulados**. **No se ha probado en iPhone ni Android reales**: navegador seguro de pago (`expo-web-browser`), almacenamiento seguro, GPS y permisos de ubicación, teclado/autocompletado de SMS, notificaciones push, enlaces profundos `jellyfish://`, builds de EAS ni las tiendas. Reserva tiempo para una ronda de pruebas en teléfonos antes de publicar.

## 4. Variables de entorno del API

| Variable                                                                                                          | Obligatoria en producción    | Para qué                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `NODE_ENV=production`                                                                                             | sí                           | Activa los chequeos de seguridad                                 |
| `DATABASE_URL`                                                                                                    | sí                           | Postgres gestionado                                              |
| `JWT_SECRET` (≥ 32)                                                                                               | sí                           | Firma de sesiones                                                |
| `OTP_PEPPER` (≥ 16)                                                                                               | sí                           | Hash de códigos OTP                                              |
| `PUBLIC_API_URL`                                                                                                  | sí                           | AZUL redirige aquí al terminar el pago                           |
| `CORS_ORIGINS`                                                                                                    | sí                           | Dominio del panel (sin él, ningún sitio web puede llamar al API) |
| `BOOTSTRAP_ADMIN_PHONE`                                                                                           | primer arranque              | El primer administrador                                          |
| `AZUL_MERCHANT_ID`, `AZUL_MERCHANT_NAME`, `AZUL_MERCHANT_TYPE`, `AZUL_AUTH_KEY`, `AZUL_ENV`, `AZUL_HASH_ENCODING` | para cobrar con tarjeta      | Credenciales de AZUL                                             |
| `TRANSFER_BANK`, `TRANSFER_ACCOUNT_NUMBER`, `TRANSFER_HOLDER`, `TRANSFER_RNC`                                     | para transferencias          | Datos bancarios                                                  |
| `APP_SCHEME`                                                                                                      | no (por defecto `jellyfish`) | Enlace de regreso a la app                                       |

**Nunca** actives `JELLYFISH_DEMO=1` ni `PAYMENTS_MOCK=1` con clientes reales (el API rechaza `PAYMENTS_MOCK` en producción).
