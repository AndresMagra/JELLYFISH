import Constants from 'expo-constants';
import { Platform } from 'react-native';

function resolveApiUrl(): string {
  const fromEnv: unknown = process.env.EXPO_PUBLIC_API_URL;
  const fromExtra: unknown = Constants.expoConfig?.extra?.apiUrl;
  const raw =
    typeof fromEnv === 'string' && fromEnv
      ? fromEnv
      : typeof fromExtra === 'string' && fromExtra
        ? fromExtra
        : 'http://localhost:3000';
  return raw.replace(/\/+$/, '');
}

/** URL del API: variable pública `EXPO_PUBLIC_API_URL`, o `extra.apiUrl` de app.json, o localhost. */
export const API_URL: string = resolveApiUrl();

export const APP_SCHEME = 'jellyfish';

/**
 * Vista previa web (`npm run preview:build`): la app corre en el navegador del teléfono contra un
 * servidor de demostración que vive dentro de la página (packages/demo-backend). Solo se enciende
 * con `EXPO_PUBLIC_DEMO=1` Y en web: en un build nativo (iPhone/Android) esta variable no hace nada.
 */
export const IS_DEMO: boolean = process.env.EXPO_PUBLIC_DEMO === '1' && Platform.OS === 'web';
