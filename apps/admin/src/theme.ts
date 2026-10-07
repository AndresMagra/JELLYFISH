import { themes } from '@jellyfish/shared';

/** Vuelca los tokens de marca (los mismos de la app móvil) a variables CSS y sigue al sistema. */
export function applyTheme(): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const paint = () => {
    const t = media.matches ? themes.dark : themes.light;
    for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(`--${k}`, v);
    document.documentElement.style.colorScheme = media.matches ? 'dark' : 'light';
  };
  paint();
  media.addEventListener('change', paint);
}
