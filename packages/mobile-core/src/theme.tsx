import { palette, radii, spacing, themes } from '@jellyfish/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { Text as RNText, useColorScheme, type TextProps, type TextStyle } from 'react-native';

export type Theme = (typeof themes)['light'] | (typeof themes)['dark'];

export interface ThemeValue {
  dark: boolean;
  colors: Theme;
  palette: typeof palette;
  radii: typeof radii;
  spacing: typeof spacing;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const dark = scheme !== 'light';
  const value: ThemeValue = {
    dark,
    colors: dark ? themes.dark : themes.light,
    palette,
    radii,
    spacing,
  };
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const t = useContext(ThemeContext);
  if (!t) throw new Error('useTheme debe usarse dentro de <ThemeProvider>');
  return t;
}

export const fonts = {
  display: 'Sora_700Bold',
  displaySemi: 'Sora_600SemiBold',
  body: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
} as const;

type Variant =
  'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'caption' | 'label' | 'price';

const variants: Record<Variant, TextStyle> = {
  display: { fontFamily: fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 },
  title: { fontFamily: fonts.displaySemi, fontSize: 22, lineHeight: 28, letterSpacing: -0.2 },
  heading: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 23 },
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 22 },
  caption: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 17 },
  label: {
    fontFamily: fonts.bold,
    fontSize: 11.5,
    lineHeight: 14,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  price: { fontFamily: fonts.display, fontSize: 18, lineHeight: 24 },
};

export interface AppTextProps extends TextProps {
  variant?: Variant;
  muted?: boolean;
  color?: string;
  center?: boolean;
}

/** Texto con la tipografía de la marca y los colores del tema (sube con el tamaño de letra del sistema). */
export function Text({ variant = 'body', muted, color, center, style, ...rest }: AppTextProps) {
  const { colors } = useTheme();
  return (
    <RNText
      {...rest}
      style={[
        variants[variant],
        { color: color ?? (muted ? colors.textMuted : colors.text) },
        center && { textAlign: 'center' },
        style,
      ]}
    />
  );
}
