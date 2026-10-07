import type { ProductDTO } from '@jellyfish/shared';

/** Los favoritos son una lista de `group` de producto, el más reciente primero. */
export const MAX_FAVORITES = 100;

export function isFavorite(list: readonly string[], group: string): boolean {
  return list.includes(group);
}

/** Agrega al principio, o quita si ya estaba. No muta la lista. */
export function toggleFavorite(list: readonly string[], group: string): string[] {
  if (!group) return [...list];
  if (list.includes(group)) return list.filter((g) => g !== group);
  return [group, ...list].slice(0, MAX_FAVORITES);
}

/**
 * Los productos favoritos que todavía existen en el catálogo, en el orden en que se marcaron.
 * Un favorito que ya no se vende simplemente no aparece (sin errores).
 */
export function resolveFavorites(
  list: readonly string[],
  products: readonly ProductDTO[],
): ProductDTO[] {
  const byGroup = new Map(products.map((p) => [p.group, p]));
  const out: ProductDTO[] = [];
  for (const g of list) {
    const p = byGroup.get(g);
    if (p) out.push(p);
  }
  return out;
}
