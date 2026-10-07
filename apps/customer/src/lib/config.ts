import Constants from 'expo-constants';

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
