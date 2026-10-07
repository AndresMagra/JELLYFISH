import { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, StyleSheet } from 'react-native';
import { Icon, success, tap, useTheme } from '@jellyfish/mobile-core';
import { useFavorites } from '../store/favorites';

interface Props {
  group: string;
  name: string;
  /** 'photo': círculo oscuro translúcido para ir sobre una foto; 'solid': como los demás botones de la barra. */
  tone?: 'photo' | 'solid';
  /** Lado visible del círculo; el área táctil siempre es de 44 como mínimo. */
  size?: number;
}

/** Corazón para guardar un producto en favoritos (solo en este teléfono). */
export function FavoriteButton({ group, name, tone = 'photo', size = 34 }: Props) {
  const { colors, palette } = useTheme();
  const active = useFavorites((s) => s.groups.includes(group));
  const toggle = useFavorites((s) => s.toggle);
  const pop = useRef(new Animated.Value(1)).current;
  // El saltito es solo cuando la persona toca el corazón (no cuando los favoritos cargan del teléfono).
  const touched = useRef(false);

  useEffect(() => {
    const byPerson = touched.current;
    touched.current = false;
    if (!byPerson || !active) return;
    pop.setValue(0.7);
    Animated.spring(pop, {
      toValue: 1,
      friction: 3,
      tension: 160,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [active, pop]);

  const hit = Math.max(44, size);
  return (
    <Pressable
      testID={`fav-${group}`}
      accessibilityRole="button"
      accessibilityLabel={active ? `Quitar ${name} de favoritos` : `Guardar ${name} en favoritos`}
      accessibilityState={{ selected: active }}
      hitSlop={4}
      onPress={(e) => {
        // Dentro de una tarjeta, tocar el corazón no debe abrir el producto.
        e.stopPropagation?.();
        touched.current = true;
        if (active) tap();
        else success();
        toggle(group);
      }}
      style={({ pressed }) => ({
        width: hit,
        height: hit,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ scale: pop }],
          },
          tone === 'photo'
            ? { backgroundColor: 'rgba(0,0,0,0.5)' }
            : {
                backgroundColor: colors.surface,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: colors.border,
              },
        ]}
      >
        <Icon
          name={active ? 'heart' : 'heart-outline'}
          size={Math.round(size * 0.58)}
          color={active ? palette.coral : tone === 'photo' ? '#FFFFFF' : colors.text}
        />
      </Animated.View>
    </Pressable>
  );
}
