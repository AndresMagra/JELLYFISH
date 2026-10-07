import { OTP_TTL_MINUTES } from '../config';
import { DomainError } from '../errors';
import { ConsoleOtpSender, type OtpSender } from './auth';
import {
  type FetchLike,
  type Logger,
  TransportFailure,
  consoleLogger,
  maskPhone,
  redactText,
  safeJson,
  sleep as realSleep,
  timedFetch,
} from './http-util';

/** Tiempo máximo por intento al proveedor. */
export const OTP_REQUEST_TIMEOUT_MS = 8_000;
/** Pausa antes del único reintento (solo errores de red o 5xx). */
const RETRY_DELAY_MS = 400;
const E164 = /^\+[1-9]\d{7,14}$/;

export const TWILIO_MESSAGES_URL = (accountSid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
export const WHATSAPP_MESSAGES_URL = (phoneNumberId: string) =>
  `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`;

/** El cliente solo ve este error: nada del proveedor (ni códigos ni textos) sale hacia la app. */
export const otpDeliveryFailed = () =>
  new DomainError(
    'otp_delivery_failed',
    'No pudimos enviar el código en este momento. Intenta de nuevo en unos minutos.',
    503,
  );

/** Texto del SMS. La vigencia sale de la configuración real, no de un número fijo aquí. */
export function otpMessage(code: string, ttlMinutes: number): string {
  const unit = ttlMinutes === 1 ? 'minuto' : 'minutos';
  return `Tu código de JELLYFISH es ${code}. Vence en ${ttlMinutes} ${unit}. No lo compartas con nadie.`;
}

export interface HttpSenderOptions {
  /** Inyectable para pruebas. Por defecto, el `fetch` global. */
  fetch?: FetchLike;
  timeoutMs?: number;
  ttlMinutes?: number;
  logger?: Logger;
  /** Pausa entre intentos (inyectable para que las pruebas no esperen). */
  sleep?: (ms: number) => Promise<void>;
}

interface ProviderRequest {
  url: string;
  init: RequestInit;
}

interface ProviderError {
  code?: string | number;
  message?: string;
  trace?: string;
}

/**
 * Base común: construye la petición, aplica plazo de 8 s y, solo ante fallas de red o 5xx,
 * reintenta una vez. Los errores 4xx (credenciales, número inválido, plantilla…) no se reintentan.
 */
abstract class HttpOtpSender implements OtpSender {
  protected abstract readonly provider: 'twilio' | 'whatsapp';
  protected readonly fetchImpl: FetchLike;
  protected readonly timeoutMs: number;
  protected readonly ttlMinutes: number;
  protected readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpSenderOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? OTP_REQUEST_TIMEOUT_MS;
    this.ttlMinutes = options.ttlMinutes ?? OTP_TTL_MINUTES;
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? realSleep;
  }

  protected abstract buildRequest(phone: string, code: string): ProviderRequest;
  protected abstract parseError(body: unknown): ProviderError;
  /** Valores que nunca deben aparecer en logs, además del código y el teléfono. */
  protected abstract secrets(): string[];

  async send(phone: string, code: string): Promise<void> {
    if (!E164.test(phone)) {
      this.logger.error(
        { event: 'otp_send_failed', provider: this.provider, reason: 'invalid_phone' },
        'Se intentó enviar un OTP a un teléfono que no está en formato E.164',
      );
      throw otpDeliveryFailed();
    }
    const request = this.buildRequest(phone, code);
    const redactions = [code, phone, phone.slice(1), ...this.secrets()];

    for (let attempt = 1; attempt <= 2; attempt++) {
      let failure: {
        retryable: boolean;
        reason: 'http' | 'timeout' | 'network';
        httpStatus?: number;
        detail?: ProviderError;
        message?: string;
      };
      try {
        const res = await timedFetch(this.fetchImpl, request.url, request.init, this.timeoutMs);
        if (res.status >= 200 && res.status < 300) return;
        failure = {
          retryable: res.status >= 500,
          reason: 'http',
          httpStatus: res.status,
          detail: this.parseError(safeJson(res.text)),
        };
      } catch (e) {
        if (!(e instanceof TransportFailure)) throw e;
        failure = { retryable: true, reason: e.kind, message: e.message };
      }

      const willRetry = failure.retryable && attempt < 2;
      const entry = {
        event: 'otp_send_failed',
        provider: this.provider,
        attempt,
        willRetry,
        reason: failure.reason,
        httpStatus: failure.httpStatus,
        providerCode: failure.detail?.code,
        providerTrace: failure.detail?.trace,
        providerMessage: redactText(failure.detail?.message ?? failure.message ?? '', redactions),
        to: maskPhone(phone),
      };
      if (willRetry) {
        this.logger.warn(entry, 'Falló el envío del OTP; se reintenta una vez');
        await this.sleep(RETRY_DELAY_MS);
        continue;
      }
      this.logger.error(entry, 'No se pudo enviar el OTP');
      break;
    }
    throw otpDeliveryFailed();
  }
}

// ───────────────────────── Twilio (SMS) ─────────────────────────

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Número remitente en E.164. Se ignora si hay `messagingServiceSid`. */
  from?: string;
  messagingServiceSid?: string;
}

export class TwilioSmsSender extends HttpOtpSender {
  protected readonly provider = 'twilio' as const;

  constructor(
    private readonly credentials: TwilioCredentials,
    options: HttpSenderOptions = {},
  ) {
    super(options);
    if (!credentials.messagingServiceSid && !credentials.from) {
      throw new Error('TwilioSmsSender necesita `from` o `messagingServiceSid`');
    }
  }

  protected buildRequest(phone: string, code: string): ProviderRequest {
    const { accountSid, authToken, from, messagingServiceSid } = this.credentials;
    const form = new URLSearchParams({ To: phone, Body: otpMessage(code, this.ttlMinutes) });
    if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
    else form.set('From', from!);
    return {
      url: TWILIO_MESSAGES_URL(accountSid),
      init: {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      },
    };
  }

  protected parseError(body: unknown): ProviderError {
    const b = (body ?? {}) as { code?: unknown; message?: unknown };
    return {
      code: typeof b.code === 'number' || typeof b.code === 'string' ? b.code : undefined,
      message: typeof b.message === 'string' ? b.message : undefined,
    };
  }

  protected secrets(): string[] {
    return [this.credentials.authToken, this.credentials.accountSid];
  }
}

// ───────────────────────── WhatsApp Cloud API ─────────────────────────

export interface WhatsAppCredentials {
  phoneNumberId: string;
  accessToken: string;
  /** Nombre de la plantilla de categoría "autenticación" aprobada por Meta. */
  template: string;
  /** Código de idioma de la plantilla (WhatsApp usa `es` para español genérico). */
  language?: string;
}

export class WhatsAppCloudSender extends HttpOtpSender {
  protected readonly provider = 'whatsapp' as const;

  constructor(
    private readonly credentials: WhatsAppCredentials,
    options: HttpSenderOptions = {},
  ) {
    super(options);
  }

  protected buildRequest(phone: string, code: string): ProviderRequest {
    const { phoneNumberId, accessToken, template, language } = this.credentials;
    // Las plantillas de autenticación llevan el código dos veces: en el cuerpo y en el botón
    // "copiar código". El texto visible lo define la plantilla aprobada en Meta.
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: template,
        language: { code: language ?? 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    };
    return {
      url: WHATSAPP_MESSAGES_URL(phoneNumberId),
      init: {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
    };
  }

  protected parseError(body: unknown): ProviderError {
    const e = ((body ?? {}) as { error?: Record<string, unknown> }).error ?? {};
    const code = e.error_subcode ? `${e.code}/${e.error_subcode}` : e.code;
    return {
      code: typeof code === 'number' || typeof code === 'string' ? code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      trace: typeof e.fbtrace_id === 'string' ? e.fbtrace_id : undefined,
    };
  }

  protected secrets(): string[] {
    return [this.credentials.accessToken];
  }
}

// ───────────────────────── selección por entorno ─────────────────────────

export interface CreateOtpSenderOptions extends HttpSenderOptions {
  /** Atajo para pruebas; por defecto sale de NODE_ENV. */
  production?: boolean;
}

const OTP_SENDERS = ['console', 'twilio', 'whatsapp'] as const;

/**
 * Elige el canal de OTP según OTP_SENDER (console | twilio | whatsapp) y valida TODAS las
 * variables de ese canal. Falla al arrancar con un mensaje en español en vez de descubrir una
 * credencial faltante cuando un cliente real pide su primer código.
 */
export function createOtpSender(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateOtpSenderOptions = {},
): OtpSender {
  const production = options.production ?? env.NODE_ENV === 'production';
  const get = (name: string) => env[name]?.trim() || undefined;

  const choice = get('OTP_SENDER')?.toLowerCase();
  if (!choice) {
    if (production) {
      throw new Error(
        'Producción requiere OTP_SENDER=twilio o OTP_SENDER=whatsapp para enviar los códigos de acceso',
      );
    }
    return new ConsoleOtpSender();
  }
  if (!(OTP_SENDERS as readonly string[]).includes(choice)) {
    throw new Error(`OTP_SENDER="${choice}" no es válido. Usa console, twilio o whatsapp`);
  }

  if (choice === 'console') {
    if (production) {
      throw new Error(
        'OTP_SENDER=console no se permite en producción: el código quedaría escrito en los logs. ' +
          'Usa twilio o whatsapp',
      );
    }
    return new ConsoleOtpSender();
  }

  const problems: string[] = [];
  const need = (name: string, pattern?: RegExp, hint?: string) => {
    const value = get(name);
    if (!value) {
      problems.push(`falta ${name}`);
      return '';
    }
    if (pattern && !pattern.test(value)) problems.push(`${name} no es válido (${hint})`);
    return value;
  };

  if (choice === 'twilio') {
    const accountSid = need('TWILIO_ACCOUNT_SID', /^AC[0-9a-f]{32}$/i, 'empieza con AC');
    const authToken = need('TWILIO_AUTH_TOKEN');
    const messagingServiceSid = get('TWILIO_MESSAGING_SERVICE_SID');
    const from = get('TWILIO_FROM');
    if (!messagingServiceSid && !from) {
      problems.push('falta TWILIO_FROM o TWILIO_MESSAGING_SERVICE_SID');
    }
    if (messagingServiceSid && !/^MG[0-9a-f]{32}$/i.test(messagingServiceSid)) {
      problems.push('TWILIO_MESSAGING_SERVICE_SID no es válido (empieza con MG)');
    }
    if (!messagingServiceSid && from && !E164.test(from)) {
      problems.push('TWILIO_FROM no es válido (usa formato internacional, p. ej. +18095550000)');
    }
    if (problems.length > 0) throw configError('twilio', problems);
    return new TwilioSmsSender({ accountSid, authToken, from, messagingServiceSid }, options);
  }

  const phoneNumberId = need('WHATSAPP_PHONE_NUMBER_ID', /^\d{5,25}$/, 'entre 5 y 25 dígitos');
  const accessToken = need('WHATSAPP_ACCESS_TOKEN');
  const template = need('WHATSAPP_OTP_TEMPLATE', /^[a-z0-9_]{1,512}$/, 'minúsculas, números y _');
  const language = get('WHATSAPP_OTP_LANGUAGE') ?? 'es';
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) {
    problems.push('WHATSAPP_OTP_LANGUAGE no es válido (p. ej. es o es_MX)');
  }
  if (problems.length > 0) throw configError('whatsapp', problems);
  return new WhatsAppCloudSender({ phoneNumberId, accessToken, template, language }, options);
}

function configError(channel: string, problems: string[]): Error {
  return new Error(
    `Configuración incompleta de OTP_SENDER=${channel}: ${problems.join('; ')}. ` +
      'Revisa las variables de entorno antes de arrancar.',
  );
}
