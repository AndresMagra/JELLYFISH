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
