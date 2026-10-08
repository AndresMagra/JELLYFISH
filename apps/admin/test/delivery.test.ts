import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PIN_OVERRIDE_MIN_CHARS as SERVER_PIN_OVERRIDE_MIN_CHARS } from '../../api/src/services/delivery';
import {
  PIN_OVERRIDE_MAX_CHARS,
  PIN_OVERRIDE_MIN_CHARS,
  canOfferPinOverride,
  checkOverrideReason,
  overrideCounterText,
  pinAttemptsText,
  pinRequiredText,
  pinVerifiedText,
} from '../src/lib/delivery';

describe('motivo para entregar sin PIN', () => {
  it('el mínimo es el del servidor (importado de él)', () => {
    expect(PIN_OVERRIDE_MIN_CHARS).toBe(SERVER_PIN_OVERRIDE_MIN_CHARS);
    const n = SERVER_PIN_OVERRIDE_MIN_CHARS;
    expect(checkOverrideReason('x'.repeat(n - 1)).valid).toBe(false);
    expect(checkOverrideReason('x'.repeat(n)).valid).toBe(true);
  });
  it('el máximo es el del esquema de la ruta del servidor', () => {
    // El servidor lo tiene solo como literal dentro de routes/admin.ts (sin constante exportada):
    // se lee de ahí para que un cambio allá rompa esta prueba y no se quede desfasado el panel.
    const route = readFileSync(new URL('../../api/src/routes/admin.ts', import.meta.url), 'utf8');
    const max = /pinOverrideReason:\s*z\.string\(\)\.max\((\d+)\)/.exec(route)?.[1];
    expect(max, 'no se encontró pinOverrideReason en routes/admin.ts').toBeDefined();
    expect(PIN_OVERRIDE_MAX_CHARS).toBe(Number(max));
  });
  it('cuenta después de recortar los espacios', () => {
    const c = checkOverrideReason('   corto   ');
    expect(c.reason).toBe('corto');
    expect(c.length).toBe(5);
    expect(c.missing).toBe(3);
    expect(c.valid).toBe(false);
  });
  it('8 caracteres justos valen; 7 no', () => {
    expect(checkOverrideReason('1234567').valid).toBe(false);
    expect(checkOverrideReason('12345678').valid).toBe(true);
    expect(checkOverrideReason('12345678').missing).toBe(0);
  });
  it('solo espacios o vacío no vale', () => {
    expect(checkOverrideReason('').valid).toBe(false);
    expect(checkOverrideReason('         ').valid).toBe(false);
    expect(checkOverrideReason('         ').length).toBe(0);
  });
  it('los espacios de adentro sí cuentan, igual que en el servidor', () => {
    expect(checkOverrideReason('a      b').valid).toBe(true); // 8 caracteres
  });
  it('300 vale; 301 no', () => {
    expect(checkOverrideReason('x'.repeat(300)).valid).toBe(true);
    expect(checkOverrideReason('x'.repeat(301)).valid).toBe(false);
  });
  it('el contador dice cuánto falta, y luego cuánto lleva', () => {
    expect(overrideCounterText('')).toBe('0 de 8 caracteres como mínimo (faltan 8)');
    expect(overrideCounterText(' abc ')).toBe('3 de 8 caracteres como mínimo (faltan 5)');
    expect(overrideCounterText('no estaba')).toBe('9 / 300 caracteres');
    expect(overrideCounterText('x'.repeat(301))).toMatch(/demasiado largo/);
  });
});

describe('¿se ofrece "Entregar sin PIN"?', () => {
  const base = {
    pinRequired: true,
    pinVerifiedAt: null,
    next: ['delivered', 'delivery_failed'],
  } as const;
  const offer = (o: Partial<Parameters<typeof canOfferPinOverride>[0]>, role = 'admin') =>
    canOfferPinOverride({ ...base, next: [...base.next], ...o }, role);

  it('sí: exige PIN, sin verificar y se puede entregar', () => {
    expect(offer({})).toBe(true);
  });
  it('personal y administrador; nadie más', () => {
    expect(offer({}, 'staff')).toBe(true);
    expect(offer({}, 'driver')).toBe(false);
    expect(offer({}, 'customer')).toBe(false);
    expect(canOfferPinOverride({ ...base, next: [...base.next] }, undefined)).toBe(false);
  });
  it('no: el pedido no exige PIN (flujo normal)', () => {
    expect(offer({ pinRequired: false })).toBe(false);
  });
  it('no: ya se verificó el PIN', () => {
    expect(offer({ pinVerifiedAt: '2026-10-08T15:00:00.000Z' })).toBe(false);
  });
  it('no: "entregado" no está entre los pasos siguientes', () => {
    expect(offer({ next: ['out_for_delivery', 'cancelled'] })).toBe(false);
    expect(offer({ next: [] })).toBe(false);
  });
});

describe('tarjeta de entrega', () => {
  it('exige PIN: Sí o No', () => {
    expect(pinRequiredText(true)).toBe('Sí');
    expect(pinRequiredText(false)).toBe('No');
  });
  it('intentos: null no aplica, 0 bloqueado, 1 en singular', () => {
    expect(pinAttemptsText(null)).toBe('No aplica');
    expect(pinAttemptsText(0)).toBe('Bloqueado');
    expect(pinAttemptsText(-1)).toBe('Bloqueado');
    expect(pinAttemptsText(1)).toBe('1 intento');
    expect(pinAttemptsText(5)).toBe('5 intentos');
  });
  it('verificación: sin PIN, verificado, sin verificar o entregado con motivo', () => {
    const o = { pinRequired: true, pinVerifiedAt: null, pinOverrideReason: null };
    expect(pinVerifiedText({ ...o, pinRequired: false })).toBe('No aplica');
    expect(pinVerifiedText(o)).toBe('Aún sin verificar');
    expect(pinVerifiedText({ ...o, pinOverrideReason: 'el cliente no estaba' })).toBe(
      'No verificado: se entregó sin PIN',
    );
    // 15:20 UTC = 11:20 a. m. en RD (UTC-4)
    expect(pinVerifiedText({ ...o, pinVerifiedAt: '2026-10-08T15:20:00.000Z' })).toBe(
      'Verificado el 8 oct, 11:20 a. m.',
    );
  });
});
