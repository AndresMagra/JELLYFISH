import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type World, makeWorld } from './helpers';
import { deliveryPricing, findZone, listSlots } from '../src/services/zones';

describe('franjas de entrega (hora de RD, UTC-4)', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('a las 10:00 en RD la primera franja es 12:00–14:00 (anticipación de 90 min)', async () => {
    const slots = await listSlots(w.handle.db, w.config, new Date('2026-10-07T14:00:00Z'));
    expect(slots[0]!.start.toISOString()).toBe('2026-10-07T16:00:00.000Z'); // 12:00 RD
    expect(slots[0]!.end.toISOString()).toBe('2026-10-07T18:00:00.000Z');
    // Hoy quedan 12, 14, 16 y 18 → luego mañana empieza a las 10:00 RD
    const today = slots.filter((s) => s.start.toISOString().startsWith('2026-10-07'));
    expect(today.map((s) => s.start.getUTCHours())).toEqual([16, 18, 20, 22]);
    expect(slots[4]!.start.toISOString()).toBe('2026-10-08T14:00:00.000Z');
  });

  it('en la noche solo ofrece los días siguientes', async () => {
    // 21:00 en RD = 01:00Z del día siguiente
    const slots = await listSlots(w.handle.db, w.config, new Date('2026-10-08T01:00:00Z'));
    expect(slots[0]!.start.toISOString()).toBe('2026-10-08T14:00:00.000Z'); // 10:00 RD del 8
  });

  it('ofrece 4 días en total (hoy + 3)', async () => {
    const slots = await listSlots(w.handle.db, w.config, new Date('2026-10-07T11:00:00Z'));
    const days = new Set(
      slots.map((s) => new Date(s.start.getTime() - 4 * 3_600_000).toISOString().slice(0, 10)),
    );
    expect(days.size).toBe(4);
  });
});

describe('zonas y envío', () => {
  let w: World;
  beforeAll(async () => (w = await makeWorld()));
  afterAll(() => w.close());

  it('encuentra la zona por sector o por ciudad, sin importar acentos ni mayúsculas', async () => {
    expect((await findZone(w.handle.db, { sector: 'PIANTINI', city: 'x' }))?.name).toBe(
      'Distrito Nacional',
    );
    expect((await findZone(w.handle.db, { sector: '', city: 'Distrito Nacional' }))?.name).toBe(
      'Distrito Nacional',
    );
    expect(await findZone(w.handle.db, { sector: 'Verón', city: 'Higüey' })).toBeNull();
  });

  it('calcula envío gratis y lo que falta para el mínimo', async () => {
    const zone = (await findZone(w.handle.db, { sector: 'Naco', city: '' }))!;
    expect(deliveryPricing(zone, 50_000)).toEqual({
      fee: 15_000,
      free: false,
      missingForMinimum: 30_000,
      missingForFree: 350_000,
    });
    expect(deliveryPricing(zone, 400_000)).toMatchObject({
      fee: 0,
      free: true,
      missingForMinimum: 0,
    });
  });
});
