import { es, isRemotePhoto, photoThumb } from '@jellyfish/shared';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, Text, useTheme } from '@jellyfish/mobile-core';
import { CategoryGlyph, categoryLook } from './CategoryIcon';

/** Las fotos del catálogo tienen fondo negro puro: así se ven mientras cargan (sin parpadeo blanco). */
export const PHOTO_BLACK = '#000000';

/** Proporción de las fotos del catálogo (4:3). */
export const PHOTO_RATIO = 4 / 3;

/**
 * Sombra suave para que un recuadro negro se vea premium sobre el fondo claro. En modo oscuro
 * no hace falta (el borde fino de la propia foto ya la separa del fondo).
 */
export function photoElevation(dark: boolean, strong = false): ViewStyle {
  if (dark) return {};
  if (Platform.OS === 'web')
    return {
      boxShadow: strong ? '0 14px 34px rgba(10,22,51,0.22)' : '0 6px 18px rgba(10,22,51,0.13)',
    } as ViewStyle;
  return {
    shadowColor: '#0A1633',
    shadowOpacity: strong ? 0.22 : 0.14,
    shadowRadius: strong ? 18 : 10,
    shadowOffset: { width: 0, height: strong ? 10 : 5 },
    elevation: strong ? 8 : 3,
  };
}

interface Props {
  category: string;
  photo?: string;
  /** Insignia de copo de nieve (producto congelado). */
  frozen?: boolean;
  /** true (por defecto) = la foto es ilustrativa; así se rotula cuando `label` lo pide. */
  illustrative?: boolean;
  /**
   * 'none' no rotula; 'mini' muestra un punto con "i" (listas); 'full' muestra "Imagen ilustrativa"
   * (héroe del detalle).
   */
  label?: 'none' | 'mini' | 'full';
  /** 'thumb' usa la miniatura liviana (tarjetas y listas); 'full' la foto completa (héroe). */
  quality?: 'thumb' | 'full';
  style?: StyleProp<ViewStyle>;
  iconSize?: number;
  /** Radio de las esquinas (0 para que la foto llegue hasta el borde de una tarjeta). */
  radius?: number;
  /** Cosas encima de la foto (corazón, "Agotado"…). */
  children?: ReactNode;
}

/**
 * Retrato del producto. Con foto: fondo negro mientras carga, caché en memoria y disco,
 * transición suave (también al cambiar de variante) y, si la miniatura falla, la foto completa.
 * Sin foto, o si falla del todo, un degradado con el ícono de la categoría (nunca un cuadro vacío).
 */
export function ProductImage({
  category,
  photo,
  frozen = true,
  illustrative = true,
  label = 'none',
  quality = 'thumb',
  style,
  iconSize = 54,
  radius = 20,
  children,
}: Props) {
  const look = categoryLook(category);
  const full = photo && isRemotePhoto(photo) ? photo.trim() : undefined;
  const thumb = full ? photoThumb(full) : undefined;
  const sources = !full
    ? []
    : quality === 'thumb' && thumb && thumb !== full
      ? [thumb, full]
      : [full];

  // URLs que fallaron: se prueba la siguiente (miniatura → foto completa → degradado).
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => setFailed([]), [full]);
  const src = sources.find((s) => !failed.includes(s));
  const showLabel = !!src && illustrative && label !== 'none';

  return (
    <View
      style={[
        styles.box,
        { borderRadius: radius },
        // Con foto el fondo es negro puro desde el primer cuadro.
        { backgroundColor: src ? PHOTO_BLACK : '#0A1633' },
        style,
      ]}
    >
      {src ? (
        <Image
          source={{ uri: src }}
          // En el héroe, la miniatura (ya en caché por las tarjetas) se ve mientras llega la completa.
          placeholder={quality === 'full' && thumb && thumb !== src ? { uri: thumb } : undefined}
          placeholderContentFit="cover"
          style={[StyleSheet.absoluteFill, { backgroundColor: PHOTO_BLACK }]}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={{ duration: 260, effect: 'cross-dissolve' }}
          onError={() => setFailed((f) => (f.includes(src) ? f : [...f, src]))}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <LinearGradient
          colors={look.gradient}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFill}
        >
          <View
            style={[
              styles.bubble,
              {
                width: 90,
                height: 90,
                top: -26,
                right: -20,
                backgroundColor: look.accent,
                opacity: 0.12,
              },
            ]}
          />
          <View
            style={[
              styles.bubble,
              {
                width: 46,
                height: 46,
                bottom: 14,
                left: -12,
                backgroundColor: look.accent,
                opacity: 0.1,
              },
            ]}
          />
          <View
            style={[
              styles.bubble,
              {
                width: 16,
                height: 16,
                top: 22,
                left: 26,
                backgroundColor: '#FFFFFF',
                opacity: 0.18,
              },
            ]}
          />
          <View style={styles.center}>
            <CategoryGlyph slug={category} size={iconSize} />
          </View>
        </LinearGradient>
      )}
      {/* Aro interior finísimo: separa el negro de la foto del fondo oscuro de la app. */}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: 'rgba(255,255,255,0.12)',
          },
        ]}
      />
      {frozen ? (
        <View style={styles.frozen} pointerEvents="none">
          <Icon name="snowflake" size={13} color="#E6F6FF" />
        </View>
      ) : null}
      {showLabel ? (
        label === 'full' ? (
          <View style={styles.note} pointerEvents="none" testID="photo-illustrative">
            <Icon name="information-outline" size={12} color="#FFFFFF" />
            <Text variant="caption" color="#FFFFFF" style={{ fontSize: 11 }}>
              {es.illustrativeImageNotice}
            </Text>
          </View>
        ) : (
          <View
            style={styles.dot}
            pointerEvents="none"
            accessibilityLabel={es.illustrativeImageNotice}
          >
            <Icon name="information-variant" size={11} color="#FFFFFF" />
          </View>
        )
      ) : null}
      {children}
    </View>
  );
}

/** Sombra para el contenedor de una foto (se pone en un View aparte: `overflow: hidden` la recorta). */
export function PhotoFrame({
  children,
  style,
  strong,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  strong?: boolean;
}) {
  const { dark } = useTheme();
  return <View style={[photoElevation(dark, strong), style]}>{children}</View>;
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden' },
  bubble: { position: 'absolute', borderRadius: 999 },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frozen: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(5,11,31,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  dot: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
