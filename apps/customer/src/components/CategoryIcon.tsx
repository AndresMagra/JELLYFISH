import { FontAwesome6, MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';

type Mci = ComponentProps<typeof MaterialCommunityIcons>['name'];
type Fa6 = ComponentProps<typeof FontAwesome6>['name'];

interface CategoryLook {
  icon: { set: 'fa6'; name: Fa6 } | { set: 'mci'; name: Mci };
  /** Degradado del "retrato" del producto mientras no hay foto real. */
  gradient: [string, string];
  accent: string;
}

const LOOKS: Record<string, CategoryLook> = {
  res: { icon: { set: 'fa6', name: 'cow' }, gradient: ['#7A1F3D', '#2B0B1F'], accent: '#FF6B8A' },
  cerdo: {
    icon: { set: 'fa6', name: 'bacon' },
    gradient: ['#8A3B55', '#3A1428'],
    accent: '#FFB3C6',
  },
  aves: {
    icon: { set: 'fa6', name: 'drumstick-bite' },
    gradient: ['#9A5B14', '#3B2208'],
    accent: '#FFC857',
  },
  pescados: {
    icon: { set: 'fa6', name: 'fish' },
    gradient: ['#0E6C8C', '#082A47'],
    accent: '#22D3EE',
  },
  mariscos: {
    icon: { set: 'fa6', name: 'shrimp' },
    gradient: ['#B4472B', '#3A1410'],
    accent: '#FF9B7A',
  },
  'chivo-otras': {
    icon: { set: 'mci', name: 'sheep' },
    gradient: ['#5B3F8F', '#1F1442'],
    accent: '#C4A8FF',
  },
  combos: {
    icon: { set: 'mci', name: 'package-variant-closed' },
    gradient: ['#1A3470', '#0A1633'],
    accent: '#A5F3FC',
  },
};

const FALLBACK: CategoryLook = {
  icon: { set: 'mci', name: 'snowflake' },
  gradient: ['#1A3470', '#0A1633'],
  accent: '#A5F3FC',
};

export const categoryLook = (slug: string): CategoryLook => LOOKS[slug] ?? FALLBACK;

export function CategoryGlyph({
  slug,
  size,
  color,
}: {
  slug: string;
  size: number;
  color?: string;
}) {
  const look = categoryLook(slug);
  const c = color ?? look.accent;
  return look.icon.set === 'fa6' ? (
    <FontAwesome6 name={look.icon.name} size={size} color={c} />
  ) : (
    <MaterialCommunityIcons name={look.icon.name} size={size} color={c} />
  );
}
