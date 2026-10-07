# Envío real de OTP y notificaciones push

## Qué hace

**OTP (código de acceso por teléfono).** `createOtpSender(env)` elige el canal con `OTP_SENDER`:

| Valor      | Canal                                             | Cuándo                                        |
| ---------- | ------------------------------------------------- | --------------------------------------------- |
| `console`  | Imprime el código en la consola                   | Solo desarrollo. **Prohibido en producción.** |
| `twilio`   | SMS por la API REST de Twilio                     | Producción                                    |
| `whatsapp` | Plantilla de autenticación por WhatsApp Cloud API | Producción                                    |

Sin `OTP_SENDER`: en desarrollo usa `console`; en producción el API **no arranca**. Todas las variables del canal se validan al arrancar y el error nombra cada una que falta (sin imprimir valores). El SMS dice: _"Tu código de JELLYFISH es 123456. Vence en 10 minutos. No lo compartas con nadie."_ La vigencia sale de `config.otpTtlMinutes` (hoy 10), la misma que usa el vencimiento del código.

Cada intento tiene plazo de 8 s (`AbortController`) y hay **un** reintento solo ante error de red, tiempo agotado o 5xx (nunca ante 4xx, ni 429). Si el proveedor falla, la persona recibe `503 otp_delivery_failed` con un texto genérico; el detalle (estado HTTP, código del proveedor, mensaje depurado) va al log **sin el código y con el teléfono enmascarado** (`+1809*****23`). Las reglas anti-abuso (≤ 3 códigos / 10 min, 5 intentos) no cambiaron.

**Push (Expo).**

- `POST /v1/me/devices {token, platform: ios|android|web}`: registra o refresca el dispositivo (upsert por token; si el token era de otra cuenta pasa a la actual). Valida `ExponentPushToken[…]` / `ExpoPushToken[…]`. Se conservan los 10 dispositivos más recientes por persona.
- `DELETE /v1/me/devices/:token`: quita el dispositivo (siempre 204; solo borra los propios). Al eliminar la cuenta se borran todos sus dispositivos.
- `PATCH /v1/me` ya no acepta `pushToken` (se ignora). La columna `users.push_token` queda sin usar.
- Avisos en español: cliente en cada estado (confirmado, preparando, empacado, en camino, entregado, entrega fallida, cancelado, reembolsado); repartidor al asignarle un pedido; staff/admin cuando entra un pedido ya confirmado (efectivo al crearlo; tarjeta/transferencia al confirmarse el pago). Todo `data` es `{type:'order', orderId}`. **El PIN de entrega nunca viaja en la notificación**: "en camino" solo recuerda tenerlo a mano si el pedido tiene PIN.

### Por qué solo se avisa tras el commit

Los `OrderHooks` corren dentro de la transacción. El hook de push no envía nada: anota el id del `order_events` que acaba de insertar en una cola por petición (`AsyncLocalStorage`, abierta en `preHandler`). Al enviar la respuesta (`onSend`) se programa el envío **sin esperarlo**, y antes de enviar se comprueba que ese evento ya existe en la base fuera de la transacción: eso solo es cierto si hizo commit. Por eso un rollback no avisa **aunque el código llamante atrape el error y responda 200**, y un push lento o caído no retrasa ni rompe la operación. El mensaje se arma con el pedido ya confirmado (estado y PIN reales). El temporizador de reservas vencidas usa `app.push.scope(...)` para lo mismo; cualquier otra transición fuera de petición y sin cola se cubre esperando a ver el evento confirmado (hasta ~5 s).

## Variables de entorno

| Variable                                           | Obligatoria      | Para qué                                                                       |
| -------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------ |
| `OTP_SENDER`                                       | sí en producción | `twilio` o `whatsapp` (`console` solo en desarrollo)                           |
| `TWILIO_ACCOUNT_SID`                               | con `twilio`     | Empieza con `AC`                                                               |
| `TWILIO_AUTH_TOKEN`                                | con `twilio`     | Secreto                                                                        |
| `TWILIO_FROM` **o** `TWILIO_MESSAGING_SERVICE_SID` | con `twilio`     | Remitente en E.164 (+1…) o servicio `MG…` (si están los dos, gana el servicio) |
| `WHATSAPP_PHONE_NUMBER_ID`                         | con `whatsapp`   | ID del número en Meta                                                          |
| `WHATSAPP_ACCESS_TOKEN`                            | con `whatsapp`   | Token de acceso permanente                                                     |
| `WHATSAPP_OTP_TEMPLATE`                            | con `whatsapp`   | Nombre de la plantilla de categoría **autenticación** aprobada                 |
| `WHATSAPP_OTP_LANGUAGE`                            | no (`es`)        | Idioma con el que se aprobó la plantilla                                       |
| `PUSH_ENABLED`                                     | no               | `1/0` o `true/false`. Por defecto activo, salvo `NODE_ENV=test`                |
| `EXPO_ACCESS_TOKEN`                                | no               | Solo si el proyecto de Expo exige "enhanced push security"                     |

Los secretos van solo por variables de entorno: nada se escribe en archivos ni en logs (no se registran teléfonos completos, códigos, PIN ni tokens).

## Cómo probarlo

```bash
npx vitest run apps/api/test/otp-senders.test.ts apps/api/test/push.test.ts
npx tsc --noEmit -p .
```

Las pruebas usan `fetch` y transporte falsos (cuerpo y cabeceras exactos, reintentos, plazo de 8 s con reloj simulado, rollback, tokens muertos, PIN). Prueba manual de OTP real: arrancar con `OTP_SENDER=twilio` y las variables, pedir un código a un número propio (con la cuenta de prueba de Twilio solo llega a números verificados). Prueba manual de push: abrir la app en un teléfono, registrar el token (`POST /v1/me/devices`) y confirmar un pedido en efectivo.

## Límites conocidos

- **Nada se probó contra Twilio, Meta ni Expo reales** (sin credenciales ni red hacia ellos aquí): los formatos de petición siguen la documentación de cada API pero se verificaron solo con dobles. Probar en staging antes de abrir a clientes.
- **WhatsApp:** el texto que ve el cliente lo fija la plantilla aprobada en Meta, no este código (su vigencia se define al crear la plantilla). Hay que crear la plantilla de autenticación con botón "copiar código" y mantener su vigencia alineada con `OTP_TTL_MINUTES`. Un timeout puede dejar un mensaje ya entregado aunque la persona vea el error (y el reintento duplicarlo).
- Si el envío del OTP falla, ese código cuenta dentro del límite de 3 por 10 minutos (no se tocó la regla anti-abuso).
- **Costo del SMS:** el texto lleva tilde ("código"), así que viaja como Unicode: ~81 caracteres son 2 segmentos (se cobra el doble que un SMS de 1 segmento). Quitando la tilde cabe en 1. Se dejó con tilde porque así se pidió el texto; es decisión del dueño según el costo por mensaje.
- **Recibos de Expo:** los tickets se interpretan al enviar; los recibos (donde Expo suele reportar `DeviceNotRegistered`) se consultan a los 15 min **desde memoria**: si el servidor se reinicia se pierden los pendientes. El token muerto se limpia igual en el siguiente envío.
- Si el proceso se cae entre el commit y el envío, ese aviso se pierde (no hay cola durable). Los avisos fuera de petición y sin `app.push.scope` esperan ~5 s a ver el commit; una transacción más larga no avisa.
- Los pedidos que cambian de estado con SQL directo (sin pasar por `transitionOrder`) no generan avisos.
- No hay preferencias de notificación por persona ni push web (`platform: web` se acepta, pero el token debe ser de Expo).
