import type { ProductDTO } from '@jellyfish/shared';
import { describe, expect, it } from 'vitest';
import { normalizeCouponCode } from '../src/logic/coupon';
import {
  MAX_FAVORITES,
  isFavorite,
  resolveFavorites,
  toggleFavorite,
} from '../src/logic/favorites';

const p = (group: string): ProductDTO => ({
  group,
  name: group,
  category: 'res',
  subcategory: '',
  description: '',
  cookingTip: '',
  pricingUnit: 'lb',
  fromPrice: 100,
  variants: [],
});

describe('toggleFavorite', () => {
  it('agrega al principio y quita si ya estaba', () => {
    const a = toggleFavorite([], 'bistec');
    expect(a).toEqual(['bistec']);
    const b = toggleFavorite(a, 'pechuga');
    expect(b).toEqual(['pechuga', 'bistec']);
    expect(toggleFavorite(b, 'bistec')).toEqual(['pechuga']);
  });
  it('no muta la lista original', () => {
    const list = ['a', 'b'];
    toggleFavorite(list, 'c');
    toggleFavorite(list, 'a');
    expect(list).toEqual(['a', 'b']);
  });
  it('marcar y desmarcar deja todo como estaba', () => {
    const list = ['a', 'b'];
    expect(toggleFavorite(toggleFavorite(list, 'z'), 'z')).toEqual(list);
  });
  it('ignora un grupo vacío', () => {
    expect(toggleFavorite(['a'], '')).toEqual(['a']);
  });
  it('tiene un tope para no crecer sin fin', () => {
    let list: string[] = [];
    for (let i = 0; i < MAX_FAVORITES + 20; i++) list = toggleFavorite(list, `g${i}`);
    expect(list).toHaveLength(MAX_FAVORITES);
    expect(list[0]).toBe(`g${MAX_FAVORITES + 19}`); // el más reciente se queda
  });
  it('isFavorite', () => {
    expect(isFavorite(['a'], 'a')).toBe(true);
    expect(isFavorite(['a'], 'b')).toBe(false);
  });
});

describe('resolveFavorites', () => {
  it('conserva el orden en que se marcaron y descarta lo que ya no se vende', () => {
    const products = [p('a'), p('b'), p('c')];
    expect(resolveFavorites(['c', 'zzz', 'a'], products).map((x) => x.group)).toEqual(['c', 'a']);
  });
  it('sin favoritos o sin catálogo, lista vacía', () => {
    expect(resolveFavorites([], [p('a')])).toEqual([]);
    expect(resolveFavorites(['a'], [])).toEqual([]);
  });
});

describe('normalizeCouponCode', () => {
  it('quita espacios y pasa a mayúsculas', () => {
    expect(normalizeCouponCode('  jelly 10 ')).toBe('JELLY10');
  });
  it('convierte guiones tipográficos del teclado', () => {
    expect(normalizeCouponCode('bienvenida–15')).toBe('BIENVENIDA-15');
  });
  it('vacío se queda vacío y se limita el largo', () => {
    expect(normalizeCouponCode('   ')).toBe('');
    expect(normalizeCouponCode('a'.repeat(100))).toHaveLength(32);
  });
});
