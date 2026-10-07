import { randomBytes } from 'node:crypto';
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
  return {
    demo: env.JELLYFISH_DEMO === '1',
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
