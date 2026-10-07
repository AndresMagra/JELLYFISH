import { describe, expect, it } from 'vitest';
import {
  formatCoords,
  liveAgeSeconds,
  mapsUrl,
  trackingAge,
  trackingHeadline,
  trackingUnavailableText,
} from '../src/logic/tracking';

describe('trackingAge', () => {
  it('segundos, minutos y "ahora mismo"', () => {
    expect(trackingAge(0)).toBe('ahora mismo');
    expect(trackingAge(4.4)).toBe('ahora mismo');
    expect(trackingAge(5)).toBe('hace 5 s');
    expect(trackingAge(59)).toBe('hace 59 s');
    expect(trackingAge(60)).toBe('hace 1 min');
    expect(trackingAge(125)).toBe('hace 2 min');
  });
  it('un valor negativo (reloj desajustado) no rompe', () => {
    expect(trackingAge(-30)).toBe('ahora mismo');
  });
  it('el titular lleva la frase pedida', () => {
    expect(trackingHeadline(12)).toBe('Tu repartidor va en camino · actualizado hace 12 s');
  });
});

describe('liveAgeSeconds', () => {
  it('suma lo que pasó desde que se consultó', () => {
    expect(liveAgeSeconds(10, 1_000_000, 1_007_000)).toBe(17);
  });
  it('nunca da menos de cero', () => {
    expect(liveAgeSeconds(0, 2_000_000, 1_000_000)).toBe(0);
  });
});

describe('trackingUnavailableText', () => {
  it('cada motivo tiene su explicación en español', () => {
    const reasons = ['not_out_for_delivery', 'no_driver', 'no_position', 'stale'] as const;
    const texts = reasons.map(trackingUnavailableText);
    expect(new Set(texts).size).toBe(4);
    expect(trackingUnavailableText('no_driver')).toContain('asignando un repartidor');
    expect(trackingUnavailableText('stale')).toContain('últimos minutos');
    for (const t of texts) expect(t).not.toMatch(/no_|_/);
  });
});

describe('mapsUrl', () => {
  it('iPhone abre Apple Maps con las coordenadas', () => {
    expect(mapsUrl('ios', 18.4861, -69.9312)).toBe(
      'https://maps.apple.com/?ll=18.4861,-69.9312&q=Tu%20repartidor',
    );
  });
  it('Android y web abren Google Maps', () => {
    const g = 'https://www.google.com/maps/search/?api=1&query=18.4861,-69.9312';
    expect(mapsUrl('android', 18.4861, -69.9312)).toBe(g);
    expect(mapsUrl('web', 18.4861, -69.9312)).toBe(g);
  });
  it('redondea a 6 decimales y respeta el signo negativo de la longitud', () => {
    expect(mapsUrl('android', 18.123456789, -69.987654321)).toContain('query=18.123457,-69.987654');
  });
  it('coordenadas fuera de RD o inválidas no generan enlace', () => {
    expect(mapsUrl('ios', 37.77, -122.41)).toBeNull();
    expect(mapsUrl('ios', Number.NaN, -69)).toBeNull();
    expect(mapsUrl('android', 18.4, 69.9)).toBeNull(); // se olvidó el signo
  });
  it('escapa la etiqueta', () => {
    expect(mapsUrl('ios', 18.5, -69.9, 'Pedro & Hijos')).toContain('q=Pedro%20%26%20Hijos');
  });
});

describe('formatCoords', () => {
  it('cuatro decimales', () => {
    expect(formatCoords(18.486058, -69.931212)).toBe('18.4861, -69.9312');
  });
});
