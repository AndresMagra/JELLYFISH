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

/**
 * Teléfono del administrador para casos como un pedido bloqueado por PIN. Opcional: se lee de
 * `EXPO_PUBLIC_ADMIN_PHONE` (o de `extra.adminPhone` si algún día se define en app.config.ts).
 * Sin dato, la app solo dice que hay que avisar al administrador.
 */
function resolveAdminPhone(): string | null {
  const fromEnv: unknown = process.env.EXPO_PUBLIC_ADMIN_PHONE;
  const fromExtra: unknown = Constants.expoConfig?.extra?.adminPhone;
  const raw = typeof fromEnv === 'string' && fromEnv ? fromEnv : fromExtra;
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

export const ADMIN_CONTACT_PHONE: string | null = resolveAdminPhone();
