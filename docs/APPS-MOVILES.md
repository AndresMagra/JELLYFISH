# Apps móviles: verlas en tu teléfono y publicarlas

JELLYFISH tiene **dos apps** hechas con Expo (la misma base de código para iPhone y Android):

| App            | Para quién                      | Carpeta         | Nombre en el teléfono | Identificador (`bundle id`) | Enlace profundo       |
| -------------- | ------------------------------- | --------------- | --------------------- | --------------------------- | --------------------- |
| **Cliente**    | Tus clientes (consumidor final) | `apps/customer` | JELLYFISH             | `do.jellyfish.app`          | `jellyfish://`        |
| **Repartidor** | Tus repartidores (uso privado)  | `apps/driver`   | JELLYFISH Repartidor  | `do.jellyfish.driver`       | `jellyfish-driver://` |

> **Honestidad primero.** Todo el código móvil se ha recorrido de punta a punta **en navegador (Chromium)** contra el API real. **Todavía no se ha instalado en un iPhone ni en un Android de verdad.** Esta guía te lleva a hacerlo; lo que dependa de reglas externas (Apple, Google, Expo) está marcado como **por verificar** porque esas reglas cambian. Reserva una tarde para la primera ronda de pruebas en teléfonos.

Hay dos caminos, de menor a mayor esfuerzo:

1. **Expo Go** (sección 1): ves la app **hoy mismo**, gratis, sin cuentas. Es una vista previa: no es la app instalable definitiva.
2. **App real con EAS** (sección 2): un instalable propio (APK en Android; en iPhone requiere cuenta de Apple de pago). Es lo que le das a probar a otras personas y lo que luego se sube a las tiendas (sección 3).

---

## 1. Verla YA en un teléfono con Expo Go

**Qué necesitas:** tu computadora con el proyecto (`npm install` ya hecho, Node 20 o más nuevo) y el teléfono **conectado a la misma red WiFi** que la computadora.

### 1.1 Enciende el servidor (API) en tu computadora

```bash
JELLYFISH_DEMO=1 JELLYFISH_SEED=1 PORT=3000 npm run start -w @jellyfish/api
```

En modo demo los códigos de acceso (OTP) **se imprimen en esta terminal** (no se envía ningún SMS). Déjala abierta. El modo demo permite vender artículos con precio o ITBIS sin confirmar: **nunca lo uses con clientes reales** (ver `docs/PRODUCCION.md`).

### 1.2 Averigua la dirección de tu computadora en la red

El teléfono no puede usar `localhost` (para el teléfono, `localhost` es el propio teléfono). Necesitas la IP local de tu computadora, algo como `192.168.1.50`:

| Sistema | Comando                                                   |
| ------- | --------------------------------------------------------- |
| Mac     | `ipconfig getifaddr en0` (si no sale nada, prueba `en1`)  |
| Windows | `ipconfig` y copia la «Dirección IPv4» del adaptador WiFi |
| Linux   | `hostname -I` y toma la primera                           |

**Prueba rápida:** abre el navegador del teléfono y entra a `http://TU-IP:3000/health`. Debe responder `{"status":"ok",...}`. Si no abre, el teléfono no alcanza a la computadora (ver «Errores comunes»).

### 1.3 Dile a la app dónde está el servidor

```bash
cp apps/customer/.env.example apps/customer/.env
```

Abre `apps/customer/.env` y cambia la línea por la IP del paso anterior:

```
EXPO_PUBLIC_API_URL=http://192.168.1.50:3000
```

Haz lo mismo con `apps/driver/.env` si vas a probar al repartidor.

### 1.4 Arranca la app

```bash
npm run start -w @jellyfish/customer     # app del cliente
npm run start -w @jellyfish/driver       # app del repartidor (en otra terminal)
```

Aparece un **código QR** en la terminal. (El comando abre Expo Go a propósito: `npm run start:dev-client` es para el instalable de desarrollo y no sirve con Expo Go.) Si corres las dos apps a la vez, Expo te ofrece usar otro puerto para la segunda: acepta.

### 1.5 Ábrela en el teléfono

**iPhone**

1. Instala **Expo Go** desde la App Store.
2. Abre la app **Cámara** del iPhone y apunta al código QR.
3. Toca la notificación «Abrir en Expo Go». La primera vez tarda unos segundos en descargar el código.

**Android**

1. Instala **Expo Go** desde Google Play.
2. Ábrela y toca **Scan QR code** (escanear código QR).
3. Apunta al QR de la terminal.

Para entrar, escribe tu celular y mira el código que aparece en la terminal del API.

### 1.6 Qué NO se ve igual en Expo Go

- **Ícono y pantalla de inicio de JELLYFISH:** Expo Go muestra los suyos. La marca se ve en el instalable (sección 2).
- **Notificaciones push en Android:** Expo Go en Android ya no las soporta (**por verificar** en la versión actual de Expo Go). Pruébalas con el instalable.
- **Regreso del pago con tarjeta:** el pago abre el navegador y vuelve con `jellyfish://`, un enlace que solo existe en el instalable real. En Expo Go puede quedarse en el navegador (**por verificar** en teléfono). El pago en efectivo y por transferencia no dependen de esto.
- **Versión de Expo Go:** la app usa **Expo SDK 57**. Si Expo Go dice que el proyecto no es compatible con su versión (**por verificar** qué SDK soporta la tienda en tu fecha), usa el instalable de la sección 2.

### 1.7 Revisar que la configuración es válida

```bash
npm run config -w @jellyfish/customer     # imprime la configuración final; no debe dar error
npm run config -w @jellyfish/driver
```

---

## 2. Instalarla como app real (EAS «preview»)

EAS es el servicio de Expo que **compila las apps en la nube** (no necesitas Xcode ni Android Studio). El perfil `preview` produce un instalable para repartir entre tus pruebas; el perfil `production` produce el archivo para las tiendas.

### 2.1 Qué cuentas hacen falta

| Cuenta                   | Costo                                                                                                                | Para qué                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expo** (expo.dev)      | Gratis. El plan gratuito limita las compilaciones al mes y puede tener cola (**por verificar** los límites actuales) | Compilar en la nube (EAS) y publicar actualizaciones por aire                                                                                           |
| **Apple Developer**      | US$ 99 al año                                                                                                        | **Solo iPhone.** Sin ella no hay instalable para iPhone fuera de Expo Go. Con ella: instalable directo en teléfonos registrados, TestFlight y App Store |
| **Google Play Console**  | US$ 25, pago único                                                                                                   | Solo para publicar en Google Play. **Para probar en Android no hace falta:** basta el APK                                                               |
| **Firebase** (de Google) | Gratis                                                                                                               | Solo para notificaciones push en Android (ver 2.6)                                                                                                      |

### 2.2 Una sola vez: entra a Expo y crea los dos proyectos

Haz esto **dentro de cada carpeta** (`apps/customer` y `apps/driver`); cada app es un proyecto distinto de Expo.

```bash
cd apps/customer
npx eas-cli login          # tu cuenta de expo.dev
npx eas-cli init           # crea el proyecto y te muestra su ID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
```

La configuración de las apps es dinámica (`app.config.ts`), así que `eas init` **no puede escribir el ID por ti** (**por verificar** el mensaje exacto): cópialo tú y ponlo en la variable `EAS_PROJECT_ID` cada vez que uses `eas`:

| Sistema              | Cómo fijarla en tu terminal (vale hasta cerrarla)            |
| -------------------- | ------------------------------------------------------------ |
| Mac / Linux          | `export EAS_PROJECT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| Windows (PowerShell) | `$env:EAS_PROJECT_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"` |

El ID **no es un secreto** (viaja dentro de la app), pero es de tu cuenta, por eso no está escrito en el repositorio. Sin `EAS_PROJECT_ID` la app funciona igual en desarrollo; solo quedan apagadas las actualizaciones por aire y las notificaciones push remotas. Repite el proceso en `apps/driver` (con **su propio** ID).

### 2.3 Escribe la dirección de tu servidor en `eas.json`

Un instalable real no puede apuntar a «tu computadora»: necesita un servidor accesible por internet con **https**. Abre `apps/customer/eas.json` y reemplaza el marcador del perfil que vayas a usar:

```json
"preview": {
  ...
  "env": { "EXPO_PUBLIC_API_URL": "https://REEMPLAZAR-api-de-pruebas.example.com" }
}
```

Mientras diga `REEMPLAZAR…` o no sea `https://`, **la compilación se detiene a propósito** con un mensaje en español (para que nunca salga una app apuntando a un servidor equivocado). Haz lo mismo en `apps/driver/eas.json`. Más detalles en la sección 4.

### 2.4 Android: un APK

```bash
cd apps/customer
npx eas-cli build --platform android --profile preview
```

Al terminar (desde varios minutos hasta más de media hora, según la cola de EAS), EAS te da un enlace y un QR. Ábrelo **desde el Android**, descarga el `.apk` e instálalo. Android te pedirá permitir «instalar apps desconocidas» para el navegador: es normal en instalables fuera de Google Play.

### 2.5 iPhone: dos opciones

**Opción A: instalable directo (distribución interna).** Solo funciona en iPhones **registrados** en tu cuenta de Apple Developer.

```bash
cd apps/customer
npx eas-cli device:create                                     # genera un enlace/QR; ábrelo en el iPhone para registrarlo
npx eas-cli build --platform ios --profile preview            # compila para los iPhones registrados
```

En el iPhone: abre el enlace de la compilación e instala. Desde iOS 16 hay que activar antes **Ajustes → Privacidad y seguridad → Modo de desarrollador** y reiniciar (**por verificar** la ruta exacta en tu versión de iOS). Cada iPhone nuevo que quieras sumar obliga a registrarlo y **compilar de nuevo**.

**Opción B: TestFlight.** Compila el perfil `production` y súbelo a App Store Connect; TestFlight lo reparte a testers por invitación sin registrar equipos uno a uno:

```bash
npx eas-cli build --platform ios --profile production
npx eas-cli submit --platform ios --profile production        # antes: ver el marcador ascAppId en eas.json
```

En `submit.production.ios.ascAppId` de `eas.json` está `0000000000` como **marcador**: pon el ID numérico que App Store Connect asigna a tu app al crearla.

> EAS compila lo que está **guardado en git**. Si te reclama cambios sin guardar, haz `git commit` antes (o consulta la documentación de EAS por la variable `EAS_NO_VCS`; **por verificar**).

### 2.6 Notificaciones push (pendiente de configurar tus cuentas)

- **API:** ya envía por el servicio de notificaciones de Expo (`apps/api/src/services/push.ts`; `PUSH_ENABLED`, `EXPO_ACCESS_TOKEN` opcional) y registra los dispositivos en `POST /v1/me/devices`.
- **Android:** necesita un proyecto de **Firebase** y subir sus credenciales a EAS (`npx eas-cli credentials`, sección de FCM; **por verificar** el menú actual). Si compilas con el archivo `google-services.json`, apunta la variable `GOOGLE_SERVICES_JSON` a su ruta al compilar. Ese archivo **no se sube al repositorio** (ya está en `.gitignore`, igual que las llaves `.p8`, `.p12`, `.jks` y la llave de servicio de Google Play).
- **iPhone:** EAS genera la clave de notificaciones de Apple (APNs) por ti durante la compilación. Los compilados `preview` y `production` ya piden el entorno de producción de Apple (`app.config.ts`).
- **Sin esto**, la app funciona, pero no llegan avisos con la app cerrada.

### 2.7 Actualizar sin pasar por las tiendas (por aire)

Con `EAS_PROJECT_ID` definido, las apps traen `expo-updates`. Para cambios **solo de código JavaScript o imágenes** (no librerías nativas):

```bash
cd apps/customer
EXPO_PUBLIC_API_URL=https://tu-servidor.example.com npx eas-cli update --channel preview --message "Texto del cambio"
```

(En Windows PowerShell no existe esa forma de una sola línea: primero ejecuta `$env:EXPO_PUBLIC_API_URL="https://tu-servidor.example.com"` y luego el comando `eas update`. Define siempre la variable: **por verificar** si EAS aplica el bloque `env` de `eas.json` a las actualizaciones, y mientras tanto no lo des por hecho.) Una actualización solo llega a instalables con **la misma versión** (`version` en `app.config.ts`, hoy `0.1.0`). **Regla de oro:** si agregas o actualizas una librería nativa, sube `version` y compila de nuevo; si no, una actualización incompatible podría cerrar la app. Cada perfil tiene su canal (`development`, `preview`, `production`).

### 2.8 Instalable de desarrollo (para quien programa)

```bash
npx eas-cli build --platform android --profile development     # o: --platform ios --profile development-simulator
npm run start:dev-client -w @jellyfish/customer
```

Es una versión de la app con el menú de desarrollador, que se conecta a tu computadora. No se reparte a clientes.

---

## 3. Checklist de publicación en App Store y Google Play

Estado según el repositorio: **Listo** = ya está en el código; **Falta** = hay que hacerlo; **Verificar** = depende de reglas externas que cambian.

### 3.1 Para las dos tiendas

- [ ] **Política de privacidad con URL pública** (obligatoria en ambas). **Falta:** el API no la sirve y las apps todavía no muestran un enlace a ella (agregarlo en Perfil). Debe cubrir qué datos se guardan (ver 3.3), para qué, con quién se comparten y cómo pedir su eliminación. Redactarla con un abogado (Ley 172-13 de protección de datos; ver `docs/PRODUCCION.md`).
- [x] **Eliminación de cuenta dentro de la app. Listo:** Perfil → «Eliminar mi cuenta» (`DELETE /v1/me`; anonimiza el perfil y borra direcciones; conserva los pedidos que exige la ley, sin datos de contacto). **Verificar:** Google Play también pide una **URL web** donde un usuario pueda solicitar la eliminación (en el formulario de seguridad de datos).
- [ ] **Cuenta de demostración para los revisores. Falta:** entrar exige un código por SMS/WhatsApp que el revisor no puede recibir, y **el API hoy no tiene** una cuenta con código fijo (los códigos de consola están prohibidos en producción, a propósito). Hay que decidir cómo resolverlo antes de enviar a revisión (por ejemplo, un teléfono de revisión con código fijo solo en producción, desactivable) y escribir ese teléfono y código en las «notas para el revisor» de cada tienda.
- [ ] **Capturas de pantalla** de la app real en teléfono (en App Store Connect y Play Console aparecen los tamaños exigidos; **Verificar** medidas vigentes). Las capturas de `npm run e2e:customer` (carpeta `tmp/e2e`) son de navegador: sirven de borrador, no de capturas finales.
- [ ] **Descripción, palabras clave, categoría** (Comida y bebida), **correo y URL de soporte**, países (República Dominicana), precio gratis.
- [ ] **Clasificación de contenido** (cuestionario de edad en ambas tiendas). Productos: alimentos congelados; sin juegos de azar ni contenido para adultos. **Verificar** las preguntas actuales.
- [ ] **Texto de permisos.** Ya están en español dentro de la app (`app.config.ts`):
  - Cliente, ubicación: «JELLYFISH usa tu ubicación para ubicar tu dirección de entrega.»
  - Repartidor, ubicación: «JELLYFISH Repartidor usa tu ubicación, solo mientras la app está abierta, para que el cliente vea por dónde va su pedido.» **Falta confirmar** que esta frase coincide con lo que el código del repartidor hace de verdad (Apple rechaza textos que no corresponden al uso).
  - Notificaciones: el permiso lo pide el sistema cuando la app registra el dispositivo.
  - **No** se pide cámara, fotos, contactos, micrófono, ni ubicación en segundo plano. Las apps bloquean además los permisos de almacenamiento que Expo agrega por costumbre.
- [ ] **Probar en teléfonos reales** (secciones 1 y 2): hasta hoy solo se probó en navegador.

### 3.2 App Store (Apple)

- [ ] Cuenta **Apple Developer** (US$ 99/año) y la app creada en App Store Connect con el identificador `do.jellyfish.app`.
- [x] **Exportación de cifrado. Listo:** `ITSAppUsesNonExemptEncryption` está en `false` (la app solo usa HTTPS). Apple evita así la pregunta en cada envío.
- [ ] **Privacidad de la app («etiquetas de privacidad»):** declarar los datos de 3.3 en App Store Connect.
- [ ] **Pagos:** son bienes físicos con entrega, así que el cobro con tarjeta (AZUL), efectivo o transferencia es el esperado. **Verificar** la guía vigente de revisión de Apple. Los datos de tarjeta **no pasan por JELLYFISH** (los captura la página de pago de la pasarela).
- [ ] **«Iniciar sesión con Apple»:** solo se exige si hubiera inicio de sesión con redes sociales; aquí solo hay celular + código. **Verificar.**
- [ ] Envío: `eas build --profile production` y `eas submit` (sección 2.5).

### 3.3 Google Play

- [ ] Cuenta **Google Play Console** (US$ 25 una vez) y la app con el paquete `do.jellyfish.app`.
- [ ] **Seguridad de los datos** (formulario). Con lo que el API guarda hoy (`apps/api/src/db/schema.ts`), declara como mínimo:
  - **Número de teléfono** (inicio de sesión), **nombre** y **correo** (opcional).
  - **Direcciones de entrega** y **ubicación** (el cliente, para ubicar su dirección; el repartidor, mientras la app está abierta).
  - **Historial de pedidos** y datos de pago (referencias; **la tarjeta no pasa por JELLYFISH**).
  - **Identificador del dispositivo para notificaciones** (token push).
  - En producción todo viaja cifrado (https) y el usuario puede eliminar su cuenta desde la app. **Verificar** con tu abogado la redacción final y si algún dato se comparte con terceros (AZUL, proveedor de SMS/WhatsApp, Expo).
- [ ] **Pruebas cerradas obligatorias para cuentas nuevas** (un grupo de testers durante varios días antes de producción): **Verificar** la regla vigente y el número de testers y días; planéalo con tiempo.
- [ ] Formato de subida: **AAB** (perfil `production`), no APK. `eas submit --platform android --profile production` necesita la llave de servicio de Google Play guardada en EAS (`npx eas-cli credentials`), nunca en el repositorio. Las primeras publicaciones suelen tener que hacerse a mano en la consola (**Verificar**).
- [ ] Pista inicial: `eas.json` envía a «interna» como borrador (`track: internal`, `releaseStatus: draft`); cámbialo cuando estés listo.

### 3.4 La app del repartidor

No es para el público. Publícala de forma privada: en iPhone, TestFlight o distribución «no listada» / apps personalizadas; en Android, pista de pruebas cerrada o interna (**Verificar** las opciones vigentes de cada tienda). Los repartidores solo entran si el administrador los agregó en **Equipo** del panel. El identificador es `do.jellyfish.driver` y sus credenciales de EAS son independientes de las del cliente.

---

## 4. Cómo apuntar la app a tu servidor

La app decide la dirección del API en este orden (`apps/customer/src/lib/config.ts` y `apps/driver/src/config.ts`):

1. **`EXPO_PUBLIC_API_URL`** (variable de entorno, se incrusta al empaquetar el código).
2. `extra.apiUrl` de la configuración (que `app.config.ts` llena con esa misma variable).
3. `http://localhost:3000` (solo sirve en el navegador o en un emulador de iPhone en la misma computadora).

| Situación                              | Dónde se escribe                                                               | Valor                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Expo Go / desarrollo en tu computadora | `apps/customer/.env` y `apps/driver/.env` (archivos que **no** se suben a git) | `http://TU-IP-LOCAL:3000` (emulador Android: `http://10.0.2.2:3000`) |
| Instalable `preview`                   | Bloque `env` del perfil `preview` en `apps/*/eas.json`                         | `https://` de tu servidor de pruebas                                 |
| Tiendas (`production`)                 | Bloque `env` del perfil `production` en `apps/*/eas.json`                      | `https://` de tu servidor real                                       |
| Actualizaciones por aire               | En la misma línea de comandos de `eas update` (sección 2.7)                    | `https://` de tu servidor                                            |

Detalles de seguridad que ya están puestos:

- En las compilaciones `preview` y `production`, `app.config.ts` **detiene la compilación** si la URL falta, contiene `REEMPLAZAR` o no es `https://`. iOS y Android bloquean el tráfico sin cifrar en apps instaladas, así que un `http://` solo daría una app que no carga.
- El servidor real necesita sus propias variables (`DATABASE_URL`, `JWT_SECRET`, envío de OTP, etc.): están en `docs/PRODUCCION.md`. Para que el pago con tarjeta vuelva a la app, el API debe saber su dirección pública (`PUBLIC_API_URL`).
- **No pongas secretos** en `eas.json` ni en `EXPO_PUBLIC_*`: todo lo que empieza por `EXPO_PUBLIC_` queda visible dentro de la app.

---

## 5. Marca: íconos y pantalla de inicio

Los archivos están en `apps/customer/assets` y `apps/driver/assets`:

| Archivo                         | Uso                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `icon.png` (1024×1024)          | Ícono de iPhone y base de la tienda. **Sin transparencia** (Apple la rechaza)  |
| `adaptive-icon.png`             | Primer plano del ícono de Android; todo cabe en el círculo central del 66 %    |
| `adaptive-icon-monochrome.png`  | Ícono «temático» de Android 13 o más nuevo (una sola tinta)                    |
| `splash-icon.png`               | Pantalla de inicio sobre el azul oscuro de la marca (`#050B1F`)                |
| `notification-icon.png` (96×96) | Ícono pequeño de las notificaciones de Android: solo blanco sobre transparente |
| `favicon.png`                   | Pestaña del navegador (versión web)                                            |

El cliente es una medusa **cian**; el repartidor es la misma medusa en **coral** con una **insignia de moto con caja**, para que no se confundan en el teléfono. Para regenerarlos o revisarlos:

```bash
npm run brand:assets                 # vuelve a dibujar los 12 PNG (necesita Chromium; CHROME_PATH si no está en la ruta habitual)
npm run brand:assets -- --preview    # además crea tmp/brand-preview.png: el ícono a varios tamaños y con las máscaras de iOS y Android
npm run brand:check                  # solo valida: tamaños, sin alfa en iOS, zona segura, notificación en blanco, repartidor distinguible
```

El dibujo vive en `scripts/make-brand-assets.ts` (colores de `packages/shared/src/tokens.ts`).

---

## 6. Errores comunes

| Lo que ves                                                            | Causa probable                                                                          | Qué hacer                                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| La app abre pero se queda cargando o dice «Network request failed»    | La URL del API sigue en `localhost` o el teléfono no alcanza la compu                   | Revisa `apps/*/.env` (IP, no `localhost`); abre `http://TU-IP:3000/health` en el teléfono; misma WiFi; permite el puerto 3000 en el firewall  |
| El QR no abre nada / «no se pudo conectar»                            | Redes distintas, WiFi de invitados o un firewall                                        | Misma WiFi sin «aislamiento de clientes»; prueba `npm run start -w @jellyfish/customer -- --tunnel` (más lento; pide instalar un complemento) |
| Expo Go: «proyecto incompatible con esta versión»                     | La tienda trae una versión de Expo Go para otro SDK (**por verificar**)                 | Usa el instalable de la sección 2                                                                                                             |
| `EXPO_PUBLIC_API_URL … no sirve para el perfil "preview"` al compilar | El marcador `REEMPLAZAR` sigue en `eas.json`, o la URL no es `https://`                 | Edita el bloque `env` del perfil en `apps/*/eas.json`                                                                                         |
| `EAS_PROJECT_ID … no tiene el formato…`                               | ID mal copiado                                                                          | Cópialo completo desde expo.dev (formato `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)                                                              |
| EAS dice que el proyecto no está configurado / pide el ID             | Falta `EAS_PROJECT_ID` en esa terminal                                                  | Fíjala de nuevo (sección 2.2); cada terminal nueva la pierde                                                                                  |
| iPhone: «no se puede instalar» o no abre la app                       | iPhone no registrado o Modo de desarrollador apagado                                    | `eas device:create`, vuelve a compilar y activa el Modo de desarrollador                                                                      |
| Android: «app no instalada»                                           | Hay otra versión con otra firma, o falta el permiso de instalación                      | Desinstala la anterior; permite «instalar apps desconocidas» al navegador                                                                     |
| El pago con tarjeta no regresa a la app                               | En Expo Go el enlace `jellyfish://` no existe                                           | Pruébalo en el instalable (`preview`). Si falla ahí, revisa `APP_SCHEME` y `PUBLIC_API_URL` del API                                           |
| No llegan notificaciones en Android                                   | Falta Firebase/FCM, o estás en Expo Go                                                  | Sección 2.6; usa el instalable                                                                                                                |
| No llegan notificaciones en iPhone                                    | Permiso negado, o no es un compilado firmado por EAS                                    | Ajustes → JELLYFISH → Notificaciones; vuelve a compilar con EAS                                                                               |
| Pide ubicación y no la encuentra                                      | Permiso negado o ubicación apagada                                                      | Ajustes → JELLYFISH → Ubicación → «Al usar la app»; en el cliente siempre se puede escribir la dirección a mano                               |
| `npm run brand:assets` no encuentra Chromium                          | Ruta distinta en tu computadora                                                         | `CHROME_PATH=/ruta/a/chrome npm run brand:assets`                                                                                             |
| Una actualización por aire no llega                                   | La versión (`version`) del instalable no coincide, o falta `EAS_PROJECT_ID` al compilar | Compila con `EAS_PROJECT_ID` definido; publica al canal del perfil con el que compilaste                                                      |

---

## 7. Lo que no está verificado

- Instalación y uso en **iPhone y Android reales**: nunca se ha hecho. Tampoco el navegador seguro nativo del pago, el almacenamiento seguro (Keychain/Keystore), el autocompletado de códigos SMS ni los enlaces `jellyfish://`.
- Ninguna compilación de EAS se ha ejecutado (no hay cuenta de Expo conectada). La configuración sí se validó: `expo config`, `expo prebuild` en una carpeta temporal (genera bien los proyectos nativos de iOS y Android con íconos, pantalla de inicio, permisos y actualizaciones) y los perfiles de `eas.json` con el analizador oficial.
- Todo lo marcado **por verificar** depende de Apple, Google o Expo y puede haber cambiado.
