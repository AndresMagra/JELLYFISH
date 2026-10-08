import type { CouponDTO } from '@jellyfish/shared';
import { formatDOP } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_COUPON_FORM,
  LOCKED_MESSAGE,
  STATUS_LABEL,
  STATUS_TONE,
  type CouponForm,
  couponFormToInput,
  couponFormToPatch,
  couponPerUserText,
  couponToForm,
  couponUsageText,
  couponValueText,
  couponWindowLines,
  isoToRdLocal,
  normalizeCouponCode,
  percentToBps,
  rdLocalToIso,
  rdStamp,
} from '../src/lib/coupons';

// Cifras inventadas: ningún dato real del negocio.
const form = (over: Partial<CouponForm> = {}): CouponForm => ({
  ...EMPTY_COUPON_FORM,
  code: 'VERANO10',
  kind: 'percent',
  value: '10',
  ...over,
});

const coupon = (over: Partial<CouponDTO> = {}): CouponDTO => ({
  id: '3f0c9a3e-0000-4000-8000-000000000001',
  code: 'VERANO10',
  description: '10 % en todo',
  kind: 'percent',
  value: 1000,
  minSubtotal: 50_000,
  maxDiscount: 20_000,
  startsAt: '2026-10-15T12:30:00.000Z',
  endsAt: '2026-11-01T03:59:00.000Z',
  maxRedemptions: 100,
  perUserLimit: 1,
  active: true,
  createdAt: '2026-10-01T15:00:00.000Z',
  redemptions: 0,
  discountTotal: 0,
  status: 'active',
  termsLocked: false,
  ...over,
});

function inputOf(f: CouponForm) {
  const r = couponFormToInput(f);
  if (!r.ok) throw new Error(`Se esperaba un formulario válido: ${JSON.stringify(r.errors)}`);
  return r.input;
}
const errorsOf = (f: CouponForm) => {
  const r = couponFormToInput(f);
  if (r.ok) throw new Error('Se esperaba un formulario inválido');
  return r.errors;
};
function patchOf(f: CouponForm, c: CouponDTO) {
  const r = couponFormToPatch(f, c);
  if (!r.ok) throw new Error(`Se esperaba un cambio válido: ${JSON.stringify(r.errors)}`);
  return r.patch;
}

describe('código del cupón', () => {
  it('se normaliza como en el servidor', () => {
    expect(normalizeCouponCode(' verano 10 ')).toBe('VERANO10');
    expect(normalizeCouponCode('mi​cupón')).toBe('MICUPÓN');
    expect(normalizeCouponCode('ahorro—10')).toBe('AHORRO-10'); // raya larga del teclado
    expect(normalizeCouponCode('ａｂｃ')).toBe('ABC'); // letras de ancho completo
  });

  it('acepta de 3 a 20 caracteres A-Z, 0-9 o guion', () => {
    expect(inputOf(form({ code: 'abc' })).code).toBe('ABC');
    expect(inputOf(form({ code: 'A'.repeat(20) })).code).toBe('A'.repeat(20));
    expect(inputOf(form({ code: 'pre-10' })).code).toBe('PRE-10');
  });

  it.each(['', 'ab', 'A'.repeat(21), 'ñandú', 'de_scuento', 'oferta!', '   '])(
    'rechaza %j',
    (code) => {
      expect(errorsOf(form({ code })).code).toMatch(/3 a 20 caracteres/);
    },
  );
});

describe('porcentaje', () => {
  it('convierte a puntos básicos', () => {
    expect(percentToBps('10')).toBe(1000);
    expect(percentToBps('12,5')).toBe(1250);
    expect(percentToBps('12.5')).toBe(1250);
    expect(percentToBps('10 %')).toBe(1000);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('1.15')).toBe(115); // 1.15 * 100 en coma flotante da 114.99999999999999
    expect(percentToBps('100')).toBe(10_000);
  });

  it.each(['', 'abc', '-5', '12.345', '1e2', '10%%', '1 0', '.5'])(
    '%j no es un porcentaje',
    (text) => {
      expect(percentToBps(text)).toBeNull();
    },
  );

  it('100 % es el máximo y se envía como 10000', () => {
    expect(inputOf(form({ value: '100' })).value).toBe(10_000);
  });

  it('0 % y más de 100 % se rechazan', () => {
    expect(errorsOf(form({ value: '0' })).value).toMatch(/mayor que 0/);
    expect(errorsOf(form({ value: '0.00' })).value).toMatch(/mayor que 0/);
    expect(errorsOf(form({ value: '100.01' })).value).toMatch(/100 %/);
    expect(errorsOf(form({ value: '150' })).value).toMatch(/100 %/);
  });

  it('el mínimo es 0.01 % (1 punto básico)', () => {
    expect(inputOf(form({ value: '0.01' })).value).toBe(1);
  });

  it('vacío o con letras pide un porcentaje', () => {
    expect(errorsOf(form({ value: '' })).value).toMatch(/porcentaje/);
    expect(errorsOf(form({ value: 'diez' })).value).toMatch(/porcentaje/);
  });
});

describe('monto fijo en pesos', () => {
  const fixed = (value: string, over: Partial<CouponForm> = {}) =>
    form({ kind: 'fixed', value, ...over });

  it('pasa de pesos a centavos enteros', () => {
    expect(inputOf(fixed('150')).value).toBe(15_000);
    expect(inputOf(fixed('150.5')).value).toBe(15_050);
    expect(inputOf(fixed('150.55')).value).toBe(15_055);
    expect(inputOf(fixed('1,234.50')).value).toBe(123_450);
    expect(inputOf(fixed('RD$ 90')).value).toBe(9_000);
    expect(inputOf(fixed('0.01')).value).toBe(1);
    expect(inputOf(fixed('174.95')).value).toBe(17_495); // sin error de coma flotante
  });

  it('rechaza cero, negativos, más de dos decimales y vacío', () => {
    expect(errorsOf(fixed('0')).value).toMatch(/mayor que cero/);
    expect(errorsOf(fixed('0.00')).value).toMatch(/mayor que cero/);
    expect(errorsOf(fixed('-10')).value).toMatch(/monto en pesos/);
    expect(errorsOf(fixed('10.999')).value).toMatch(/monto en pesos/);
    expect(errorsOf(fixed('')).value).toMatch(/monto en pesos/);
    expect(errorsOf(fixed('mucho')).value).toMatch(/monto en pesos/);
  });

  it('rechaza lo que no cabe en el entero de la base (2 147 483 647 centavos)', () => {
    expect(inputOf(fixed('21474836.47')).value).toBe(2_147_483_647);
    expect(errorsOf(fixed('21474836.48')).value).toMatch(/demasiado grande/);
    expect(errorsOf(fixed('99999999999999999999')).value).toMatch(/demasiado grande/);
  });
});

describe('envío gratis', () => {
  const free = (over: Partial<CouponForm> = {}) =>
    form({ kind: 'free_delivery', value: '', ...over });

  it('se envía con valor 0 y sin tope', () => {
    expect(inputOf(free())).toMatchObject({ kind: 'free_delivery', value: 0, maxDiscount: null });
  });

  it('con valor se rechaza', () => {
    expect(errorsOf(free({ value: '10' })).value).toBe('El envío gratis no lleva valor');
    expect(errorsOf(free({ value: '0' })).value).toBe('El envío gratis no lleva valor');
  });

  it('con tope se rechaza', () => {
    expect(errorsOf(free({ maxDiscount: '100' })).maxDiscount).toBe(
      'El envío gratis no lleva tope de descuento',
    );
  });

  it('puede llevar compra mínima', () => {
    expect(inputOf(free({ minSubtotal: '1500' })).minSubtotal).toBe(150_000);
  });
});

describe('mínimo y tope', () => {
  it('vacíos significan sin mínimo y sin tope', () => {
    const i = inputOf(form());
    expect(i.minSubtotal).toBe(0);
    expect(i.maxDiscount).toBeNull();
  });

  it('se convierten a centavos', () => {
    const i = inputOf(form({ minSubtotal: '500', maxDiscount: '200.50' }));
    expect(i.minSubtotal).toBe(50_000);
    expect(i.maxDiscount).toBe(20_050);
  });

  it('el tope no puede ser cero; el mínimo sí', () => {
    expect(errorsOf(form({ maxDiscount: '0' })).maxDiscount).toMatch(/mayor que cero/);
    expect(inputOf(form({ minSubtotal: '0' })).minSubtotal).toBe(0);
  });

  it('montos inválidos', () => {
    expect(errorsOf(form({ minSubtotal: 'abc' })).minSubtotal).toMatch(/monto en pesos/);
    expect(errorsOf(form({ maxDiscount: '1.234' })).maxDiscount).toMatch(/monto en pesos/);
  });
});

describe('fechas en hora de República Dominicana (UTC-4)', () => {
  it('rdLocalToIso suma 4 horas', () => {
    expect(rdLocalToIso('2026-10-15T08:30')).toBe('2026-10-15T12:30:00.000Z');
    expect(rdLocalToIso('2026-10-15T00:00')).toBe('2026-10-15T04:00:00.000Z');
    expect(rdLocalToIso('2026-10-15T08:30:15')).toBe('2026-10-15T12:30:15.000Z');
  });

  it('cruza de día, mes y año', () => {
    expect(rdLocalToIso('2026-10-15T23:59')).toBe('2026-10-16T03:59:00.000Z');
    expect(rdLocalToIso('2026-10-31T22:00')).toBe('2026-11-01T02:00:00.000Z');
    expect(rdLocalToIso('2026-12-31T23:30')).toBe('2027-01-01T03:30:00.000Z');
  });

  it('no depende de la zona del navegador ni de un horario de verano', () => {
    // RD no cambia la hora: enero y julio llevan el mismo desfase.
    expect(rdLocalToIso('2026-01-15T12:00')).toBe('2026-01-15T16:00:00.000Z');
    expect(rdLocalToIso('2026-07-15T12:00')).toBe('2026-07-15T16:00:00.000Z');
  });

  it('rechaza fechas que no existen', () => {
    expect(rdLocalToIso('2026-02-30T10:00')).toBeNull();
    expect(rdLocalToIso('2026-02-29T10:00')).toBeNull(); // 2026 no es bisiesto
    expect(rdLocalToIso('2026-13-01T10:00')).toBeNull();
    expect(rdLocalToIso('2026-10-15T24:00')).toBeNull();
    expect(rdLocalToIso('2026-10-15T10:60')).toBeNull();
    expect(rdLocalToIso('2026-10-15T10:00:60')).toBeNull();
  });

  it('acepta el 29 de febrero de un año bisiesto', () => {
    expect(rdLocalToIso('2028-02-29T00:00')).toBe('2028-02-29T04:00:00.000Z');
  });

  it('rechaza lo que no es fecha y hora', () => {
    for (const bad of ['', 'ayer', '2026-10-15', '15/10/2026 08:30', '0050-10-15T08:30']) {
      expect(rdLocalToIso(bad), bad).toBeNull();
    }
  });

  it('isoToRdLocal es la operación inversa', () => {
    expect(isoToRdLocal('2026-10-15T12:30:00.000Z')).toBe('2026-10-15T08:30');
    expect(isoToRdLocal('2026-10-16T03:59:00Z')).toBe('2026-10-15T23:59');
    expect(isoToRdLocal('2026-01-01T02:00:00Z')).toBe('2025-12-31T22:00');
    for (const local of ['2026-10-15T08:30', '2026-12-31T23:59', '2026-01-01T00:00']) {
      expect(isoToRdLocal(rdLocalToIso(local)!)).toBe(local);
    }
  });

  it('rdStamp muestra día, mes, año y hora de RD', () => {
    expect(rdStamp('2026-10-15T12:30:00.000Z')).toBe('15 oct 2026, 8:30 a. m.');
    expect(rdStamp('2026-10-15T04:00:00.000Z')).toBe('15 oct 2026, 12:00 a. m.');
    expect(rdStamp('2026-10-15T16:00:00.000Z')).toBe('15 oct 2026, 12:00 p. m.');
    expect(rdStamp('2026-01-01T02:00:00.000Z')).toBe('31 dic 2025, 10:00 p. m.');
  });

  it('el formulario envía ISO con zona', () => {
    const i = inputOf(form({ startsAt: '2026-10-15T08:30', endsAt: '2026-10-31T23:59' }));
    expect(i.startsAt).toBe('2026-10-15T12:30:00.000Z');
    expect(i.endsAt).toBe('2026-11-01T03:59:00.000Z');
    expect(i.startsAt).toMatch(/Z$/);
  });

  it('las fechas vacías son null', () => {
    const i = inputOf(form());
    expect(i.startsAt).toBeNull();
    expect(i.endsAt).toBeNull();
  });

  it('solo inicio o solo fin es válido', () => {
    expect(inputOf(form({ startsAt: '2026-10-15T08:30' })).endsAt).toBeNull();
    expect(inputOf(form({ endsAt: '2026-10-15T08:30' })).startsAt).toBeNull();
  });

  it('el fin debe ser posterior al inicio', () => {
    const msg = 'La fecha de fin debe ser posterior a la de inicio';
    expect(
      errorsOf(form({ startsAt: '2026-10-15T08:30', endsAt: '2026-10-15T08:30' })).endsAt,
    ).toBe(msg);
    expect(
      errorsOf(form({ startsAt: '2026-10-15T08:30', endsAt: '2026-10-14T08:30' })).endsAt,
    ).toBe(msg);
    expect(
      inputOf(form({ startsAt: '2026-10-15T08:30', endsAt: '2026-10-15T08:31' })).endsAt,
    ).not.toBeNull();
  });

  it('una fecha inválida marca el campo', () => {
    expect(errorsOf(form({ startsAt: '2026-02-30T10:00' })).startsAt).toBe('Fecha u hora inválida');
    expect(errorsOf(form({ endsAt: 'mañana' })).endsAt).toBe('Fecha u hora inválida');
  });
});

describe('usos', () => {
  it('máximo de usos: vacío es ilimitado', () => {
    expect(inputOf(form({ maxRedemptions: '' })).maxRedemptions).toBeNull();
    expect(inputOf(form({ maxRedemptions: '50' })).maxRedemptions).toBe(50);
    expect(inputOf(form({ maxRedemptions: '1' })).maxRedemptions).toBe(1);
  });

  it.each(['0', '-3', '5.5', 'cien', '99999999999'])('máximo de usos %j se rechaza', (v) => {
    expect(errorsOf(form({ maxRedemptions: v })).maxRedemptions).toBeTruthy();
  });

  it('límite por persona: de 1 a 1000, obligatorio', () => {
    expect(inputOf(form({ perUserLimit: '1' })).perUserLimit).toBe(1);
    expect(inputOf(form({ perUserLimit: '1000' })).perUserLimit).toBe(1000);
    expect(errorsOf(form({ perUserLimit: '0' })).perUserLimit).toMatch(/1 a 1000/);
    expect(errorsOf(form({ perUserLimit: '1001' })).perUserLimit).toMatch(/1 a 1000/);
    expect(errorsOf(form({ perUserLimit: '' })).perUserLimit).toBeTruthy();
    expect(errorsOf(form({ perUserLimit: '1.5' })).perUserLimit).toBeTruthy();
  });

  it('el formulario vacío arranca con límite por persona 1', () => {
    expect(EMPTY_COUPON_FORM.perUserLimit).toBe('1');
  });
});

describe('descripción', () => {
  it('se recorta y admite hasta 140 caracteres', () => {
    expect(inputOf(form({ description: '  Verano  ' })).description).toBe('Verano');
    expect(inputOf(form({ description: 'a'.repeat(140) })).description).toHaveLength(140);
    expect(errorsOf(form({ description: 'a'.repeat(141) })).description).toMatch(/140/);
  });
});

describe('cuerpo completo', () => {
  it('arma el CouponInput que espera el servidor', () => {
    const input = inputOf({
      code: ' verano-10 ',
      description: '10 % en todo',
      kind: 'percent',
      value: '10',
      minSubtotal: '500',
      maxDiscount: '200',
      startsAt: '2026-10-15T08:30',
      endsAt: '2026-10-31T23:59',
      maxRedemptions: '100',
      perUserLimit: '2',
    });
    expect(input).toEqual({
      code: 'VERANO-10',
      description: '10 % en todo',
      kind: 'percent',
      value: 1000,
      minSubtotal: 50_000,
      maxDiscount: 20_000,
      startsAt: '2026-10-15T12:30:00.000Z',
      endsAt: '2026-11-01T03:59:00.000Z',
      maxRedemptions: 100,
      perUserLimit: 2,
    });
    // Solo enteros y textos: viaja tal cual en JSON.
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });

  it('junta todos los errores a la vez', () => {
    const errors = errorsOf(
      form({ code: 'x', value: '0', minSubtotal: 'zz', perUserLimit: '0', maxRedemptions: '0' }),
    );
    expect(Object.keys(errors).sort()).toEqual([
      'code',
      'maxRedemptions',
      'minSubtotal',
      'perUserLimit',
      'value',
    ]);
  });

  it('un formulario vacío solo falla en código y valor', () => {
    expect(Object.keys(errorsOf(EMPTY_COUPON_FORM)).sort()).toEqual(['code', 'value']);
  });
});

describe('textos de la tabla', () => {
  it('valor legible por tipo', () => {
    expect(couponValueText({ kind: 'percent', value: 1000 })).toBe('10 %');
    expect(couponValueText({ kind: 'percent', value: 1250 })).toBe('12.5 %');
    expect(couponValueText({ kind: 'percent', value: 10_000 })).toBe('100 %');
    expect(couponValueText({ kind: 'percent', value: 1 })).toBe('0.01 %');
    expect(couponValueText({ kind: 'fixed', value: 15_000 })).toBe(formatDOP(15_000));
    expect(couponValueText({ kind: 'fixed', value: 15_000 })).toContain('150.00');
    expect(couponValueText({ kind: 'free_delivery', value: 0 })).toBe('Envío gratis');
  });

  it('estados en español con un tono distinto para lo que pide atención', () => {
    expect(STATUS_LABEL).toEqual({
      active: 'Activo',
      paused: 'Pausado',
      scheduled: 'Programado',
      expired: 'Vencido',
      exhausted: 'Agotado',
    });
    expect(STATUS_TONE.active).toBe('success');
    expect(STATUS_TONE.paused).toBe('neutral');
    expect(Object.keys(STATUS_TONE).sort()).toEqual(Object.keys(STATUS_LABEL).sort());
  });

  it('usos', () => {
    expect(couponUsageText({ redemptions: 3, maxRedemptions: 50 })).toBe('3 de 50');
    expect(couponUsageText({ redemptions: 0, maxRedemptions: null })).toBe('0 · sin límite');
  });

  it('límite por persona concuerda en singular y plural', () => {
    expect(couponPerUserText(1)).toBe('1 uso por persona');
    expect(couponPerUserText(3)).toBe('3 usos por persona');
  });

  it('ventana de fechas', () => {
    expect(couponWindowLines({ startsAt: null, endsAt: null })).toEqual(['Sin límite de fechas']);
    expect(couponWindowLines({ startsAt: '2026-10-15T12:30:00.000Z', endsAt: null })).toEqual([
      'Desde 15 oct 2026, 8:30 a. m.',
    ]);
    expect(couponWindowLines({ startsAt: null, endsAt: '2026-11-01T03:59:00.000Z' })).toEqual([
      'Hasta 31 oct 2026, 11:59 p. m.',
    ]);
    expect(
      couponWindowLines({
        startsAt: '2026-10-15T12:30:00.000Z',
        endsAt: '2026-11-01T03:59:00.000Z',
      }),
    ).toEqual(['Desde 15 oct 2026, 8:30 a. m.', 'Hasta 31 oct 2026, 11:59 p. m.']);
  });
});

describe('editar un cupón', () => {
  it('couponToForm devuelve lo que una persona escribiría', () => {
    expect(couponToForm(coupon())).toEqual({
      code: 'VERANO10',
      description: '10 % en todo',
      kind: 'percent',
      value: '10',
      minSubtotal: '500.00',
      maxDiscount: '200.00',
      startsAt: '2026-10-15T08:30',
      endsAt: '2026-10-31T23:59',
      maxRedemptions: '100',
      perUserLimit: '1',
    });
    expect(couponToForm(coupon({ value: 1250 })).value).toBe('12.5');
    expect(couponToForm(coupon({ kind: 'fixed', value: 15_050 })).value).toBe('150.50');
    expect(couponToForm(coupon({ kind: 'free_delivery', value: 0, maxDiscount: null })).value).toBe(
      '',
    );
    const open = couponToForm(
      coupon({
        minSubtotal: 0,
        maxDiscount: null,
        startsAt: null,
        endsAt: null,
        maxRedemptions: null,
      }),
    );
    expect(open).toMatchObject({
      minSubtotal: '',
      maxDiscount: '',
      startsAt: '',
      endsAt: '',
      maxRedemptions: '',
    });
  });

  it('el cupón tal cual se abrió no genera cambios', () => {
    for (const c of [
      coupon(),
      coupon({ kind: 'fixed', value: 15_050, maxDiscount: null }),
      coupon({ kind: 'free_delivery', value: 0, maxDiscount: null }),
      coupon({ minSubtotal: 0, startsAt: null, endsAt: null, maxRedemptions: null }),
    ]) {
      expect(patchOf(couponToForm(c), c)).toEqual({});
    }
  });

  it('los segundos de una fecha guardada por la API no cuentan como cambio', () => {
    const c = coupon({ startsAt: '2026-10-15T12:30:20.000Z' });
    expect(patchOf(couponToForm(c), c)).toEqual({});
  });

  it('envía solo lo que cambió', () => {
    const c = coupon();
    expect(patchOf({ ...couponToForm(c), description: 'Otro texto' }, c)).toEqual({
      description: 'Otro texto',
    });
    expect(patchOf({ ...couponToForm(c), value: '15' }, c)).toEqual({ value: 1500 });
    expect(patchOf({ ...couponToForm(c), perUserLimit: '3', minSubtotal: '600' }, c)).toEqual({
      perUserLimit: 3,
      minSubtotal: 60_000,
    });
    expect(patchOf({ ...couponToForm(c), endsAt: '2026-11-05T12:00' }, c)).toEqual({
      endsAt: '2026-11-05T16:00:00.000Z',
    });
  });

  it('vaciar un campo opcional lo manda como null', () => {
    const c = coupon();
    expect(
      patchOf(
        { ...couponToForm(c), startsAt: '', endsAt: '', maxRedemptions: '', maxDiscount: '' },
        c,
      ),
    ).toEqual({ startsAt: null, endsAt: null, maxRedemptions: null, maxDiscount: null });
    expect(patchOf({ ...couponToForm(c), minSubtotal: '' }, c)).toEqual({ minSubtotal: 0 });
  });

  it('cambiar a envío gratis pone valor 0 y sin tope', () => {
    const c = coupon();
    expect(
      patchOf({ ...couponToForm(c), kind: 'free_delivery', value: '', maxDiscount: '' }, c),
    ).toEqual({ kind: 'free_delivery', value: 0, maxDiscount: null });
  });

  it('ignora el código del formulario y nunca manda `code` ni `active`', () => {
    const c = coupon();
    const patch = patchOf({ ...couponToForm(c), code: 'OTRO', description: 'x' }, c);
    expect(patch).toEqual({ description: 'x' });
    expect(patch).not.toHaveProperty('code');
    expect(patch).not.toHaveProperty('active');
  });

  it('un formulario inválido devuelve sus errores', () => {
    const c = coupon();
    const r = couponFormToPatch({ ...couponToForm(c), value: '0', perUserLimit: '' }, c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['perUserLimit', 'value']);
  });

  describe('con usos (termsLocked)', () => {
    const locked = coupon({ redemptions: 4, discountTotal: 80_000, termsLocked: true });

    it('permite cambiar descripción, mínimo, fechas, usos y límite por persona', () => {
      const f = {
        ...couponToForm(locked),
        description: 'Nueva',
        minSubtotal: '700',
        endsAt: '2026-12-01T00:00',
        maxRedemptions: '200',
        perUserLimit: '2',
      };
      expect(patchOf(f, locked)).toEqual({
        description: 'Nueva',
        minSubtotal: 70_000,
        endsAt: '2026-12-01T04:00:00.000Z',
        maxRedemptions: 200,
        perUserLimit: 2,
      });
    });

    it('rechaza cambiar el valor, el tipo o el tope', () => {
      const base = couponToForm(locked);
      const value = couponFormToPatch({ ...base, value: '20' }, locked);
      expect(value).toEqual({ ok: false, errors: { value: LOCKED_MESSAGE } });

      const kind = couponFormToPatch({ ...base, kind: 'fixed', value: '100' }, locked);
      expect(kind.ok).toBe(false);
      if (!kind.ok)
        expect(kind.errors).toMatchObject({ kind: LOCKED_MESSAGE, value: LOCKED_MESSAGE });

      const cap = couponFormToPatch({ ...base, maxDiscount: '999' }, locked);
      expect(cap).toEqual({ ok: false, errors: { maxDiscount: LOCKED_MESSAGE } });
    });

    it('sin cambios en lo bloqueado, escribirlo igual no es un cambio', () => {
      expect(
        patchOf({ ...couponToForm(locked), value: '10.0', maxDiscount: '200' }, locked),
      ).toEqual({});
    });
  });
});
