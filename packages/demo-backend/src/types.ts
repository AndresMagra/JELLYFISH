import type {
  AddressInput,
  OrderStatus,
  PaymentMethodName,
  PaymentStatusName,
  PricingUnit,
  TransferInfoDTO,
} from '@jellyfish/shared';
import type { DemoCoupon } from './coupons';
import type { Random } from './util';

/** Lo mínimo de `localStorage` que se usa (así corre igual en el navegador y en las pruebas). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CategorySeed {
  slug: string;
  name: string;
  tagline?: string;
  sort?: number;
}

export interface PhotoSeed {
  sku: string;
  /**
   * La foto que se muestra: una ruta relativa a la página (`photos/<sku>.thumb.webp`, vista previa) o una
   * URL completa (la variante liviana `minUrl` del manifiesto, en pruebas y en el modo con red).
   */
  url: string;
  /** true = imagen ilustrativa (la app la rotula así). */
  illustrative: boolean;
}

export interface ZoneSeed {
  name: string;
  /** Sectores y ciudades cubiertos (se comparan sin acentos ni mayúsculas). */
  areas: string[];
  feeCentavos: number;
  minOrderCentavos: number;
  freeOverCentavos: number | null;
}

export type LifecycleStage = 'confirmed' | 'picking' | 'packed' | 'out_for_delivery';

export interface DemoOptions {
  /** Solo se atienden las URLs que empiezan con esta dirección (p. ej. https://demo.jellyfish.local). */
  baseUrl: string;
  /** Contenido de data/catalog/products.seed.csv. */
  catalogCsv: string;
  /** Contenido de data/catalog/categories.json. */
  categories: CategorySeed[];
  /** Fotos del manifiesto (por SKU). Sin ellas se usa la columna `foto` del CSV. */
  photos?: PhotoSeed[] | Record<string, { url: string; illustrative: boolean }>;
  /**
   * URL absoluta de la carpeta donde está publicada la página (con "/" al final). Las fotos con ruta
   * relativa (`photos/<sku>.thumb.webp`) se resuelven contra ella.
   */
  photoBase?: string;
  /**
   * Vista previa publicada: solo fotos propias. Ignora la columna `foto` del CSV y descarta cualquier
   * foto que apunte a otro servidor (la página no puede pedir nada fuera de sus propios archivos).
   */
  localPhotosOnly?: boolean;
  /** Velocidad del ciclo del pedido: 1 = ≈25 s por etapa; 2 = el doble de rápido. */
  speed?: number;
  /** Duración base de cada etapa en segundos (antes de dividir entre `speed`). */
  stageSeconds?: Partial<Record<LifecycleStage, number>>;
  /** Reloj (milisegundos). Se inyecta uno falso en las pruebas. */
  now?: () => number;
  /** Semilla de los números aleatorios (PIN, ids, pesos). Sin ella se usa Math.random. */
  seed?: number;
  random?: Random;
  /** Dónde se guarda el estado entre recargas. `null` = solo en memoria. Por defecto localStorage. */
  storage?: KeyValueStorage | null;
  storageKey?: string;
  /** Latencia simulada de cada respuesta (ms). */
  latencyMs?: number;
  /** Existencias de ejemplo; por defecto holgadas (100–400 lb y 30–120 unidades, según el SKU). */
  stock?: { lbCentilb?: number; units?: number; bySku?: Record<string, number> };
  zone?: ZoneSeed;
  /** Cupones de ejemplo; por defecto BIENVENIDO10, ENVIOGRATIS y AHORRA200. `[]` = sin cupones. */
  coupons?: DemoCoupon[];
  transferInfo?: TransferInfoDTO;
  /** Cuánto tarda el banco simulado en aprobar el pago con tarjeta (ms; se divide entre `speed`). */
  paymentApproveMs?: number;
  /** Cuánto tarda en "verificarse" una transferencia ya reportada (ms; se divide entre `speed`). */
  transferVerifyMs?: number;
  /** Código que se le muestra a la persona. Cualquier código de 6 dígitos funciona. */
  otpCode?: string;
  /** true = exige haber pedido el código antes de verificarlo y limita los códigos como el API real. */
  strictOtp?: boolean;
  /** `fetch` real al que se delegan las URLs que no son del servidor de demostración. */
  fetch?: typeof fetch;
}

export interface UserRec {
  id: string;
  phone: string;
  name: string;
  email: string | null;
  role: 'customer';
  createdAt: string;
  deletedAt: string | null;
}

export interface AddressRec {
  id: string;
  userId: string;
  label: string;
  line1: string;
  reference: string;
  sector: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  contactPhone: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface AddressSnapshot {
  label: string;
  line1: string;
  reference: string;
  sector: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  contactPhone: string | null;
}

export interface ItemRec {
  id: string;
  orderId: string;
  variantId: string;
  sku: string;
  name: string;
  variant: string;
  pricingUnit: PricingUnit;
  unitPrice: number;
  itbisBps: number;
  variableWeight: boolean;
  quantity: number;
  finalQuantity: number | null;
  lineTotal: number;
  finalLineTotal: number | null;
}

export interface PaymentRec {
  id: string;
  orderId: string;
  provider: string;
  method: PaymentMethodName;
  status: PaymentStatusName;
  amount: number;
  capturedAmount: number;
  refundedAmount: number;
  refundPending: number;
  failureReason: string | null;
  providerRef: string | null;
  proof: { reference: string; note: string; submittedAt: string } | null;
  /** Cuándo el banco (o la verificación de la transferencia) simulado resuelve este pago. */
  settleAt: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventRec {
  id: string;
  orderId: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorId: string | null;
  note: string;
  createdAt: string;
}

export interface OrderRec {
  id: string;
  number: number;
  userId: string;
  status: OrderStatus;
  paymentMethod: PaymentMethodName;
  substitutionPolicy: 'contact' | 'substitute' | 'refund';
  zoneId: string;
  address: AddressSnapshot;
  slotStart: string;
  slotEnd: string;
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
  driverId: string | null;
  cancelReason: string | null;
  idempotencyKey: string | null;
  couponCode: string | null;
  deliveryPin: string;
  pinVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  /** Milisegundos en que el pedido entró a su estado actual (de ahí corren las etapas). */
  stageEnteredAt: number;
  items: ItemRec[];
  payments: PaymentRec[];
  timeline: EventRec[];
}

export interface StockRec {
  onHand: number;
  reserved: number;
}

export interface DeviceRec {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  lastSeenAt: string;
}

export interface DemoState {
  version: number;
  /** Huella del catálogo con el que se creó: si cambia, el estado viejo se descarta. */
  signature: string;
  orderCounter: number;
  users: UserRec[];
  sessions: Record<string, string>;
  /** Teléfono → milisegundos de cada código pedido (para el límite y la vigencia). */
  otpRequests: Record<string, number[]>;
  addresses: AddressRec[];
  orders: OrderRec[];
  stock: Record<string, StockRec>;
  devices: DeviceRec[];
}

export type { AddressInput };
