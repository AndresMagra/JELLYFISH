import { es } from '@jellyfish/shared';
import { LinearGradient } from 'expo-linear-gradient';
import { Image } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, CategoryGlyph, categoryLook } from './Icon';
import { Text } from '../theme';

interface Props {
  category: string;
  photo?: string;
  frozen?: boolean;
  /** Muestra "Imagen ilustrativa" cuando la foto es generada, no del producto real. */
  illustrative?: boolean;
  style?: StyleProp<ViewStyle>;
  iconSize?: number;
}

/**
 * Retrato del producto. Con foto real usa la foto; mientras no la haya, un degradado
 * bioluminiscente con el icono de la categoría (nunca un cuadro vacío).
 */
export function ProductImage({
  category,
  photo,
  frozen = true,
  illustrative,
  style,
  iconSize = 54,
}: Props) {
  const look = categoryLook(category);
  const hasPhoto = !!photo && /^https?:\/\//.test(photo);
  return (
    <View style={[styles.box, style]}>
      {hasPhoto ? (
        <Image
          source={{ uri: photo }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
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
      {frozen ? (
        <View style={styles.frozen}>
          <Icon name="snowflake" size={13} color="#E6F6FF" />
        </View>
      ) : null}
      {illustrative && hasPhoto ? (
        <View style={styles.note}>
          <Text variant="caption" color="#FFFFFF" style={{ fontSize: 10 }}>
            {es.illustrativeImageNotice}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', borderRadius: 20, backgroundColor: '#0A1633' },
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
    bottom: 6,
    right: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    backgroundColor: 'rgba(5,11,31,0.55)',
  },
});
