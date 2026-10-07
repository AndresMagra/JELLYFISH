import type { OrderStatus } from './order-status';
import type { PricingUnit } from './pricing';

/**
 * Forma JSON de las respuestas públicas del API (las fechas viajan como texto ISO).
 * Las apps móviles y el panel importan estos tipos; el API los produce.
 */
export type PaymentMethodName = 'card' | 'cash' | 'transfer';
export type PaymentStatusName =
  'pending' | 'authorized' | 'captured' | 'failed' | 'voided' | 'refunded' | 'partially_refunded';

export interface CategoryDTO {
  slug: string;
  name: string;
  tagline: string;
  sort: number;
}

export interface VariantDTO {
  id: string;
  sku: string;
  variant: string;
  pricingUnit: PricingUnit;
  price: number;
  itbisBps: number;
  variableWeight: boolean;
  frozen: boolean;
  stepCentilb: number | null;
  minCentilb: number | null;
  pieceCentilb: number | null;
  available: number;
  inStock: boolean;
  photo: string;
  unconfirmed: boolean;
}

export interface ProductDTO {
  group: string;
  name: string;
  category: string;
  subcategory: string;
  description: string;
  cookingTip: string;
  pricingUnit: PricingUnit;
  fromPrice: number;
  variants: VariantDTO[];
}

export interface ProductListDTO {
  items: ProductDTO[];
  total: number;
  demo: boolean;
}

export type ZoneCheckDTO =
  | { covered: false }
  | {
      covered: true;
      zone: { id: string; name: string };
      feeCentavos: number;
      minOrderCentavos: number;
      freeOverCentavos: number | null;
    };

export interface SlotDTO {
  start: string;
  end: string;
  remaining: number;
  available: boolean;
}

export interface QuoteLineDTO {
  variantId: string;
  sku: string;
  name: string;
  variant: string;
  pricingUnit: PricingUnit;
  unitPrice: number;
  itbisBps: number;
  variableWeight: boolean;
  quantity: number;
  photo: string;
  gross: number;
  discount: number;
  net: number;
  itbis: number;
}

export interface QuoteDTO {
  lines: QuoteLineDTO[];
  subtotal: number;
  discount: number;
  deliveryFee: number;
  itbis: number;
  total: number;
  authorizedAmount: number;
  zone: { id: string; name: string } | null;
  freeDelivery: boolean;
  missingForMinimum: number;
  missingForFreeDelivery: number | null;
  demo: boolean;
  coverage: 'covered' | 'not_covered' | 'unknown';
}

export interface AddressDTO {
  id: string;
  label: string;
  line1: string;
  reference: string;
  sector: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  contactPhone: string | null;
  isDefault: boolean;
}

export interface AddressInput {
  label: string;
  line1: string;
  reference: string;
  sector: string;
  city: string;
  latitude?: number | null;
  longitude?: number | null;
  contactPhone?: string | null;
  isDefault?: boolean;
}

export interface UserDTO {
  id: string;
  phone: string;
  name: string;
  email: string | null;
  role: 'customer' | 'admin' | 'staff' | 'driver';
}

export interface OrderItemDTO {
  id: string;
  sku: string;
  name: string;
  variant: string;
  pricingUnit: PricingUnit;
  unitPrice: number;
  variableWeight: boolean;
  quantity: number;
  finalQuantity: number | null;
  lineTotal: number;
  finalLineTotal: number | null;
}

export interface PaymentSummaryDTO {
  id: string;
  provider: string;
  method: PaymentMethodName;
  status: PaymentStatusName;
  amount: number;
  capturedAmount: number;
  refundedAmount: number;
  refundPending: number;
  failureReason: string | null;
  proofSubmitted: boolean;
  createdAt: string;
}

export interface OrderEventDTO {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  note: string;
  createdAt: string;
}

export interface OrderDTO {
  id: string;
  number: number;
  code: string;
  status: OrderStatus;
  paymentMethod: PaymentMethodName;
  substitutionPolicy: 'contact' | 'substitute' | 'refund';
  address: Omit<AddressInput, 'isDefault'>;
  slotStart: string | null;
  slotEnd: string | null;
  notes: string;
  subtotal: number;
  discount: number;
  deliveryFee: number;
  itbis: number;
  total: number;
  authorizedAmount: number;
  finalTotal: number | null;
  finalItbis: number | null;
  reservationExpiresAt: string | null;
  cancelReason: string | null;
  /** Repartidor asignado (null hasta que se asigna). */
  driverId: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /**
   * PIN de entrega (4 dígitos). SOLO el cliente dueño lo recibe, y únicamente mientras el pedido
   * está confirmado, en preparación, empacado, en camino o con entrega fallida. Para repartidor,
   * personal y administrador siempre es null.
   */
  deliveryPin: string | null;
  /** La entrega se cierra con el PIN del cliente (false en pedidos anteriores al PIN). */
  pinRequired: boolean;
  /** Intentos de PIN que le quedan al repartidor; 0 = bloqueado. null si el pedido no usa PIN. */
  pinAttemptsLeft: number | null;
  pinVerifiedAt: string | null;
  /** Solo personal: motivo con el que se entregó sin PIN (null para el cliente). */
  pinOverrideReason: string | null;
  items: OrderItemDTO[];
  payments: PaymentSummaryDTO[];
  customer: { id: string; name: string; phone: string };
  timeline: OrderEventDTO[];
  next: OrderStatus[];
}

export interface PaymentMethodsDTO {
  card: { available: boolean };
  cash: { available: boolean };
  transfer: { available: boolean };
}

export interface TransferInfoDTO {
  bank: string;
  accountType: string;
  accountNumber: string;
  holder: string;
  taxId: string;
}

export interface StartPaymentDTO {
  paymentId: string;
  amount: number;
  redirectUrl: string;
  expiresAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ───────────── Entrega: PIN, ubicación del repartidor y pedir de nuevo ─────────────

/** Cambio de estado de una entrega. `pin` lo manda el repartidor; `pinOverrideReason`, el personal. */
export interface DeliveryTransitionInput {
  to: OrderStatus;
  note?: string;
  /** Los 4 dígitos que le dice el cliente. Obligatorio para marcar 'delivered' si el pedido tiene PIN. */
  pin?: string;
  /** Personal/administrador: motivo (mínimo 8 caracteres) para entregar sin el PIN del cliente. */
  pinOverrideReason?: string;
}

/** Posición del repartidor que reporta la app (cada 4 s como mínimo; solo dentro de RD). */
export interface DriverLocationInput {
  latitude: number;
  longitude: number;
  /** Precisión del GPS en metros. */
  accuracyM?: number | null;
  /** Pedido que está llevando; debe estar asignado a este repartidor. */
  orderId?: string;
}

export interface DriverLocationAckDTO {
  ok: true;
  updatedAt: string;
}

export type TrackingUnavailableReason =
  /** El pedido todavía no salió o ya terminó. */
  | 'not_out_for_delivery'
  | 'no_driver'
  /** El repartidor aún no ha enviado su posición (o se borró al terminar la entrega). */
  | 'no_position'
  /** La última posición tiene más de 3 minutos. */
  | 'stale';

export type TrackingDTO =
  | { available: true; latitude: number; longitude: number; updatedAt: string; ageSeconds: number }
  | { available: false; reason: TrackingUnavailableReason };

export type ReorderLineStatus = 'ok' | 'reduced' | 'unavailable';

/** Una línea del pedido anterior ya ajustada al catálogo de hoy. */
export interface ReorderLineDTO {
  variantId: string;
  name: string;
  variant: string;
  photo: string;
  /** true = imagen ilustrativa; false = foto real del producto. */
  photoIllustrative: boolean;
  pricingUnit: PricingUnit;
  /** Precio ACTUAL por libra o por unidad, ITBIS incluido (centavos). */
  unitPrice: number;
  /** Lo que se pagó la vez anterior, para avisar si el precio cambió. */
  previousUnitPrice: number;
  /** Lo que pidió el cliente la vez anterior (centilibras o unidades). */
  requestedQuantity: number;
  /** Cantidad sugerida hoy: ajustada a existencias, mínimo y paso (0 si no está disponible). */
  quantity: number;
  status: ReorderLineStatus;
  /** Explicación en español cuando status no es 'ok'. */
  reason?: string;
}

export interface ReorderDTO {
  orderId: string;
  code: string;
  demo: boolean;
  lines: ReorderLineDTO[];
}

// ───────────── Panel de administración ─────────────

export interface AdminVariantDTO {
  id: string;
  sku: string;
  variant: string;
  pricingUnit: PricingUnit;
  price: number;
  priceSource: 'ancla' | 'estimado' | 'usuario';
  priceNote: string;
  cost: number | null;
  itbisBps: number | null;
  variableWeight: boolean;
  frozen: boolean;
  onHand: number;
  reserved: number;
  lowStockThreshold: number;
  photo: string;
  active: boolean;
  productName: string;
  productGroup: string;
  category: string;
  /** Por qué todavía no se puede mostrar a clientes (vacío = publicado). */
  blockers: string[];
}

export interface AdminSummaryDTO {
  generatedAt: string;
  today: { orders: number; sales: number; delivered: number };
  active: Record<
    'pending_payment' | 'confirmed' | 'picking' | 'packed' | 'out_for_delivery' | 'delivery_failed',
    number
  >;
  refunds: { count: number; amount: number };
  transfersToVerify: number;
  cashOutstanding: number;
  catalog: { variants: number; blocked: number; outOfStock: number };
}

export interface ImportResultDTO {
  ok: boolean;
  dryRun: boolean;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  keptConfirmedPrices: string[];
  errors: { line: number; sku: string; field: string; message: string }[];
  warnings: { line: number; sku: string; field: string; message: string }[];
}

export interface AdminPaymentDTO extends PaymentSummaryDTO {
  orderId: string;
  orderCode: string;
  orderStatus: OrderStatus;
}

export interface CashRowDTO {
  driverId: string;
  name: string;
  phone: string;
  collected: number;
  settled: number;
  balance: number;
  deliveries: number;
}

export interface ZoneDTO {
  id: string;
  name: string;
  areas: string[];
  feeCentavos: number;
  minOrderCentavos: number;
  freeOverCentavos: number | null;
  active: boolean;
}

export interface TeamMemberDTO {
  id: string;
  phone: string;
  name: string;
  role: 'customer' | 'admin' | 'staff' | 'driver';
}

// ───────────── Notificaciones push ─────────────

export type DevicePlatformName = 'ios' | 'android' | 'web';

/** POST /v1/me/devices. El token tiene la forma ExponentPushToken[…] o ExpoPushToken[…]. */
export interface RegisterDeviceInput {
  token: string;
  platform: DevicePlatformName;
}

export interface DeviceDTO {
  token: string;
  platform: DevicePlatformName;
  lastSeenAt: string;
}

/** Contenido `data` de toda notificación de pedido: la app abre esa pantalla al tocarla. */
export interface OrderPushData {
  type: 'order';
  orderId: string;
}
