import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Configuración de la app del cliente (Expo SDK 57). Reemplaza a app.json para poder leer
 * variables de entorno; todo lo demás se conserva igual.
 *
 * Variables (ninguna es secreta; ninguna es obligatoria para desarrollo):
 *   EXPO_PUBLIC_API_URL  URL del API. En builds de EAS (preview/production) debe ser https.
 *   EAS_PROJECT_ID       ID del proyecto en expo.dev. Sin él la app funciona, pero sin actualizaciones
 *                        por aire (OTA) ni notificaciones push remotas (se obtiene con `eas init`).
 *   GOOGLE_SERVICES_JSON Ruta a google-services.json (Firebase) para push en Android.
 *
 * Los colores salen de packages/shared/src/tokens.ts (abyss, deep, cyan). Se repiten aquí como
 * texto porque Expo evalúa este archivo por su cuenta y no resuelve paquetes del monorepo.
 */
const ABYSS = '#050B1F';
const DEEP = '#0A1633';
const CYAN = '#22D3EE';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Perfil de EAS en el que corre la evaluación (solo existe dentro de un build de EAS). */
const easProfile = process.env.EAS_BUILD_PROFILE;
/** Builds que se instalan en teléfonos reales (no de desarrollo): preview y production. */
const isReleaseProfile = easProfile === 'preview' || easProfile === 'production';
const isReleaseBuild = Boolean(process.env.EAS_BUILD) && isReleaseProfile;

function resolveApiUrl(): string | null {
  const url = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');
  if (!isReleaseBuild) return url || null;
  // Un build que se instala en teléfonos de verdad nunca debe salir apuntando a localhost,
  // a un marcador de eas.json sin reemplazar ni a http (iOS y Android bloquean el tráfico sin cifrar).
  if (!url || /REEMPLAZ/i.test(url) || !url.startsWith('https://')) {
    throw new Error(
      `EXPO_PUBLIC_API_URL (${url || 'vacía'}) no sirve para el perfil "${easProfile}": ` +
        'escribe la dirección https de tu servidor en el bloque "env" de ese perfil en apps/customer/eas.json.',
    );
  }
  return url;
}

function resolveProjectId(): string | undefined {
  const id = process.env.EAS_PROJECT_ID?.trim();
  if (!id) return undefined;
  if (!UUID.test(id)) {
    throw new Error(
      `EAS_PROJECT_ID ("${id}") no tiene el formato de un ID de proyecto (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). ` +
        'Cópialo de expo.dev o de la salida de `eas init`.',
    );
  }
  return id;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const projectId = resolveProjectId();
  const apiUrl = resolveApiUrl();

  return {
    ...config,
    name: 'JELLYFISH',
    slug: 'jellyfish',
    scheme: 'jellyfish',
    version: '0.1.0',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    // La Nueva Arquitectura es obligatoria en SDK 57: la clave ya no existe en el tipo ExpoConfig y
    // no cambia nada, pero se conserva para dejar constancia de que la app la usa.
    ...({ newArchEnabled: true } as Record<string, unknown>),
    backgroundColor: ABYSS,
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'do.jellyfish.app',
      infoPlist: {
        // Solo usamos HTTPS (cifrado exento): evita la pregunta de cumplimiento de exportación en App Store Connect.
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: 'do.jellyfish.app',
      backgroundColor: ABYSS,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        monochromeImage: './assets/adaptive-icon-monochrome.png',
        backgroundColor: DEEP,
      },
      // Expo los agrega por costumbre; la app no lee ni escribe archivos compartidos y Google Play
      // pide justificar los permisos que se declaran. "Dibujar sobre otras apps" solo hace falta
      // para el menú de desarrollo, así que se quita de los builds que se instalan de verdad.
      blockedPermissions: [
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        ...(isReleaseProfile ? ['android.permission.SYSTEM_ALERT_WINDOW'] : []),
      ],
      ...(process.env.GOOGLE_SERVICES_JSON
        ? { googleServicesFile: process.env.GOOGLE_SERVICES_JSON }
        : {}),
    },
    web: {
      bundler: 'metro',
      output: 'single',
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-router',
      // El token de sesión se guarda en Keychain/Keystore sin Face ID: no declaramos ese permiso.
      ['expo-secure-store', { faceIDPermission: false }],
      'expo-font',
      [
        'expo-splash-screen',
        {
          backgroundColor: ABYSS,
          image: './assets/splash-icon.png',
          resizeMode: 'contain',
          // La imagen mide 1024 px con el dibujo dentro del 66 % central (círculo seguro de Android 12+).
          android: { imageWidth: 288 },
          ios: { imageWidth: 340 },
          dark: { backgroundColor: ABYSS, image: './assets/splash-icon.png' },
        },
      ],
      [
        'expo-notifications',
        {
          icon: './assets/notification-icon.png',
          color: CYAN,
          // Los builds que se distribuyen (preview/production) usan el servidor de push de producción de Apple.
          mode: isReleaseProfile ? 'production' : 'development',
        },
      ],
      [
        'expo-location',
        {
          // Solo ubicación mientras la app está abierta; no se pide ubicación en segundo plano.
          locationWhenInUsePermission:
            'JELLYFISH usa tu ubicación para ubicar tu dirección de entrega.',
          locationAlwaysAndWhenInUsePermission: false,
          locationAlwaysPermission: false,
          motionUsagePermission: false,
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
        },
      ],
    ],
    // La versión de la app define con qué builds es compatible una actualización por aire:
    // sube `version` cada vez que agregues o actualices una librería nativa.
    runtimeVersion: { policy: 'appVersion' },
    // Con EAS_PROJECT_ID, expo-updates descarga actualizaciones del canal del build (ver eas.json).
    // Sin él, las actualizaciones por aire quedan apagadas y todo lo demás sigue funcionando.
    updates: projectId
      ? { url: `https://u.expo.dev/${projectId}`, fallbackToCacheTimeout: 0 }
      : { enabled: false },
    extra: {
      ...(apiUrl ? { apiUrl } : {}),
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
