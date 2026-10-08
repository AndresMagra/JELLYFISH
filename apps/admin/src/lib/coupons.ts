import type {
  CouponDTO,
  CouponInput,
  CouponKind,
  CouponPatch,
  CouponStatus,
} from '@jellyfish/shared';
import type { Tone } from '../components/ui';
import { centavosToPesos, dateTime, formatDOP, pesosToCentavos } from './format';

// Mismas reglas que apps/api/src/services/coupons.ts: el servidor siempre tiene la última palabra,
// pero así el administrador ve el error antes de enviar.

const RD_OFFSET_MS = -4 * 3_600_000; // RD: UTC-4 todo el año
const INT4_MAX = 2_147_483_647;
const MAX_PER_USER = 1000;
export const MAX_DESCRIPTION = 140;
export const COUPON_CODE_PATTERN = /^[A-Z0-9-]{3,20}$/;

/** Igual que el servidor: sin espacios (ni invisibles), guiones largos como guion y en mayúsculas. */
export function normalizeCouponCode(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s​-‍⁠﻿]+/gu, '')
    .replace(/[‐-―−]/gu, '-')
    .toUpperCase();
}

// ───────────── Textos ─────────────

export const KIND_LABEL: Record<CouponKind, string> = {
  percent: 'Porcentaje (%)',
  fixed: 'Monto fijo (RD$)',
  free_delivery: 'Envío gratis',
};

export const STATUS_LABEL: Record<CouponStatus, string> = {
  active: 'Activo',
  paused: 'Pausado',
  scheduled: 'Programado',
  expired: 'Vencido',
  exhausted: 'Agotado',
};

export const STATUS_TONE: Record<CouponStatus, Tone> = {
  active: 'success',
  scheduled: 'info',
  paused: 'neutral',
  expired: 'danger',
  exhausted: 'warning',
};

/** Lo que recibe el cliente: "10 %", "RD$ 150.00" o "Envío gratis". */
export function couponValueText(c: Pick<CouponDTO, 'kind' | 'value'>): string {
  if (c.kind === 'free_delivery') return 'Envío gratis';
  if (c.kind === 'fixed') return formatDOP(c.value);
  return `${c.value / 100} %`;
}

/** "3 de 50" o "3 · sin límite". */
export function couponUsageText(c: Pick<CouponDTO, 'redemptions' | 'maxRedemptions'>): string {
  return c.maxRedemptions === null
    ? `${c.redemptions} · sin límite`
    : `${c.redemptions} de ${c.maxRedemptions}`;
}

export const couponPerUserText = (n: number) => `${n} ${n === 1 ? 'uso' : 'usos'} por persona`;

/** "15 oct 2026, 8:30 a. m." en hora de RD (format.ts no muestra el año; aquí importa). */
export function rdStamp(iso: string): string {
  const year = new Date(new Date(iso).getTime() + RD_OFFSET_MS).getUTCFullYear();
  return dateTime(iso).replace(',', ` ${year},`);
}

/** Una línea por extremo; `endsAt` es exclusivo: en ese instante el cupón ya venció. */
export function couponWindowLines(c: Pick<CouponDTO, 'startsAt' | 'endsAt'>): string[] {
  const lines: string[] = [];
  if (c.startsAt) lines.push(`Desde ${rdStamp(c.startsAt)}`);
  if (c.endsAt) lines.push(`Hasta ${rdStamp(c.endsAt)}`);
  return lines.length > 0 ? lines : ['Sin límite de fechas'];
}

// ───────────── Fechas en hora RD ─────────────

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Lo que entrega un <input type="datetime-local"> ("2026-10-15T08:30") es una hora de pared sin
 * zona: aquí se lee SIEMPRE como hora de RD, sin importar la zona del navegador. Devuelve ISO UTC
 * ("2026-10-15T12:30:00.000Z") o null si no es una fecha que exista (31 de febrero, hora 25…).
 */
export function rdLocalToIso(local: string): string | null {
  const m = LOCAL_DATETIME.exec(local.trim());
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const [y, mo, d, h, mi, s] = [n(1), n(2), n(3), n(4), n(5), n(6)] as const;
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Date.UTC reacomoda lo imposible (31 feb → 3 mar); si algo se movió, la fecha no existía.
  const exact =
    wall.getUTCFullYear() === y &&
    wall.getUTCMonth() === mo - 1 &&
    wall.getUTCDate() === d &&
    wall.getUTCHours() === h &&
    wall.getUTCMinutes() === mi &&
    wall.getUTCSeconds() === s;
  return exact ? new Date(wall.getTime() - RD_OFFSET_MS).toISOString() : null;
}

/** ISO con zona → "2026-10-15T08:30" en hora de RD, para llenar el campo al editar. */
export function isoToRdLocal(iso: string): string {
  const d = new Date(new Date(iso).getTime() + RD_OFFSET_MS);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// ───────────── Formulario → CouponInput ─────────────

/** Todo en texto, tal como lo escribe la persona. */
export interface CouponForm {
  code: string;
  description: string;
  kind: CouponKind;
  /** percent: "12.5" (%); fixed: pesos ("150.00"); envío gratis: vacío. */
  value: string;
  /** Pesos; vacío = sin mínimo. */
  minSubtotal: string;
  /** Pesos; vacío = sin tope. */
  maxDiscount: string;
  /** datetime-local en hora de RD; vacío = sin fecha. */
  startsAt: string;
  endsAt: string;
  /** Vacío = ilimitado. */
  maxRedemptions: string;
  perUserLimit: string;
}

export type CouponFormErrors = Partial<Record<keyof CouponForm, string>>;

export const EMPTY_COUPON_FORM: CouponForm = {
  code: '',
  description: '',
  kind: 'percent',
  value: '',
  minSubtotal: '',
  maxDiscount: '',
  startsAt: '',
  endsAt: '',
  maxRedemptions: '',
  perUserLimit: '1',
};

/** Para editar: lo que ya tiene el cupón, expresado como lo escribiría una persona. */
export function couponToForm(c: CouponDTO): CouponForm {
  return {
    code: c.code,
    description: c.description,
    kind: c.kind,
    value:
      c.kind === 'percent'
        ? String(c.value / 100)
        : c.kind === 'fixed'
          ? centavosToPesos(c.value)
          : '',
    minSubtotal: c.minSubtotal > 0 ? centavosToPesos(c.minSubtotal) : '',
    maxDiscount: c.maxDiscount !== null ? centavosToPesos(c.maxDiscount) : '',
    startsAt: c.startsAt ? isoToRdLocal(c.startsAt) : '',
    endsAt: c.endsAt ? isoToRdLocal(c.endsAt) : '',
    maxRedemptions: c.maxRedemptions !== null ? String(c.maxRedemptions) : '',
    perUserLimit: String(c.perUserLimit),
  };
}

/** "10" | "12,5" | "10 %" → puntos básicos (1000 | 1250 | 1000); null si no es un porcentaje. */
export function percentToBps(text: string): number | null {
  const t = text.trim().replace(/\s*%$/, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

const CODE_ERROR = 'El código debe tener de 3 a 20 caracteres: letras A-Z, números o guion';
const AMOUNT_ERROR = 'Escribe un monto en pesos, por ejemplo 150 o 150.50';
const TOO_BIG = 'Ese monto es demasiado grande';

/** Pesos → centavos, o el texto del error. */
function amount(text: string): number | string {
  const cents = pesosToCentavos(text);
  if (cents === null) return AMOUNT_ERROR;
  return cents > INT4_MAX ? TOO_BIG : cents;
}

const wholeNumber = (text: string): number | null =>
  /^\d{1,10}$/.test(text.trim()) ? Number(text.trim()) : null;

export type CouponInputResult =
  { ok: true; input: CouponInput } | { ok: false; errors: CouponFormErrors };

/** Valida el formulario y arma el cuerpo de POST /v1/admin/coupons (dinero en centavos, fechas ISO). */
export function couponFormToInput(form: CouponForm): CouponInputResult {
  const errors: CouponFormErrors = {};

  const code = normalizeCouponCode(form.code);
  if (!COUPON_CODE_PATTERN.test(code)) errors.code = CODE_ERROR;

  const description = form.description.trim();
  if (description.length > MAX_DESCRIPTION) {
    errors.description = `La descripción admite hasta ${MAX_DESCRIPTION} caracteres`;
  }

  let value = 0;
  if (form.kind === 'percent') {
    const bps = percentToBps(form.value);
    if (bps === null) errors.value = 'Escribe un porcentaje, por ejemplo 10 o 12.5';
    else if (bps < 1 || bps > 10_000) {
      errors.value = 'El porcentaje debe ser mayor que 0 y no pasar de 100 %';
    } else value = bps;
  } else if (form.kind === 'fixed') {
    const cents = amount(form.value);
    if (typeof cents === 'string') errors.value = cents;
    else if (cents < 1) errors.value = 'El descuento fijo debe ser mayor que cero';
    else value = cents;
  } else if (form.value.trim() !== '') {
    errors.value = 'El envío gratis no lleva valor';
  }

  let minSubtotal = 0;
  if (form.minSubtotal.trim() !== '') {
    const cents = amount(form.minSubtotal);
    if (typeof cents === 'string') errors.minSubtotal = cents;
    else minSubtotal = cents;
  }

  let maxDiscount: number | null = null;
  if (form.maxDiscount.trim() !== '') {
    if (form.kind === 'free_delivery') {
      errors.maxDiscount = 'El envío gratis no lleva tope de descuento';
    } else {
      const cents = amount(form.maxDiscount);
      if (typeof cents === 'string') errors.maxDiscount = cents;
      else if (cents < 1) {
        errors.maxDiscount = 'El tope debe ser mayor que cero (déjalo vacío si no quieres tope)';
      } else maxDiscount = cents;
    }
  }

  const date = (field: 'startsAt' | 'endsAt'): string | null => {
    if (form[field].trim() === '') return null;
    const iso = rdLocalToIso(form[field]);
    if (iso === null) errors[field] = 'Fecha u hora inválida';
    return iso;
  };
  const startsAt = date('startsAt');
  const endsAt = date('endsAt');
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
    errors.endsAt = 'La fecha de fin debe ser posterior a la de inicio';
  }

  let maxRedemptions: number | null = null;
  if (form.maxRedemptions.trim() !== '') {
    const n = wholeNumber(form.maxRedemptions);
    if (n === null) errors.maxRedemptions = 'Escribe un número entero';
    else if (n < 1 || n > INT4_MAX) errors.maxRedemptions = 'El máximo de usos debe ser 1 o más';
    else maxRedemptions = n;
  }

  let perUserLimit = 1;
  const perUser = wholeNumber(form.perUserLimit);
  if (perUser === null) errors.perUserLimit = 'Escribe cuántas veces puede usarlo cada persona';
  else if (perUser < 1 || perUser > MAX_PER_USER) {
    errors.perUserLimit = `El límite por persona va de 1 a ${MAX_PER_USER}`;
  } else perUserLimit = perUser;

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      code,
      description,
      kind: form.kind,
      value,
      minSubtotal,
      maxDiscount,
      startsAt,
      endsAt,
      maxRedemptions,
      perUserLimit,
    },
  };
}

export const LOCKED_MESSAGE =
  'Este cupón ya tiene usos: no se puede cambiar. Crea otro cupón para otros valores.';

export type CouponPatchResult =
  { ok: true; patch: CouponPatch } | { ok: false; errors: CouponFormErrors };

/** Dos instantes iguales al minuto: el formulario no edita segundos, así que no los compara. */
const sameMoment = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : isoToRdLocal(a) === isoToRdLocal(b);

/**
 * Cuerpo de PATCH /v1/admin/coupons/:id: solo lo que cambió respecto al cupón tal como se abrió.
 * Con usos (`termsLocked`) el tipo, el valor y el tope no pueden cambiar. `patch` vacío = nada que guardar.
 */
export function couponFormToPatch(form: CouponForm, coupon: CouponDTO): CouponPatchResult {
  const result = couponFormToInput({ ...form, code: coupon.code });
  if (!result.ok) return result;
  const { input } = result;

  const patch: CouponPatch = {};
  if (input.description !== coupon.description) patch.description = input.description;
  if (input.kind !== coupon.kind) patch.kind = input.kind;
  if (input.value !== coupon.value) patch.value = input.value;
  if (input.minSubtotal !== coupon.minSubtotal) patch.minSubtotal = input.minSubtotal;
  if (input.maxDiscount !== coupon.maxDiscount) patch.maxDiscount = input.maxDiscount;
  if (!sameMoment(input.startsAt ?? null, coupon.startsAt)) patch.startsAt = input.startsAt;
  if (!sameMoment(input.endsAt ?? null, coupon.endsAt)) patch.endsAt = input.endsAt;
  if (input.maxRedemptions !== coupon.maxRedemptions) patch.maxRedemptions = input.maxRedemptions;
  if (input.perUserLimit !== coupon.perUserLimit) patch.perUserLimit = input.perUserLimit;

  if (coupon.termsLocked) {
    const errors: CouponFormErrors = {};
    if (patch.kind !== undefined) errors.kind = LOCKED_MESSAGE;
    if (patch.value !== undefined) errors.value = LOCKED_MESSAGE;
    if (patch.maxDiscount !== undefined) errors.maxDiscount = LOCKED_MESSAGE;
    if (Object.keys(errors).length > 0) return { ok: false, errors };
  }
  return { ok: true, patch };
}
