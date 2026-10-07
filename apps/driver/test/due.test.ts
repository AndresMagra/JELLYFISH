import type { OrderDTO } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import {
  addressQuery,
  amountDue,
  deliveryStep,
  destinationCoords,
  googleMapsUrl,
  isPinLocked,
  latestOutForDeliveryId,
  sortDeliveries,
  wazeUrl,
  whatsappUrl,
} from '../src/due';

function order(over: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: 'o1',
    number: 1,
    code: 'JF-0001',
    status: 'out_for_delivery',
    paymentMethod: 'transfer',
    address: {
      label: 'Casa',
      line1: 'Av. Winston Churchill 100',
      reference: '',
      sector: 'Piantini',
      city: 'Santo Domingo',
      latitude: null,
      longitude: null,
    },
    total: 100_000,
    finalTotal: null,
    pinRequired: true,
    pinAttemptsLeft: 5,
    payments: [],
    timeline: [],
    ...over,
  } as unknown as OrderDTO;
}

const cashPending = { method: 'cash', status: 'pending' } as OrderDTO['payments'][number];
const cashHeld = { method: 'cash', status: 'captured' } as OrderDTO['payments'][number];

describe('amountDue', () => {
  it('cobra el total real si ya se pesó; si no, el estimado', () => {
    expect(amountDue(order({ paymentMethod: 'cash', payments: [cashPending] }))).toBe(100_000);
    expect(
      amountDue(order({ paymentMethod: 'cash', payments: [cashPending], finalTotal: 106_499 })),
    ).toBe(106_499);
  });
  it('0 si ya está pagado, cobrado o no es efectivo', () => {
    expect(amountDue(order({ paymentMethod: 'transfer' }))).toBe(0);
    expect(amountDue(order({ paymentMethod: 'cash', payments: [cashHeld] }))).toBe(0);
  });
});

describe('deliveryStep: cobrar, luego PIN, luego entregado', () => {
  const cash = { paymentMethod: 'cash', payments: [cashPending] } as Partial<OrderDTO>;
  it('antes de salir es "depart"', () => {
    expect(deliveryStep(order({ status: 'packed' }))).toBe('depart');
    expect(deliveryStep(order({ status: 'delivery_failed' }))).toBe('depart');
  });
  it('en efectivo, lo primero es cobrar (aunque haya PIN)', () => {
    expect(deliveryStep(order(cash))).toBe('collect');
    expect(deliveryStep(order({ ...cash, pinAttemptsLeft: 0 }))).toBe('collect');
  });
  it('cobrado o ya pagado: sigue el PIN', () => {
    expect(deliveryStep(order({ paymentMethod: 'cash', payments: [cashHeld] }))).toBe('pin');
    expect(deliveryStep(order())).toBe('pin');
  });
  it('sin intentos, queda bloqueado', () => {
    expect(deliveryStep(order({ pinAttemptsLeft: 0 }))).toBe('locked');
    expect(isPinLocked(order({ pinAttemptsLeft: 0 }))).toBe(true);
    expect(isPinLocked(order({ pinAttemptsLeft: 2 }))).toBe(false);
  });
  it('un pedido sin PIN se entrega directo', () => {
    expect(deliveryStep(order({ pinRequired: false, pinAttemptsLeft: null }))).toBe('deliver');
    expect(isPinLocked(order({ pinRequired: false, pinAttemptsLeft: 0 }))).toBe(false);
  });
});

describe('latestOutForDeliveryId', () => {
  const ev = (createdAt: string) => ({ toStatus: 'out_for_delivery', createdAt }) as never;
  it('elige el que salió más recientemente', () => {
    const a = order({ id: 'a', number: 1, timeline: [ev('2026-10-07T14:00:00Z')] });
    const b = order({ id: 'b', number: 2, timeline: [ev('2026-10-07T15:00:00Z')] });
    expect(latestOutForDeliveryId([a, b])).toBe('b');
    expect(latestOutForDeliveryId([b, a])).toBe('b');
  });
  it('un reintento (segundo evento "en camino") cuenta por el más nuevo', () => {
    const a = order({
      id: 'a',
      number: 1,
      timeline: [ev('2026-10-07T10:00:00Z'), ev('2026-10-07T16:00:00Z')],
    });
    const b = order({ id: 'b', number: 2, timeline: [ev('2026-10-07T15:00:00Z')] });
    expect(latestOutForDeliveryId([b, a])).toBe('a');
  });
  it('ignora los que no van en camino y devuelve null si no hay', () => {
    expect(latestOutForDeliveryId([order({ status: 'packed' })])).toBeNull();
    expect(latestOutForDeliveryId([])).toBeNull();
  });
  it('sin fechas desempata por número de pedido', () => {
    expect(
      latestOutForDeliveryId([order({ id: 'a', number: 7 }), order({ id: 'b', number: 9 })]),
    ).toBe('b');
  });
});

describe('mapas', () => {
  const withCoords = order({
    address: { ...order().address, latitude: 18.4861, longitude: -69.9312 },
  });
  it('con coordenadas usa ll=lat,lng en Waze y destination=lat,lng en Google Maps', () => {
    expect(wazeUrl(withCoords)).toBe('https://waze.com/ul?ll=18.4861,-69.9312&navigate=yes');
    expect(googleMapsUrl(withCoords)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=18.4861%2C-69.9312&travelmode=driving',
    );
  });
  it('sin coordenadas busca por el texto de la dirección', () => {
    const q = encodeURIComponent(addressQuery(order()));
    expect(wazeUrl(order())).toBe(`https://waze.com/ul?q=${q}&navigate=yes`);
    expect(googleMapsUrl(order())).toContain(`destination=${q}`);
    expect(addressQuery(order())).toBe(
      'Av. Winston Churchill 100, Piantini, Santo Domingo, República Dominicana',
    );
  });
  it('coordenadas fuera de RD o a medias se ignoran (se usa el texto)', () => {
    const fuera = order({ address: { ...order().address, latitude: 37.77, longitude: -122.4 } });
    const media = order({ address: { ...order().address, latitude: 18.48, longitude: null } });
    expect(destinationCoords(fuera)).toBeNull();
    expect(destinationCoords(media)).toBeNull();
    expect(wazeUrl(fuera)).toContain('q=');
    expect(destinationCoords(withCoords)).toEqual({ latitude: 18.4861, longitude: -69.9312 });
  });
  it('whatsapp deja solo los dígitos', () => {
    expect(whatsappUrl('+1 (809) 555-0100')).toBe('https://wa.me/18095550100');
  });
});

describe('sortDeliveries', () => {
  const o = (id: string, number: number, status: OrderDTO['status'], slotStart: string | null) =>
    order({ id, number, status, slotStart });
  it('en camino primero, luego listos para salir y al final las fallidas', () => {
    const list = [
      o('fail', 1, 'delivery_failed', '2026-10-07T14:00:00Z'),
      o('packed', 2, 'packed', '2026-10-07T14:00:00Z'),
      o('out', 3, 'out_for_delivery', '2026-10-07T20:00:00Z'),
    ];
    expect(sortDeliveries(list).map((x) => x.id)).toEqual(['out', 'packed', 'fail']);
  });
  it('dentro de cada grupo ordena por franja y luego por número, sin tocar la lista original', () => {
    const list = [
      o('c', 5, 'packed', '2026-10-07T16:00:00Z'),
      o('b', 4, 'packed', '2026-10-07T14:00:00Z'),
      o('a', 3, 'packed', '2026-10-07T14:00:00Z'),
    ];
    const copy = [...list];
    expect(sortDeliveries(list).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(copy);
  });
});
