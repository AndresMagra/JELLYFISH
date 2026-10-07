import type { Centavos } from '@jellyfish/shared';

/** Formulario que el navegador debe enviar (POST) a la página de pago alojada por la pasarela. */
export interface RedirectForm {
  kind: 'redirect_form';
  url: string;
  method: 'POST';
  fields: Record<string, string>;
}

export interface CheckoutRequest {
  /** Identificador del intento de pago, único por intento (≤ 15 caracteres alfanuméricos). */
  orderNumber: string;
  /** Total a cobrar, con ITBIS incluido, en centavos. */
  amount: Centavos;
  /** ITBIS contenido en `amount`, en centavos (informativo para el reporte del comercio). */
  itbis: Centavos;
  approvedUrl: string;
  declinedUrl: string;
  cancelUrl: string;
  /** Referencia propia que la pasarela devolverá (p. ej. código legible del pedido). */
  customOrderId?: string;
}

export interface CallbackResult {
  /** El hash de autenticación coincide: la respuesta viene realmente de la pasarela. */
  valid: boolean;
  /** `valid` y la pasarela aprobó el cobro. */
  approved: boolean;
  orderNumber: string;
  /** Monto confirmado por la pasarela, en centavos (null si falta o es ilegible). */
  amount: Centavos | null;
  authorizationCode: string;
  /** Número de referencia de la transacción (RRN). */
  rrn: string;
  azulOrderId: string;
  isoCode: string;
  responseCode: string;
  message: string;
  raw: Record<string, string>;
}

/** Pasarela de tarjeta con página de pago alojada (los datos de tarjeta nunca tocan JELLYFISH). */
export interface CardGateway {
  readonly name: string;
  createCheckout(request: CheckoutRequest): RedirectForm;
  verifyCallback(params: Record<string, string | undefined>): CallbackResult;
}
