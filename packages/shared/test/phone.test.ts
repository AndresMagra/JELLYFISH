import { describe, expect, it } from 'vitest';
import { formatDominicanPhone, normalizeDominicanPhone } from '../src';

describe('teléfonos dominicanos', () => {
  it.each([
    ['809-555-1234', '+18095551234'],
    ['(829) 555 1234', '+18295551234'],
    ['18495551234', '+18495551234'],
    ['+1 809 555 1234', '+18095551234'],
    ['8095551234', '+18095551234'],
  ])('normaliza %s', (input, expected) => {
    expect(normalizeDominicanPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '555-1234',
    '212-555-1234',
    '+34 600 123 456',
    '809-055-1234',
    '809-155-1234',
    'abc',
  ])('rechaza %s', (input) => {
    expect(normalizeDominicanPhone(input)).toBeNull();
  });

  it('formatea para mostrar', () => {
    expect(formatDominicanPhone('+18095551234')).toBe('(809) 555-1234');
  });
});
