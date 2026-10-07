import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { AzulConfig } from '@jellyfish/payments';
import { LIMITS } from '@jellyfish/shared';

export interface DeliveryWindows {
  /** Primera hora de entrega (hora local de RD, 0-23). */
  startHour: number;
  /** Hora de cierre (la última ventana termina a esta hora). */
  endHour: number;
  /** Duración de cada ventana en horas. */
  windowHours: number;
  /** Pedidos máximos por ventana. */
  capacityPerWindow: number;
  /** Anticipación mínima para el pedido, en minutos. */
  leadMinutes: number;
  /** Días hacia adelante que se ofrecen. */
  daysAhead: number;
}

export interface TransferInfo {
  bank: string;
  accountType: string;
  accountNumber: string;
  holder: string;
  /** RNC o cédula del titular. */
  taxId: string;
}

export interface PaymentsConfig {
  /** Pasarela de tarjeta activa; null = pago con tarjeta deshabilitado. */
  cardProvider: 'azul' | 'mock' | null;
  azul: AzulConfig | null;
  /** Datos bancarios para transferencias; null = transferencia deshabilitada. */
  transfer: TransferInfo | null;
  /** URL pública del API (la pasarela redirige aquí al terminar el pago). */
  publicBaseUrl: string;
  /** Esquema del enlace profundo de la app: jellyfish://orders/… */
  appScheme: string;
}

export interface Config {
  /** Modo demostración: permite vender artículos con precio estimado / ITBIS sin confirmar. */
  demo: boolean;
  jwtSecret: string;
  /** Pimienta para hashear los códigos OTP. */
  otpPepper: string;
  /** Vigencia del código OTP en minutos (la usan el vencimiento y el texto del SMS/WhatsApp). */
  otpTtlMinutes: number;
  /**
   * Código OTP fijo SOLO para demostraciones (JELLYFISH_DEMO=1 + DEMO_OTP_CODE=123456): permite
   * entrar desde un teléfono sin ver la consola del servidor. Nunca en producción.
   */
  demoOtpCode: string | null;
  /** Notificaciones push (Expo). Apagadas por defecto en pruebas; PUSH_ENABLED=0/1 lo fuerza. */
  pushEnabled: boolean;
  /** Token de acceso de Expo (opcional; solo si el proyecto exige "enhanced push security"). */
  expoAccessToken: string | null;
  /** Teléfono que se vuelve administrador al iniciar sesión por primera vez. */
  bootstrapAdminPhone: string | null;
  reservationMinutesCard: number;
  reservationMinutesTransfer: number;
  /** Máximo por línea, en centilibras. */
  maxCentilbPerLine: number;
  maxUnitsPerLine: number;
  /** Colchón de pre-autorización para peso variable (puntos básicos). */
  authBufferBps: number;
  /** Peso final aceptado respecto al pedido (puntos básicos): 5000 = 50 %. */
  weightToleranceLowBps: number;
  weightToleranceHighBps: number;
  windows: DeliveryWindows;
  payments: PaymentsConfig;
  /**
   * Orígenes web autorizados (panel admin). `true` = cualquiera (solo desarrollo).
   * Las apps móviles nativas no usan CORS.
   */
  corsOrigins: string[] | true;
  /** República Dominicana no usa horario de verano: UTC-4 todo el año. */
  utcOffsetMinutes: number;
  /** Carpeta de las fotos del catálogo que sirve GET /photos/*. Sin definir: data/catalog/photos. */
  photosDir?: string;
  /** NODE_ENV=production: activa HSTS y las validaciones estrictas. */
  production: boolean;
  /**
   * Detrás de un balanceador, la IP real viene en X-Forwarded-For. Alimenta el límite de peticiones
   * y la bitácora de auditoría. `false` = no confiar en esa cabecera; un número = saltos (balanceadores)
   * de confianza; una lista = IP/CIDR de los proxies de confianza. Ver `parseTrustProxy`.
   */
  trustProxy: boolean | number | string[];
  /** DSN de Sentry; sin él no se envía nada. */
  sentryDsn: string | null;
}

/** Vigencia del código OTP. Una sola fuente: el vencimiento y el mensaje al cliente salen de aquí. */
export const OTP_TTL_MINUTES = 10;

/** PUSH_ENABLED=1|true / 0|false; sin definir, activo salvo en pruebas (NODE_ENV=test). */
function parsePushEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env.PUSH_ENABLED?.trim().toLowerCase();
  if (!raw) return env.NODE_ENV !== 'test';
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw new Error('PUSH_ENABLED debe ser 1/0 o true/false');
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * TRUST_PROXY: cómo saber cuál es la IP real del cliente detrás de un balanceador.
 *   (vacío) | 0 | false → no se confía en X-Forwarded-For (conexión directa).
 *   1, 2, …             → número de balanceadores delante del API (lo recomendado: no se puede falsificar
 *                          añadiendo saltos desde el cliente).
 *   IP/CIDR separados por comas (o loopback, linklocal, uniquelocal) → solo esos proxies son de confianza.
 *   true                → confía en toda la cadena: un cliente puede falsificar su IP. Evítalo.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  const value = raw?.trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops) || hops > 10) {
      throw new Error('TRUST_PROXY: el número de balanceadores debe estar entre 1 y 10');
    }
    return hops;
  }
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [addr = '', mask, ...rest] = part.split('/');
    const family = isIP(addr);
    const maskOk =
      mask === undefined ||
      (/^\d{1,3}$/.test(mask) && Number(mask) <= (family === 4 ? 32 : 128) && rest.length === 0);
    if (!PROXY_KEYWORDS.has(part.toLowerCase()) && (family === 0 || !maskOk)) {
      throw new Error(
        'TRUST_PROXY inválido: usa un número de balanceadores (1), o IP/CIDR separados por comas (10.0.0.0/8)',
      );
    }
  }
  return parts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? '';
  if (production && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET (≥ 32 caracteres) es obligatorio en producción');
  }
  const otpPepper = env.OTP_PEPPER ?? '';
  if (production && otpPepper.length < 16) {
    throw new Error('OTP_PEPPER (≥ 16 caracteres) es obligatorio en producción');
  }
  const demo = env.JELLYFISH_DEMO === '1';
  const demoOtpRaw = env.DEMO_OTP_CODE?.trim();
  if (demoOtpRaw) {
    if (production) throw new Error('DEMO_OTP_CODE no se permite en producción');
    if (!demo) throw new Error('DEMO_OTP_CODE solo funciona con JELLYFISH_DEMO=1');
    if (!/^\d{6}$/.test(demoOtpRaw)) throw new Error('DEMO_OTP_CODE debe ser de 6 dígitos');
  }
  return {
    demo,
    demoOtpCode: demoOtpRaw || null,
    payments: loadPaymentsConfig(env, production),
    corsOrigins: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : production
        ? []
        : true,
    jwtSecret: jwtSecret || randomBytes(32).toString('hex'),
    otpPepper: otpPepper || randomBytes(16).toString('hex'),
    otpTtlMinutes: OTP_TTL_MINUTES,
    pushEnabled: parsePushEnabled(env),
    expoAccessToken: env.EXPO_ACCESS_TOKEN?.trim() || null,
    bootstrapAdminPhone: env.BOOTSTRAP_ADMIN_PHONE ?? null,
    reservationMinutesCard: 15,
    reservationMinutesTransfer: 120,
    maxCentilbPerLine: LIMITS.maxCentilbPerLine,
    maxUnitsPerLine: LIMITS.maxUnitsPerLine,
    authBufferBps: 1000,
    weightToleranceLowBps: 5000,
    weightToleranceHighBps: 15_000,
    windows: {
      startHour: 10,
      endHour: 20,
      windowHours: 2,
      capacityPerWindow: 8,
      leadMinutes: 90,
      daysAhead: 3,
    },
    utcOffsetMinutes: -240,
    photosDir: env.PHOTOS_DIR?.trim() || undefined,
    production,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sentryDsn: env.SENTRY_DSN?.trim() || null,
  };
}

function loadPaymentsConfig(env: NodeJS.ProcessEnv, production: boolean): PaymentsConfig {
  const port = env.PORT ?? '3000';
  const publicBaseUrl = (env.PUBLIC_API_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  if (production && !env.PUBLIC_API_URL) {
    throw new Error('PUBLIC_API_URL es obligatorio en producción (AZUL redirige a esa dirección)');
  }

  let azul: AzulConfig | null = null;
  if (env.AZUL_MERCHANT_ID) {
    const missing = ['AZUL_MERCHANT_NAME', 'AZUL_MERCHANT_TYPE', 'AZUL_AUTH_KEY'].filter(
      (k) => !env[k],
    );
    if (missing.length > 0)
      throw new Error(`Configuración de AZUL incompleta: falta ${missing.join(', ')}`);
    const encoding = env.AZUL_HASH_ENCODING ?? 'utf8';
    if (encoding !== 'utf8' && encoding !== 'utf16le') {
      throw new Error('AZUL_HASH_ENCODING debe ser utf8 o utf16le');
    }
    azul = {
      environment: env.AZUL_ENV === 'production' ? 'production' : 'test',
      merchantId: env.AZUL_MERCHANT_ID,
      merchantName: env.AZUL_MERCHANT_NAME!,
      merchantType: env.AZUL_MERCHANT_TYPE!,
      authKey: env.AZUL_AUTH_KEY!,
      terminalId: env.AZUL_TERMINAL_ID,
      hashEncoding: encoding,
    };
  }

  const mock = env.PAYMENTS_MOCK === '1';
  if (mock && production) throw new Error('PAYMENTS_MOCK no puede activarse en producción');

  let transfer: TransferInfo | null = null;
  if (env.TRANSFER_ACCOUNT_NUMBER) {
    transfer = {
      bank: env.TRANSFER_BANK ?? '',
      accountType: env.TRANSFER_ACCOUNT_TYPE ?? 'Cuenta de ahorros',
      accountNumber: env.TRANSFER_ACCOUNT_NUMBER,
      holder: env.TRANSFER_HOLDER ?? '',
      taxId: env.TRANSFER_RNC ?? '',
    };
    if (!transfer.bank || !transfer.holder) {
      throw new Error('Transferencia incompleta: define TRANSFER_BANK y TRANSFER_HOLDER');
    }
  }

  return {
    // Con credenciales reales gana AZUL; el simulador solo existe si se pide expresamente.
    cardProvider: azul ? 'azul' : mock ? 'mock' : null,
    azul,
    transfer,
    publicBaseUrl,
    appScheme: env.APP_SCHEME ?? 'jellyfish',
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: 'test' }),
    jwtSecret: 'test-secret-test-secret-test-secret-123',
    otpPepper: 'test-pepper-0123456789',
    payments: {
      cardProvider: 'mock',
      azul: null,
      transfer: {
        bank: 'Banco de Pruebas',
        accountType: 'Cuenta corriente',
        accountNumber: '000-000000-0',
        holder: 'JELLYFISH SRL (PRUEBA)',
        taxId: '000-00000-0',
      },
      publicBaseUrl: 'http://localhost:3000',
      appScheme: 'jellyfish',
    },
    ...overrides,
  };
}
