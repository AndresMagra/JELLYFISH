import { describe, expect, it } from 'vitest';
import {
  LOCKED_MESSAGE,
  PIN_LENGTH,
  PIN_MAX_ATTEMPTS,
  attemptsText,
  classifyPinError,
  isCompletePin,
  sanitizePin,
} from '../src/pin';

/** Lo mismo que un ApiError de mobile-core: code, status, message, details. */
const apiError = (code: string, status: number, message: string, details?: unknown) =>
  Object.assign(new Error(message), { code, status, details });

describe('PIN de entrega: reglas', () => {
  it('son 4 dígitos y 5 intentos', () => {
    expect(PIN_LENGTH).toBe(4);
    expect(PIN_MAX_ATTEMPTS).toBe(5);
  });
  it('sanitizePin deja solo dígitos y corta a 4', () => {
    expect(sanitizePin('12a3')).toBe('123');
    expect(sanitizePin('12 34')).toBe('1234');
    expect(sanitizePin('1-2-3-4-5')).toBe('1234');
    expect(sanitizePin('abc')).toBe('');
    expect(sanitizePin('0042')).toBe('0042'); // conserva el cero inicial
  });
  it('isCompletePin exige exactamente 4 dígitos', () => {
    expect(isCompletePin('0000')).toBe(true);
    expect(isCompletePin('123')).toBe(false);
    expect(isCompletePin('12345')).toBe(false);
    expect(isCompletePin('12a4')).toBe(false);
    expect(isCompletePin('')).toBe(false);
  });
  it('attemptsText concuerda en singular y plural', () => {
    expect(attemptsText(1)).toBe('Te queda 1 intento.');
    expect(attemptsText(4)).toBe('Te quedan 4 intentos.');
    expect(attemptsText(2)).toBe('Te quedan 2 intentos.');
  });
});

describe('classifyPinError', () => {
  it('pin_incorrect muestra los intentos que quedan', () => {
    const f = classifyPinError(
      apiError('pin_incorrect', 409, 'PIN incorrecto. Te quedan 3 intentos.', { attemptsLeft: 3 }),
    );
    expect(f).toEqual({
      kind: 'incorrect',
      attemptsLeft: 3,
      lastChance: false,
      message: 'PIN incorrecto. Te quedan 3 intentos.',
    });
  });
  it('avisa cuando es el último intento', () => {
    const f = classifyPinError(apiError('pin_incorrect', 409, 'x', { attemptsLeft: 1 }));
    expect(f).toMatchObject({
      kind: 'incorrect',
      attemptsLeft: 1,
      lastChance: true,
      message: 'PIN incorrecto. Te queda 1 intento.',
    });
  });
  it('si el API no manda attemptsLeft usa el mensaje del servidor', () => {
    const f = classifyPinError(apiError('pin_incorrect', 409, 'PIN incorrecto.'));
    expect(f).toMatchObject({ kind: 'incorrect', attemptsLeft: null, message: 'PIN incorrecto.' });
  });
  it('attemptsLeft 0 o pin_locked (423) es bloqueo', () => {
    expect(classifyPinError(apiError('pin_locked', 423, 'x', { attemptsLeft: 0 }))).toEqual({
      kind: 'locked',
      message: LOCKED_MESSAGE,
    });
    expect(classifyPinError(apiError('pin_incorrect', 409, 'x', { attemptsLeft: 0 })).kind).toBe(
      'locked',
    );
    expect(classifyPinError({ status: 423 }).kind).toBe('locked');
  });
  it('cash_not_collected devuelve al paso de cobrar', () => {
    const f = classifyPinError(apiError('cash_not_collected', 409, 'Registra el cobro…'));
    expect(f.kind).toBe('cash_not_collected');
    expect(f.message).toContain('cobra el efectivo');
  });
  it('pin_required pide el PIN', () => {
    expect(classifyPinError(apiError('pin_required', 400, 'x')).kind).toBe('required');
  });
  it('lo demás conserva el mensaje del API o uno genérico', () => {
    expect(classifyPinError(apiError('network', 0, 'No pudimos conectarnos.'))).toEqual({
      kind: 'other',
      message: 'No pudimos conectarnos.',
    });
    expect(classifyPinError(undefined)).toEqual({
      kind: 'other',
      message: 'Algo salió mal. Intenta de nuevo.',
    });
    expect(classifyPinError('boom').kind).toBe('other');
  });
});
