import { randomBytes } from 'node:crypto';
import { AzulGateway, azulAmount } from './azul';
import type { CallbackResult, CardGateway, CheckoutRequest, RedirectForm } from './types';

export type MockCallbackParams = {
  OrderNumber: string;
  Amount: string;
  AuthorizationCode: string;
  DateTime: string;
  ResponseCode: string;
  IsoCode: string;
  ResponseMessage: string;
  ErrorDescription: string;
  RRN: string;
  AzulOrderId: string;
  AuthHash: string;
};

/**
 * Pasarela SIMULADA para desarrollo y pruebas. Reutiliza la lógica de firma/verificación de AZUL
 * con una clave aleatoria, de modo que el servidor ejercita el mismo camino de verificación que
 * usará con AZUL real. Nunca debe estar activa en producción.
 */
export class MockGateway implements CardGateway {
  readonly name = 'mock';
  private readonly inner: AzulGateway;
  /** URL de la página simulada que muestra los botones Aprobar/Rechazar. */
  constructor(private readonly pageUrl: string) {
    this.inner = new AzulGateway({
      environment: 'test',
      merchantId: 'MOCK',
      merchantName: 'JELLYFISH (simulado)',
      merchantType: 'ECommerce',
      authKey: randomBytes(24).toString('hex'),
    });
  }

  createCheckout(request: CheckoutRequest): RedirectForm {
    return {
      kind: 'redirect_form',
      url: this.pageUrl,
      method: 'POST',
      fields: {
        OrderNumber: request.orderNumber,
        Amount: azulAmount(request.amount),
        ApprovedUrl: request.approvedUrl,
        DeclinedUrl: request.declinedUrl,
        CancelUrl: request.cancelUrl,
      },
    };
  }

  verifyCallback(params: Record<string, string | undefined>): CallbackResult {
    return this.inner.verifyCallback(params);
  }

  /** Genera los parámetros firmados que AZUL enviaría tras un pago aprobado o rechazado. */
  buildCallback(
    outcome: 'approved' | 'declined',
    order: { orderNumber: string; amount: string },
  ): MockCallbackParams {
    const approved = outcome === 'approved';
    const base = {
      OrderNumber: order.orderNumber,
      Amount: order.amount,
      AuthorizationCode: approved ? randomBytes(3).toString('hex').toUpperCase() : '',
      DateTime: new Date().toISOString().replace(/\D/g, '').slice(0, 14),
      ResponseCode: 'ISO8583',
      IsoCode: approved ? '00' : '05',
      ResponseMessage: approved ? 'APROBADA' : 'DECLINADA',
      ErrorDescription: '',
      RRN: randomBytes(6).toString('hex'),
      AzulOrderId: String(Math.floor(Math.random() * 1e9)),
    };
    return { ...base, AuthHash: this.inner.signResponseForTesting(base) };
  }
}
