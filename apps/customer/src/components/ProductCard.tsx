import type { ProductDTO } from '@jellyfish/shared';
import { formatDOP } from '@jellyfish/shared';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Text, useTheme } from '@jellyfish/mobile-core';
import { ProductImage } from './ProductImage';

interface Props {
  product: ProductDTO;
  /** Ancho fijo para carruseles; sin él ocupa todo el espacio (grilla). */
  width?: number;
}

export function ProductCard({ product, width }: Props) {
  const { colors, radii } = useTheme();
  const first = product.variants[0];
  const soldOut = product.variants.every((v) => !v.inStock);
  const several = product.variants.length > 1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, desde ${formatDOP(product.fromPrice)}`}
      onPress={() =>
        router.push({ pathname: '/product/[group]', params: { group: product.group } })
      }
      style={({ pressed }) => ({
        width,
        flex: width ? undefined : 1,
        backgroundColor: colors.surface,
        borderRadius: radii.lg,
        borderWidth: 0.5,
        borderColor: colors.border,
        padding: 8,
        opacity: pressed ? 0.92 : soldOut ? 0.6 : 1,
      })}
    >
      <ProductImage
        category={product.category}
        photo={first?.photo}
        frozen={first?.frozen}
        style={{ height: width ? width * 0.78 : 118 }}
      />
      <View style={{ paddingHorizontal: 4, paddingTop: 10, paddingBottom: 4, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={2} style={{ minHeight: 44 }}>
          {product.name}
        </Text>
        <Text variant="caption" muted numberOfLines={1}>
          {soldOut
            ? 'Agotado'
            : several
              ? `${product.variants.length} opciones`
              : first?.variant || product.subcategory}
        </Text>
        <Text variant="price" style={{ marginTop: 4 }}>
          {several ? 'Desde ' : ''}
          {formatDOP(product.fromPrice)}
          <Text variant="caption" muted>
            {product.pricingUnit === 'lb' ? ' /lb' : ''}
          </Text>
        </Text>
      </View>
    </Pressable>
  );
}
