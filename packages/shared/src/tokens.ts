/**
 * Tokens de diseño de JELLYFISH: medusa bioluminiscente sobre océano profundo.
 * Fuente única para la app móvil (NativeWind), el panel admin (CSS vars) y la app de repartidor.
 */
export const palette = {
  // Océano profundo
  abyss: '#050B1F',
  deep: '#0A1633',
  ocean: '#10224D',
  tide: '#1A3470',
  // Bioluminiscencia
  cyan: '#22D3EE',
  cyanSoft: '#A5F3FC',
  coral: '#FF6B8A',
  coralSoft: '#FFD1DB',
  violet: '#8B5CF6',
  // Congelado
  ice: '#E6F6FF',
  frost: '#BFE6FF',
  // Neutros
  white: '#FFFFFF',
  mist: '#F4F8FC',
  slate: '#64748B',
  ink: '#0B1220',
  // Estados
  success: '#16A34A',
  warning: '#F59E0B',
  danger: '#DC2626',
} as const;

export const themes = {
  light: {
    background: palette.mist,
    surface: palette.white,
    surfaceAlt: palette.ice,
    text: palette.ink,
    textMuted: palette.slate,
    primary: palette.ocean,
    onPrimary: palette.white,
    accent: palette.coral,
    glow: palette.cyan,
    border: '#DCE6F2',
  },
  dark: {
    background: palette.abyss,
    surface: palette.deep,
    surfaceAlt: palette.ocean,
    text: '#EAF2FF',
    textMuted: '#93A4C3',
    primary: palette.cyan,
    onPrimary: palette.abyss,
    accent: palette.coral,
    glow: palette.cyan,
    border: '#1B2B57',
  },
} as const;

export const radii = { sm: 10, md: 16, lg: 24, xl: 32, pill: 999 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const typography = {
  display: 'Sora',
  body: 'Plus Jakarta Sans',
} as const;

export type ThemeName = keyof typeof themes;
