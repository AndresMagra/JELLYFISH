import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseSpeed } from '../src/shortcuts';
import { formatOrderNumber, mulberry32, normalizeText, randomUuid, stableUuid } from '../src/util';
import { normalizeText as apiNormalizeText } from '../../../apps/api/src/text';
import { formatOrderNumber as apiFormatOrderNumber } from '../../../apps/api/src/text';

describe('utilidades', () => {
  it('stableUuid y randomUuid dan UUID válidos para zod (el API los valida igual)', () => {
    const uuid = z.string().uuid();
    for (const id of ['JF-MAR-001', 'JF-RES-099', 'zona', ''].map(stableUuid)) {
      expect(uuid.safeParse(id).success, id).toBe(true);
    }
    const rng = mulberry32(5);
    for (let i = 0; i < 500; i++) expect(uuid.safeParse(randomUuid(rng)).success).toBe(true);
    expect(stableUuid('variant:JF-MAR-001')).toBe(stableUuid('variant:JF-MAR-001'));
    expect(stableUuid('a')).not.toBe(stableUuid('b'));
  });

  it('mulberry32 es determinista', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('normalizeText y formatOrderNumber son idénticos a los del API real', () => {
    for (const s of [
      'Camarón 16/20',
      ' ÑANDÚ  ',
      'pechuga, deshuesada!',
      'Mejillón-media concha',
      '%_',
      '',
    ]) {
      expect(normalizeText(s)).toBe(apiNormalizeText(s));
    }
    for (const n of [1, 42, 123456]) expect(formatOrderNumber(n)).toBe(apiFormatOrderNumber(n));
  });

  it('?speed= solo acepta valores razonables', () => {
    expect(parseSpeed('?speed=3')).toBe(3);
    expect(parseSpeed('?a=1&speed=0.5')).toBe(0.5);
    for (const bad of ['', '?speed=0', '?speed=-2', '?speed=abc', '?speed=1000', undefined]) {
      expect(parseSpeed(bad)).toBe(1);
    }
  });
});
