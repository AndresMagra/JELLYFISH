import { describe, expect, it } from 'vitest';
import {
  type DemoCoupon,
  assessCoupon,
  couponDiscount,
  describeCoupon,
  normalizeCouponCode,
} from '../src/coupons';

const base: DemoCoupon = {
  code: 'PRUEBA10',
  description: '',
  kind: 'percent',
  value: 1000,
  minSubtotal: 100_000,
  maxDiscount: 50_000,
  perUserLimit: 1,
  active: true,
};
const NOW = Date.parse('2026-10-07T14:00:00Z');
const cart = (subtotal: number, deliveryFee: number | null = 15_000) => ({ subtotal, deliveryFee });
const fresh = { total: 0, byUser: 0 };

describe('cupones de la vista previa (mismas reglas que el API)', () => {
  it('el código se normaliza: espacios (incluso invisibles), minúsculas y guiones largos', () => {
    expect(normalizeCouponCode('  bienvenido 10 ')).toBe('BIENVENIDO10');
    expect(normalizeCouponCode('envío​gratis')).toBe('ENVÍOGRATIS');
    expect(normalizeCouponCode('ahorra–20')).toBe('AHORRA-20');
  });

  it('el porcentaje redondea hacia abajo y respeta el tope y el subtotal', () => {
    expect(couponDiscount(base, 123_456)).toBe(12_345);
    expect(couponDiscount(base, 1_000_000)).toBe(50_000); // tope
    expect(
      couponDiscount({ ...base, kind: 'fixed', value: 20_000, maxDiscount: null }, 15_000),
    ).toBe(15_000);
    expect(couponDiscount({ ...base, kind: 'free_delivery' }, 500_000)).toBe(0);
    expect(couponDiscount(base, 0)).toBe(0);
  });

  it('textos para el cliente', () => {
    expect(describeCoupon(base)).toBe('10 % de descuento (hasta RD$ 500.00)');
    expect(describeCoupon({ ...base, kind: 'fixed', value: 20_000 })).toBe(
      'RD$ 200.00 de descuento',
    );
    expect(describeCoupon({ ...base, kind: 'free_delivery' })).toBe('Envío gratis');
    expect(describeCoupon({ ...base, description: ' Solo hoy ' })).toBe('Solo hoy');
  });

  it('rechaza con el motivo y el mensaje correctos, de lo que no se arregla a lo que sí', () => {
    const msg = (c: Partial<DemoCoupon>, sub = 200_000, usage = fresh) => {
      const r = assessCoupon({ ...base, ...c }, cart(sub), usage, NOW);
      return r.ok ? 'ok' : `${r.reason}: ${r.message}`;
    };
    expect(msg({})).toBe('ok');
    expect(msg({ active: false })).toMatch(/^not_found/);
    expect(msg({ startsAt: NOW + 86_400_000 })).toMatch(
      /^not_started: Este cupón estará disponible desde el /,
    );
    expect(msg({ endsAt: NOW })).toBe('expired: Este cupón venció');
    expect(msg({ maxRedemptions: 5 }, 200_000, { total: 5, byUser: 0 })).toBe(
      'exhausted: Este cupón ya se agotó',
    );
    expect(msg({}, 200_000, { total: 1, byUser: 1 })).toBe('user_limit: Ya usaste este cupón');
    expect(msg({ perUserLimit: 3 }, 200_000, { total: 3, byUser: 3 })).toBe(
      'user_limit: Ya usaste este cupón el máximo de veces (3)',
    );
    expect(msg({}, 60_000)).toBe('below_minimum: Necesitas RD$ 400.00 más para usarlo');
  });

  it('envío gratis: sin zona todavía se acepta; si el envío ya es gratis, no sirve', () => {
    const free = {
      ...base,
      kind: 'free_delivery' as const,
      value: 0,
      minSubtotal: 0,
      maxDiscount: null,
    };
    expect(assessCoupon(free, cart(100_000, null), fresh, NOW)).toMatchObject({
      ok: true,
      deliveryWaived: 0,
    });
    expect(assessCoupon(free, cart(100_000, 15_000), fresh, NOW)).toMatchObject({
      ok: true,
      deliveryWaived: 15_000,
    });
    expect(assessCoupon(free, cart(500_000, 0), fresh, NOW)).toMatchObject({
      ok: false,
      reason: 'no_benefit',
    });
  });
});
