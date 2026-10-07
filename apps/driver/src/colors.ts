import { useTheme } from '@jellyfish/mobile-core';

/**
 * Rojo para TEXTO de error: el rojo de la paleta (#DC2626) se lee bien sobre blanco, pero sobre el
 * azul profundo del modo oscuro queda con poco contraste (≈3.5:1), así que ahí se usa uno más claro.
 */
export function useDangerText(): string {
  const { dark, palette } = useTheme();
  return dark ? '#FF8A93' : palette.danger;
}
