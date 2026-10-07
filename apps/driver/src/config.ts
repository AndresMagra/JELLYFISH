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

export const API_URL: string = resolveApiUrl();
