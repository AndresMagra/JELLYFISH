import { es, formatDOP } from '@jellyfish/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Chip,
  ErrorState,
  FooterBar,
  Icon,
  IconButton,
  Skeleton,
  Text,
  errorMessage,
  priceLabel,
  success,
  useTheme,
} from '@jellyfish/mobile-core';
import { useProduct } from '../../src/api/hooks';
import { ProductImage } from '../../src/components/ProductImage';
import { QuantityStepper } from '../../src/components/QuantityStepper';
import { quantityOf, selectCount, useCart } from '../../src/store/cart';

export default function ProductScreen() {
  const { group } = useLocalSearchParams<{ group: string }>();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const { data, isLoading, isError, error, refetch } = useProduct(group);
  const product = data?.product;
  const [variantId, setVariantId] = useState<string | undefined>();
  const lines = useCart((s) => s.lines);
  const add = useCart((s) => s.add);
  const increment = useCart((s) => s.increment);
  const decrement = useCart((s) => s.decrement);
  const cartCount = useCart(selectCount);

  // Elige la variante más barata con stock al cargar.
  useEffect(() => {
    if (product && !variantId)
      setVariantId((product.variants.find((v) => v.inStock) ?? product.variants[0])?.id);
  }, [product, variantId]);

  if (isLoading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: 14 }}
      >
        <Skeleton height={260} radius={28} />
        <Skeleton height={34} width="70%" />
        <Skeleton height={60} />
      </SafeAreaView>
    );
  }
  if (isError || !product) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <ErrorState
          message={isError ? errorMessage(error) : 'No encontramos este producto.'}
          onRetry={isError ? () => void refetch() : () => router.back()}
        />
      </SafeAreaView>
    );
  }

  const variant = product.variants.find((v) => v.id === variantId) ?? product.variants[0]!;
  const qty = quantityOf(lines, variant.id);
  const estimate =
    variant.pricingUnit === 'lb' ? Math.round((variant.price * qty) / 100) : variant.price * qty;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ padding: spacing.lg, paddingTop: insets.top + spacing.sm }}>
          <ProductImage
            category={product.category}
            photo={variant.photo}
            frozen={false}
            iconSize={96}
            style={{ height: 270, borderRadius: 30 }}
          />
          <View
            style={{
              position: 'absolute',
              top: insets.top + spacing.lg + 6,
              left: spacing.lg + 10,
            }}
          >
            <IconButton
              icon="chevron-left"
              label="Volver"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            />
          </View>
          <View
            style={{
              position: 'absolute',
              top: insets.top + spacing.lg + 6,
              right: spacing.lg + 10,
            }}
          >
            <IconButton
              icon="cart-outline"
              label="Carrito"
              badge={cartCount}
              onPress={() => router.push('/cart')}
            />
          </View>
        </View>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {product.subcategory ? <Badge label={product.subcategory} /> : null}
            {variant.frozen ? <Badge label="Congelado" tone="info" /> : null}
            {variant.unconfirmed && data?.demo ? (
              <Badge label="Precio de ejemplo" tone="warning" />
            ) : null}
          </View>
          <Text variant="display">{product.name}</Text>

          {product.variants.length > 1 ? (
            <View style={{ gap: 8 }}>
              <Text variant="label" muted>
                Elige una opción
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {product.variants.map((v) => (
                  <Chip
                    key={v.id}
                    label={v.variant || product.name}
                    selected={v.id === variant.id}
                    disabled={!v.inStock}
                    onPress={() => setVariantId(v.id)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : variant.variant ? (
            <Text variant="bodyStrong" muted>
              {variant.variant}
            </Text>
          ) : null}

          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text variant="display" color={colors.glow}>
              {formatDOP(variant.price)}
            </Text>
            <Text muted>{variant.pricingUnit === 'lb' ? 'por libra' : 'por unidad'}</Text>
          </View>

          {product.description ? <Text muted>{product.description}</Text> : null}

          {variant.variableWeight ? (
            <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="scale" size={24} color={colors.glow} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">Pagas el peso real</Text>
                <Text variant="caption" muted>
                  Pesamos tu pedido al empacarlo. Cobramos un estimado y te devolvemos la diferencia
                  si pesa menos.
                </Text>
              </View>
            </Card>
          ) : null}

          {product.cookingTip ? (
            <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
              <Icon name="chef-hat" size={24} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">Cómo cocinarlo</Text>
                <Text variant="caption" muted>
                  {product.cookingTip}
                </Text>
              </View>
            </Card>
          ) : null}

          {variant.frozen ? (
            <Text variant="caption" muted>
              {es.coldChainNotice}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <FooterBar>
        {!variant.inStock ? (
          <Button title="Agotado por ahora" disabled onPress={() => {}} />
        ) : qty === 0 ? (
          <Button
            title={`Agregar · ${priceLabel(variant)}`}
            icon="cart-outline"
            testID="add-to-cart"
            onPress={() => {
              add(product, variant);
              success();
            }}
          />
        ) : (
          <>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <QuantityStepper
                rules={variant}
                quantity={qty}
                available={variant.available}
                onChange={(next) => (next > qty ? increment(variant.id) : decrement(variant.id))}
              />
              <View style={{ alignItems: 'flex-end' }}>
                <Text variant="caption" muted>
                  {variant.variableWeight ? 'Estimado' : 'Subtotal'}
                </Text>
                <Text variant="price">{formatDOP(estimate)}</Text>
              </View>
            </View>
            <Button title="Ver carrito" onPress={() => router.push('/cart')} />
          </>
        )}
      </FooterBar>
    </View>
  );
}
