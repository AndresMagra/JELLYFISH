import { randomBytes } from 'node:crypto';

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
    jwtSecret: jwtSecret || randomBytes(32).toString('hex'),
    otpPepper: otpPepper || randomBytes(16).toString('hex'),
    bootstrapAdminPhone: env.BOOTSTRAP_ADMIN_PHONE ?? null,
    reservationMinutesCard: 15,
    reservationMinutesTransfer: 120,
    maxCentilbPerLine: 10_000,
    maxUnitsPerLine: 20,
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

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ NODE_ENV: 'test' }),
    jwtSecret: 'test-secret-test-secret-test-secret-123',
    otpPepper: 'test-pepper-0123456789',
    ...overrides,
  };
}
