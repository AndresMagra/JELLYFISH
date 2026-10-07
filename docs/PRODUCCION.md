# Lista para salir a producción

Lo construido hasta ahora funciona de punta a punta en pruebas, pero **todavía no está listo para clientes reales**. Esta es la lista honesta de lo que falta, en orden.

## 1. Cosas que solo tú puedes conseguir

| Qué                                                | Por qué                                                                                  | Cómo                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Afiliación a AZUL** y credenciales de pruebas    | Sin ellas no se puede cobrar con tarjeta                                                 | Solicitar "comercio electrónico" a AZUL (Banco Popular). Con las credenciales de pruebas se valida el hash; ver `packages/payments/src/azul.ts` |
| **Datos bancarios** para transferencias            | Se muestran al cliente                                                                   | Variables `TRANSFER_*`                                                                                                                          |
| **Contador**: ITBIS por producto y **e-CF (DGII)** | Obligación fiscal; el sistema deja el ITBIS "por confirmar" a propósito                  | Confirmar con el contador. Según la búsqueda, el plazo para pequeñas empresas es el **15-nov-2026** (verificar)                                 |
| **Permisos sanitarios** y cadena de frío           | Vender y transportar perecederos                                                         | Consultar Ministerio de Salud Pública                                                                                                           |
| **Abogado**: términos, privacidad, devoluciones    | Ley 358-05 (consumidor) y Ley 172-13 (datos); Apple/Google exigen política de privacidad | Redactar y publicar las URLs                                                                                                                    |
| Cuentas de tiendas                                 | Publicar las apps                                                                        | Apple Developer (US$ 99/año) y Google Play (US$ 25 único)                                                                                       |
| Tu **inventario y precios reales**                 | Reemplazan los 99 estimados                                                              | Panel → Catálogo → Importar CSV                                                                                                                 |

## 2. Lo que falta construir / conectar

- [ ] **Envío real de códigos OTP** (SMS o WhatsApp). Hoy solo existe el canal de consola y el API **se niega a arrancar en producción** sin uno (`apps/api/src/server.ts`). Implementar `OtpSender` con un proveedor (p. ej. Twilio Verify o la API de WhatsApp de Meta).
- [ ] **Postgres gestionado.** El adaptador `createPostgresDb` existe pero **nunca se ejecutó contra un servidor real** (en desarrollo no había Postgres ni Docker). Probar en staging primero.
- [ ] **Reembolsos automáticos con AZUL.** Hoy se registran a mano desde el panel después de hacerlos en el portal de AZUL.
- [ ] **Reconciliación de pagos perdidos** (consultar a AZUL pagos pendientes). Hoy el panel permite "Confirmar que el pago llegó" a mano.
- [ ] **Fotos reales de los productos** (ver `data/catalog/README.md`).
- [ ] **Notificaciones push** y avisos por WhatsApp (estado del pedido).
- [ ] **Prueba de entrega** (foto + código PIN) y **ubicación en vivo** del repartidor.
- [ ] **Mapa con pin** en la dirección del cliente (hoy solo texto + referencia).
- [ ] Cupones, reseñas, favoritos, "pedir de nuevo", programa de puntos.
- [ ] Lotes y vencimientos de inventario (FEFO).
- [ ] Facturación electrónica e-CF (proveedor certificado por la DGII).
- [ ] Sentry/analítica, copias de seguridad de la base de datos, `@fastify/helmet`.

## 3. Lo que no se ha probado en dispositivos

Todo el código móvil se ejecutó como **web** en Chromium (los mismos componentes y el mismo API). **No se ha probado en iPhone ni Android reales**: navegador seguro de pago (`expo-web-browser`), almacenamiento seguro, teclado/autocompletado de SMS, enlaces profundos `jellyfish://`, builds de EAS ni las tiendas. Reserva tiempo para una ronda de pruebas en teléfonos antes de publicar.

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
