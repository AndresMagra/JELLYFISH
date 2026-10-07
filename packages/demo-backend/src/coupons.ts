import { type CouponKind, formatDOP } from '@jellyfish/shared';
import type { Ctx } from './context';

/**
 * Cupones de la vista previa. Son las mismas reglas que `apps/api/src/services/coupons.ts` (código
 * normalizado, porcentaje con redondeo hacia abajo, mínimo de compra, límites de uso, envío
 * gratis), con tres cupones de ejemplo que la persona puede probar.
 */
export interface DemoCoupon {
  code: string;
  description: string;
  kind: CouponKind;
  /** percent: puntos básicos (1000 = 10 %); fixed: centavos; free_delivery: se ignora. */
  value: number;
  /** Subtotal mínimo (centavos) para poder usarlo. */
  minSubtotal: number;
  /** Tope del descuento en centavos (útil con porcentajes). */
  maxDiscount: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
  maxRedemptions?: number | null;
  perUserLimit: number;
  active: boolean;
}

/** Cupones de ejemplo: sin vencimiento y con muchos usos por persona para poder repetir la prueba. */
export const DEFAULT_COUPONS: DemoCoupon[] = [
  {
    code: 'BIENVENIDO10',
    description: '',
    kind: 'percent',
    value: 1000,
    minSubtotal: 100_000,
    maxDiscount: 50_000,
    perUserLimit: 99,
    active: true,
  },
  {
    code: 'ENVIOGRATIS',
    description: '',
    kind: 'free_delivery',
    value: 0,
    minSubtotal: 0,
    maxDiscount: null,
    perUserLimit: 99,
    active: true,
  },
  {
    code: 'AHORRA200',
    description: '',
    kind: 'fixed',
    value: 20_000,
    minSubtotal: 150_000,
    maxDiscount: null,
    perUserLimit: 99,
    active: true,
  },
];

export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

/** Lo que se teclea en el celular casi nunca viene limpio: espacios, minúsculas, guiones largos. */
export function normalizeCouponCode(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s​-‍⁠﻿]+/gu, '')
    .replace(/[‐-―−]/gu, '-')
    .toUpperCase();
}

/**
 * Descuento sobre los PRODUCTOS (centavos, ITBIS incluido). Los porcentajes redondean hacia abajo
 * y nunca superan el subtotal ni el tope. El envío gratis no descuenta productos.
 */
export function couponDiscount(
  coupon: Pick<DemoCoupon, 'kind' | 'value' | 'maxDiscount'>,
  subtotal: number,
): number {
  if (coupon.kind === 'free_delivery' || subtotal <= 0) return 0;
  let discount =
    coupon.kind === 'percent' ? Math.floor((subtotal * coupon.value) / 10_000) : coupon.value;
  if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  return Math.max(0, Math.min(discount, subtotal));
}

export function describeCoupon(
  coupon: Pick<DemoCoupon, 'kind' | 'value' | 'description' | 'maxDiscount'>,
): string {
  if (coupon.description.trim()) return coupon.description.trim();
  if (coupon.kind === 'free_delivery') return 'Envío gratis';
  if (coupon.kind === 'fixed') return `${formatDOP(coupon.value)} de descuento`;
  const base = `${coupon.value / 100} % de descuento`;
  return coupon.maxDiscount !== null ? `${base} (hasta ${formatDOP(coupon.maxDiscount)})` : base;
}

export type CouponRejection =
  | 'login_required'
  | 'not_found'
  | 'not_started'
  | 'expired'
  | 'exhausted'
  | 'user_limit'
  | 'below_minimum'
  | 'no_benefit'
  | 'covers_all';

export type CouponAssessment =
  | { ok: true; coupon: DemoCoupon; discount: number; deliveryWaived: number }
  | { ok: false; reason: CouponRejection; message: string };

export const COUPON_NOT_FOUND = 'No encontramos ese cupón. Revisa que esté bien escrito';

const rejected = (reason: CouponRejection, message: string): CouponAssessment => ({
  ok: false,
  reason,
  message,
});

const longDate = (ms: number) =>
  new Date(ms - 4 * 3_600_000).toISOString().slice(8, 10).replace(/^0/, '') +
  ' de ' +
  [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ][new Date(ms - 4 * 3_600_000).getUTCMonth()];

/** Decide si el cupón sirve para este carrito (mismo orden de reglas que el API). */
export function assessCoupon(
  coupon: DemoCoupon,
  cart: { subtotal: number; deliveryFee: number | null },
  usage: { total: number; byUser: number },
  now: number,
): CouponAssessment {
  if (!coupon.active) return rejected('not_found', COUPON_NOT_FOUND);
  if (coupon.startsAt && coupon.startsAt > now) {
    return rejected('not_started', `Este cupón estará disponible desde el ${longDate(coupon.startsAt)}`);
  }
  if (coupon.endsAt && coupon.endsAt <= now) return rejected('expired', 'Este cupón venció');
  if (coupon.maxRedemptions != null && usage.total >= coupon.maxRedemptions) {
    return rejected('exhausted', 'Este cupón ya se agotó');
  }
  if (usage.byUser >= coupon.perUserLimit) {
    return rejected(
      'user_limit',
      coupon.perUserLimit === 1
        ? 'Ya usaste este cupón'
        : `Ya usaste este cupón el máximo de veces (${coupon.perUserLimit})`,
    );
  }
  if (cart.subtotal < coupon.minSubtotal) {
    return rejected(
      'below_minimum',
      `Necesitas ${formatDOP(coupon.minSubtotal - cart.subtotal)} más para usarlo`,
    );
  }
  if (coupon.kind === 'free_delivery') {
    // Zona desconocida (aún no hay dirección): se acepta y se aplica cuando se conozca.
    if (cart.deliveryFee === 0) {
      return rejected('no_benefit', 'Tu envío ya es gratis, no necesitas este cupón');
    }
    return { ok: true, coupon, discount: 0, deliveryWaived: cart.deliveryFee ?? 0 };
  }
  const discount = couponDiscount(coupon, cart.subtotal);
  if (discount <= 0) return rejected('no_benefit', 'Este cupón no aplica a este pedido');
  return { ok: true, coupon, discount, deliveryWaived: 0 };
}

export function findCoupon(ctx: Ctx, rawCode: string): DemoCoupon | null {
  const code = normalizeCouponCode(rawCode);
  if (!COUPON_CODE_PATTERN.test(code)) return null;
  return ctx.coupons.find((c) => c.code === code) ?? null;
}

/** Cuántas veces está en uso un cupón: los pedidos cancelados ya no cuentan (se libera el uso). */
export function couponUsage(ctx: Ctx, code: string, userId: string) {
  const live = ctx.state.orders.filter((o) => o.couponCode === code && o.status !== 'cancelled');
  return { total: live.length, byUser: live.filter((o) => o.userId === userId).length };
}

export function evaluateCoupon(
  ctx: Ctx,
  input: { rawCode: string; userId: string | null; subtotal: number; deliveryFee: number | null },
): CouponAssessment {
  if (!input.userId) return rejected('login_required', 'Inicia sesión para usar un cupón');
  const coupon = findCoupon(ctx, input.rawCode);
  if (!coupon || !coupon.active) return rejected('not_found', COUPON_NOT_FOUND);
  return assessCoupon(
    coupon,
    { subtotal: input.subtotal, deliveryFee: input.deliveryFee },
    couponUsage(ctx, coupon.code, input.userId),
    ctx.now(),
  );
}

/**
 * Descuento definitivo al empacar, con el peso real: el porcentaje se recalcula sobre el monto
 * real (con su tope); el monto fijo se mantiene, nunca más que el monto real.
 */
export function finalDiscountForOrder(
  ctx: Ctx,
  order: { couponCode: string | null; discount: number },
  grossFinal: number,
): number {
  if (!order.couponCode || order.discount <= 0) return order.discount;
  const coupon = ctx.coupons.find((c) => c.code === order.couponCode);
  if (coupon?.kind === 'percent') return couponDiscount(coupon, grossFinal);
  return Math.min(order.discount, grossFinal);
}
