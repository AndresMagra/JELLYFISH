import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OrderStatus, PricingUnit } from '@jellyfish/shared';

/** Dinero: enteros en centavos DOP. Pesos: enteros en centilibras. */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export type UserRole = 'customer' | 'admin' | 'staff' | 'driver';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** E.164 dominicano: +1809…, +1829…, +1849… */
    phone: text('phone').notNull(),
    name: text('name').notNull().default(''),
    email: text('email'),
    role: text('role').$type<UserRole>().notNull().default('customer'),
    pushToken: text('push_token'),
    createdAt: createdAt(),
    /** Eliminación de cuenta (exigida por Apple): se anonimiza y se marca. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('users_phone_uq').on(t.phone)],
);

export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('otp_phone_idx').on(t.phone, t.createdAt)],
);

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    label: text('label').notNull().default('Casa'),
    /** Calle y número. */
    line1: text('line1').notNull(),
    /** Referencia dominicana: "al lado del colmado X, portón negro". */
    reference: text('reference').notNull().default(''),
    sector: text('sector').notNull(),
    city: text('city').notNull(),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    contactPhone: text('contact_phone'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('addresses_user_idx').on(t.userId)],
);

export const categories = pgTable('categories', {
  slug: text('slug').primaryKey(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull().default(''),
  sort: integer('sort').notNull().default(0),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Slug estable del grupo de variantes. */
    group: text('group').notNull(),
    name: text('name').notNull(),
    categorySlug: text('category_slug')
      .notNull()
      .references(() => categories.slug),
    subcategory: text('subcategory').notNull().default(''),
    description: text('description').notNull().default(''),
    cookingTip: text('cooking_tip').notNull().default(''),
    pricingUnit: text('pricing_unit').$type<PricingUnit>().notNull(),
    /** Sinónimos dominicanos ("pernil", "lomito"…): alimentan la búsqueda y se conservan al exportar. */
    synonyms: text('synonyms')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** Texto normalizado (sin acentos, minúsculas) con nombre, variantes y sinónimos. */
    searchText: text('search_text').notNull().default(''),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('products_group_uq').on(t.group),
    index('products_cat_idx').on(t.categorySlug),
  ],
);

export type PriceSourceDb = 'ancla' | 'estimado' | 'usuario';

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    sku: text('sku').notNull(),
    variant: text('variant').notNull().default(''),
    pricingUnit: text('pricing_unit').$type<PricingUnit>().notNull(),
    /** Por libra o por unidad, con ITBIS incluido. */
    price: integer('price').notNull(),
    priceSource: text('price_source').$type<PriceSourceDb>().notNull().default('usuario'),
    priceNote: text('price_note').notNull().default(''),
    cost: integer('cost'),
    /** Puntos básicos; null = por confirmar con el contador. */
    itbisBps: integer('itbis_bps'),
    variableWeight: boolean('variable_weight').notNull().default(true),
    frozen: boolean('frozen').notNull().default(true),
    stepCentilb: integer('step_centilb'),
    minCentilb: integer('min_centilb'),
    pieceCentilb: integer('piece_centilb'),
    /** Existencias físicas (centilibras si 'lb'; unidades si 'unit'). */
    onHand: integer('on_hand').notNull().default(0),
    /**
     * Comprometido en pedidos aún no empacados. La disponibilidad se valida al reservar
     * (on_hand - reserved >= cantidad); no hay CHECK reserved <= on_hand porque el peso real
     * al empacar puede superar el estimado.
     */
    reserved: integer('reserved').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    photo: text('photo').notNull().default(''),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('variants_sku_uq').on(t.sku),
    index('variants_product_idx').on(t.productId),
    check('variants_price_positive', sql`${t.price} > 0`),
    check('variants_stock_nonneg', sql`${t.onHand} >= 0 AND ${t.reserved} >= 0`),
  ],
);

export type MovementType =
  'receive' | 'reserve' | 'release' | 'pick' | 'restock' | 'adjust' | 'waste';

/** Bitácora de inventario (auditoría). `qty` es positivo o negativo según el efecto en onHand/reserved. */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id),
    type: text('type').$type<MovementType>().notNull(),
    qty: integer('qty').notNull(),
    orderId: uuid('order_id'),
    actorId: uuid('actor_id'),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('movements_variant_idx').on(t.variantId, t.createdAt)],
);

export const deliveryZones = pgTable('delivery_zones', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Nombres de sectores/municipios cubiertos (comparación sin acentos ni mayúsculas). */
  areas: text('areas')
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  feeCentavos: integer('fee_centavos').notNull().default(0),
  minOrderCentavos: integer('min_order_centavos').notNull().default(0),
  /** Envío gratis si el subtotal alcanza este monto. */
  freeOverCentavos: integer('free_over_centavos'),
  active: boolean('active').notNull().default(true),
});

export type PaymentMethod = 'card' | 'cash' | 'transfer';
export type SubstitutionPolicy = 'contact' | 'substitute' | 'refund';

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Número legible: JF-000123. */
    number: integer('number').notNull().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<OrderStatus>().notNull().default('pending_payment'),
    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    substitutionPolicy: text('substitution_policy')
      .$type<SubstitutionPolicy>()
      .notNull()
      .default('contact'),
    zoneId: uuid('zone_id').references(() => deliveryZones.id),
    /** Copia de la dirección al momento de pedir (no cambia si el cliente edita la suya). */
    address: jsonb('address').$type<AddressSnapshot>().notNull(),
    slotStart: timestamp('slot_start', { withTimezone: true }),
    slotEnd: timestamp('slot_end', { withTimezone: true }),
    notes: text('notes').notNull().default(''),

    subtotal: integer('subtotal').notNull(),
    discount: integer('discount').notNull().default(0),
    deliveryFee: integer('delivery_fee').notNull().default(0),
    itbis: integer('itbis').notNull().default(0),
    total: integer('total').notNull(),
    /** Monto a pre-autorizar en tarjeta (total + colchón de peso variable). */
    authorizedAmount: integer('authorized_amount').notNull(),
    /** Total e ITBIS reales tras pesar; null hasta empacar. */
    finalTotal: integer('final_total'),
    finalItbis: integer('final_itbis'),

    /** Hasta cuándo se mantiene la reserva de stock si no se paga. */
    reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),
    driverId: uuid('driver_id').references(() => users.id),
    cancelReason: text('cancel_reason'),
    /** Evita pedidos duplicados cuando la app reintenta tras un corte de red. */
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('orders_idem_uq')
      .on(t.userId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_status_idx').on(t.status),
    index('orders_slot_idx').on(t.slotStart),
    check('orders_total_nonneg', sql`${t.total} >= 0 AND ${t.subtotal} >= 0`),
  ],
);

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

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    variant: text('variant').notNull().default(''),
    pricingUnit: text('pricing_unit').$type<PricingUnit>().notNull(),
    unitPrice: integer('unit_price').notNull(),
    itbisBps: integer('itbis_bps').notNull().default(0),
    variableWeight: boolean('variable_weight').notNull(),
    /** Pedido: centilibras ('lb') o unidades ('unit'). */
    quantity: integer('quantity').notNull(),
    /** Peso real al empacar (solo 'lb' con peso variable). */
    finalQuantity: integer('final_quantity'),
    lineTotal: integer('line_total').notNull(),
    finalLineTotal: integer('final_line_total'),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    fromStatus: text('from_status').$type<OrderStatus>(),
    toStatus: text('to_status').$type<OrderStatus>().notNull(),
    actorId: uuid('actor_id'),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.createdAt)],
);

export type PaymentStatus =
  'pending' | 'authorized' | 'captured' | 'failed' | 'voided' | 'refunded' | 'partially_refunded';

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    provider: text('provider').notNull(),
    method: text('method').$type<PaymentMethod>().notNull(),
    status: text('status').$type<PaymentStatus>().notNull().default('pending'),
    /** Monto solicitado/autorizado. */
    amount: integer('amount').notNull(),
    capturedAmount: integer('captured_amount').notNull().default(0),
    refundedAmount: integer('refunded_amount').notNull().default(0),
    providerRef: text('provider_ref'),
    /** Dinero cobrado que hay que devolver al cliente y todavía no se ha devuelto. */
    refundPending: integer('refund_pending').notNull().default(0),
    failureReason: text('failure_reason'),
    /** Repartidor que cobró en efectivo. */
    collectedBy: uuid('collected_by').references(() => users.id),
    /**
     * Identificador único del intento (para AZUL es el OrderNumber que viaja a la pasarela):
     * evita cobros duplicados y permite ubicar el pago cuando llega el callback.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    raw: jsonb('raw'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_idem_uq').on(t.idempotencyKey),
    index('payments_order_idx').on(t.orderId),
    check(
      'payments_amounts_nonneg',
      sql`${t.amount} >= 0 AND ${t.capturedAmount} >= 0 AND ${t.refundedAmount} >= 0`,
    ),
    check('payments_refund_le_captured', sql`${t.refundedAmount} <= ${t.capturedAmount}`),
    check('payments_refund_pending_nonneg', sql`${t.refundPending} >= 0`),
  ],
);

/** Efectivo que un repartidor entregó al negocio (cuadre de caja). */
export const cashSettlements = pgTable(
  'cash_settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    driverId: uuid('driver_id')
      .notNull()
      .references(() => users.id),
    amount: integer('amount').notNull(),
    note: text('note').notNull().default(''),
    settledBy: uuid('settled_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('cash_settlements_driver_idx').on(t.driverId, t.createdAt),
    check('cash_settlements_positive', sql`${t.amount} > 0`),
  ],
);

export const schema = {
  users,
  otpCodes,
  addresses,
  categories,
  products,
  variants,
  inventoryMovements,
  deliveryZones,
  orders,
  orderItems,
  orderEvents,
  payments,
  cashSettlements,
};
