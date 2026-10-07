import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Centavos, assertCentavos } from '@jellyfish/shared';
import type { CallbackResult, CardGateway, CheckoutRequest, RedirectForm } from './types';

/**
 * Integración con la Payment Page de AZUL (Banco Popular).
 *
 * ⚠️ ESTADO DE VERIFICACIÓN — leer antes de producción
 * Los endpoints, los campos del formulario, el orden de campos del hash y el formato de montos
 * provienen de una implementación pública de terceros y del contexto de la documentación pública
 * de AZUL. NO se han probado contra el ambiente de pruebas de AZUL ni contra su documentación
 * oficial (requiere afiliación del comercio y credenciales). Las pruebas automáticas solo
 * demuestran que firmar y verificar son consistentes entre sí y detectan alteraciones.
 * Antes de cobrar a clientes reales: hacer una transacción de prueba en pruebas.azul.com.do y,
 * si AZUL rechaza el hash, probar `hashEncoding: 'utf16le'` (el ejemplo PHP oficial convierte a UTF-16LE).
 *
 * La Payment Page realiza un cobro inmediato (Sale). No hay retención/captura en este flujo.
 */

export const AZUL_URLS = {
  test: 'https://pruebas.azul.com.do/PaymentPage/',
  production: 'https://pagos.azul.com.do/PaymentPage/Default.aspx',
} as const;

export type HashEncoding = 'utf8' | 'utf16le';

export interface AzulConfig {
  environment: 'test' | 'production';
  merchantId: string;
  merchantName: string;
  /** Tipo de comercio asignado por AZUL (p. ej. "ECommerce"). */
  merchantType: string;
  /** Clave de autenticación del comercio (secreto: solo en el servidor). */
  authKey: string;
  terminalId?: string;
  /** Codificación del texto antes de firmar. Por defecto UTF-8. */
  hashEncoding?: HashEncoding;
}

/** Orden EXACTO de los campos firmados en la solicitud (seguido de la AuthKey). */
export const AZUL_REQUEST_HASH_FIELDS = [
  'MerchantId',
  'MerchantName',
  'MerchantType',
  'CurrencyCode',
  'OrderNumber',
  'Amount',
  'ITBIS',
  'ApprovedUrl',
  'DeclinedUrl',
  'CancelUrl',
  'UseCustomField1',
  'CustomField1Label',
  'CustomField1Value',
  'UseCustomField2',
  'CustomField2Label',
  'CustomField2Value',
] as const;

/** Orden EXACTO de los campos firmados en la respuesta (seguido de la AuthKey). */
export const AZUL_RESPONSE_HASH_FIELDS = [
  'OrderNumber',
  'Amount',
  'AuthorizationCode',
  'DateTime',
  'ResponseCode',
  'IsoCode',
  'ResponseMessage',
  'ErrorDescription',
  'RRN',
] as const;

/** AZUL espera el monto en centavos, sin separadores y con al menos 3 dígitos ("100" = 1.00). */
export function azulAmount(centavos: Centavos): string {
  assertCentavos(centavos);
  if (centavos < 0) throw new RangeError('El monto no puede ser negativo');
  return String(centavos).padStart(3, '0');
}

function signFields(
  values: Record<string, string>,
  order: readonly string[],
  authKey: string,
  encoding: HashEncoding,
): string {
  const data = order.map((f) => values[f] ?? '').join('') + authKey;
  return createHmac('sha512', authKey).update(Buffer.from(data, encoding)).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase(), 'utf8');
  const y = Buffer.from(b.toLowerCase(), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AzulGateway implements CardGateway {
  readonly name = 'azul';

  constructor(private readonly config: AzulConfig) {
    for (const k of ['merchantId', 'merchantName', 'merchantType', 'authKey'] as const) {
      if (!config[k]) throw new Error(`AZUL: falta ${k}`);
    }
  }

  private get encoding(): HashEncoding {
    return this.config.hashEncoding ?? 'utf8';
  }

  createCheckout(request: CheckoutRequest): RedirectForm {
    if (!/^[A-Za-z0-9]{1,15}$/.test(request.orderNumber)) {
      throw new RangeError('orderNumber debe ser alfanumérico de máximo 15 caracteres');
    }
    if (request.amount <= 0) throw new RangeError('El monto a cobrar debe ser mayor que 0');

    const fields: Record<string, string> = {
      MerchantId: this.config.merchantId,
      MerchantName: this.config.merchantName,
      MerchantType: this.config.merchantType,
      CurrencyCode: '$',
      OrderNumber: request.orderNumber,
      Amount: azulAmount(request.amount),
      ITBIS: azulAmount(request.itbis),
      ApprovedUrl: request.approvedUrl,
      DeclinedUrl: request.declinedUrl,
      CancelUrl: request.cancelUrl,
      UseCustomField1: '0',
      CustomField1Label: '',
      CustomField1Value: '',
      UseCustomField2: '0',
      CustomField2Label: '',
      CustomField2Value: '',
    };
    const authHash = signFields(
      fields,
      AZUL_REQUEST_HASH_FIELDS,
      this.config.authKey,
      this.encoding,
    );
    return {
      kind: 'redirect_form',
      url: AZUL_URLS[this.config.environment],
      method: 'POST',
      fields: {
        ...fields,
        TerminalId: this.config.terminalId ?? '00000001',
        CustomOrderId: request.customOrderId ?? request.orderNumber,
        ShowTransactionResult: '0',
        Locale: 'ES',
        AuthHash: authHash,
      },
    };
  }

  verifyCallback(params: Record<string, string | undefined>): CallbackResult {
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) if (typeof v === 'string') raw[k] = v;

    const received = raw.AuthHash ?? '';
    // Sin hash no hay forma de saber quién envió esto.
    let valid = false;
    if (received) {
      // La documentación de AZUL admite ambas codificaciones al verificar.
      valid = (['utf8', 'utf16le'] as const).some((enc) =>
        safeEqualHex(
          received,
          signFields(raw, AZUL_RESPONSE_HASH_FIELDS, this.config.authKey, enc),
        ),
      );
    }

    const amountText = (raw.Amount ?? '').trim();
    const amount = /^\d+$/.test(amountText) ? Number.parseInt(amountText, 10) : null;
    const isoCode = raw.IsoCode ?? '';
    return {
      valid,
      approved: valid && isoCode === '00',
      orderNumber: raw.OrderNumber ?? '',
      amount,
      authorizationCode: raw.AuthorizationCode ?? '',
      rrn: raw.RRN ?? '',
      azulOrderId: raw.AzulOrderId ?? '',
      isoCode,
      responseCode: raw.ResponseCode ?? '',
      message: raw.ResponseMessage || raw.ErrorDescription || '',
      raw,
    };
  }

  /** Solo para el simulador y las pruebas: firma una respuesta como lo haría AZUL. */
  signResponseForTesting(values: Record<string, string>): string {
    return signFields(values, AZUL_RESPONSE_HASH_FIELDS, this.config.authKey, this.encoding);
  }
}
