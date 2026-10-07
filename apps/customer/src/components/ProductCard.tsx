import type { ProductDTO } from '@jellyfish/shared';
import { formatDOP } from '@jellyfish/shared';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, fonts, tap, useTheme } from '@jellyfish/mobile-core';
import { FavoriteButton } from './FavoriteButton';
import { PHOTO_RATIO, PhotoFrame, ProductImage } from './ProductImage';

interface Props {
  product: ProductDTO;
  /** Ancho fijo para carruseles; sin él ocupa todo el espacio (grilla). */
  width?: number;
}

/** Tarjeta con la foto como protagonista (4:3 hasta el borde), nombre, opciones y precio. */
export function ProductCard({ product, width }: Props) {
  const { colors, radii } = useTheme();
  const first = product.variants.find((v) => v.inStock) ?? product.variants[0];
  // La foto de la tarjeta es la de la primera opción con foto (que no se vea el degradado si otra la tiene).
  const photoOf = (
    product.variants.find((v) => v.inStock && v.photo) ??
    product.variants.find((v) => v.photo) ??
    first
  )?.photo;
  const soldOut = product.variants.every((v) => !v.inStock);
  const several = product.variants.length > 1;
  return (
    <PhotoFrame
      style={{
        width,
        flex: width ? undefined : 1,
        borderRadius: radii.lg,
        backgroundColor: colors.surface,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${product.name}${soldOut ? ', agotado' : `, desde ${formatDOP(product.fromPrice)}`}`}
        onPress={() => {
          tap();
          router.push({ pathname: '/product/[group]', params: { group: product.group } });
        }}
        testID={`product-card-${product.group}`}
        style={({ pressed }) => ({
          borderRadius: radii.lg,
          overflow: 'hidden',
          backgroundColor: colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          opacity: pressed ? 0.93 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
        })}
      >
        <ProductImage
          category={product.category}
          photo={photoOf}
          frozen={first?.frozen}
          quality="thumb"
          radius={0}
          iconSize={44}
          style={{ width: '100%', aspectRatio: PHOTO_RATIO }}
        >
          {soldOut ? (
            <View style={styles.soldOut} pointerEvents="none">
              <View style={styles.soldOutPill}>
                <Text variant="caption" color="#FFFFFF" style={{ fontFamily: fonts.bold }}>
                  Agotado
                </Text>
              </View>
            </View>
          ) : null}
        </ProductImage>
        <View style={{ paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 2 }}>
          <Text variant="bodyStrong" numberOfLines={2} style={{ minHeight: 44 }}>
            {product.name}
          </Text>
          <Text variant="caption" muted numberOfLines={1}>
            {soldOut
              ? 'Agotado por ahora'
              : several
                ? `${product.variants.length} opciones · desde`
                : first?.variant || product.subcategory}
          </Text>
          <View
            style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginTop: 4 }}
          >
            <Text variant="price">{formatDOP(product.fromPrice)}</Text>
            {product.pricingUnit === 'lb' ? (
              <Text variant="caption" muted>
                {' '}
                /lb
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
      {/* Hermano de la tarjeta (no hijo): así el lector de pantalla encuentra los dos botones. */}
      <View style={styles.heart}>
        <FavoriteButton group={product.group} name={product.name} />
      </View>
    </PhotoFrame>
  );
}

const styles = StyleSheet.create({
  heart: { position: 'absolute', top: 2, right: 2 },
  soldOut: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soldOutPill: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(5,11,31,0.85)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.3)',
  },
});
