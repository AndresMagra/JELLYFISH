import { formatDOP } from '@jellyfish/shared';
import { router } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../../src/api/client';
import { useAddresses, useQuote } from '../../src/api/hooks';
import { priceLabel } from '../../src/components/format';
import { Icon } from '../../src/components/Icon';
import { ProductImage } from '../../src/components/ProductImage';
import { QuantityStepper } from '../../src/components/QuantityStepper';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  FooterBar,
  Row,
  Skeleton,
} from '../../src/components/ui';
import { ScrollView } from 'react-native';
import { requireSession } from '../../src/lib/auth';
import { localTotals, useCart } from '../../src/store/cart';
import { Text, useTheme } from '../../src/theme';

export default function Cart() {
  const { colors, palette, spacing, radii } = useTheme();
  const lines = useCart((s) => s.lines);
  const increment = useCart((s) => s.increment);
  const decrement = useCart((s) => s.decrement);
  const remove = useCart((s) => s.remove);
  const clear = useCart((s) => s.clear);

  const addresses = useAddresses();
  const place = (addresses.data ?? []).find((a) => a.isDefault) ?? addresses.data?.[0];
  const quote = useQuote({
    items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    address: place ? { sector: place.sector, city: place.city } : undefined,
  });

  if (lines.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <EmptyState
          icon="cart-outline"
          title="Tu carrito está vacío"
          text="Agrega cortes, pescados o mariscos y los llevamos congelados a tu puerta."
          action="Explorar productos"
          onAction={() => router.push('/search')}
        />
      </SafeAreaView>
    );
  }

  const local = localTotals(lines);
  const q = quote.data;
  const subtotal = q?.subtotal ?? local.subtotal;
  const hasVariable = lines.some((l) => l.variableWeight);
  const blocked = !!quote.error || (q?.missingForMinimum ?? 0) > 0 || q?.coverage === 'not_covered';

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md }}
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text variant="display">Carrito</Text>
          <Button title="Vaciar" variant="ghost" small onPress={clear} />
        </View>

        {lines.map((l) => (
          <Card key={l.variantId} style={{ padding: 12, gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <ProductImage
                category={l.category}
                photo={l.photo}
                frozen={l.frozen}
                style={{ width: 76, height: 76, borderRadius: 18 }}
                iconSize={28}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="bodyStrong" numberOfLines={2}>
                  {l.name}
                </Text>
                {l.variant ? (
                  <Text variant="caption" muted>
                    {l.variant}
                  </Text>
                ) : null}
                <Text variant="caption" muted>
                  {priceLabel({ price: l.unitPrice, pricingUnit: l.pricingUnit })}
                </Text>
              </View>
              <Button
                title=""
                icon="trash-can-outline"
                variant="ghost"
                small
                onPress={() => remove(l.variantId)}
                style={{ alignSelf: 'flex-start', paddingHorizontal: 10 }}
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <QuantityStepper
                compact
                rules={l}
                quantity={l.quantity}
                available={l.available}
                onChange={(next) =>
                  next > l.quantity ? increment(l.variantId) : decrement(l.variantId)
                }
              />
              <Text variant="price" numberOfLines={1}>
                {formatDOP(
                  q?.lines.find((x) => x.variantId === l.variantId)?.net ??
                    local.lines.find((x) => x.id === l.variantId)?.net ??
                    0,
                )}
              </Text>
            </View>
          </Card>
        ))}

        {quote.error ? (
          <Card style={{ borderColor: palette.danger, flexDirection: 'row', gap: 10 }}>
            <Icon name="alert-circle-outline" size={22} color={palette.danger} />
            <Text style={{ flex: 1 }}>{errorMessage(quote.error)}</Text>
          </Card>
        ) : null}

        {q && q.missingForMinimum > 0 ? (
          <Card style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="information-outline" size={22} color={palette.warning} />
            <Text style={{ flex: 1 }}>
              El pedido mínimo para tu zona es mayor. Te faltan{' '}
              <Text variant="bodyStrong">{formatDOP(q.missingForMinimum)}</Text>.
            </Text>
          </Card>
        ) : null}

        {q?.coverage === 'not_covered' ? (
          <Card style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="map-marker-outline" size={22} color={palette.warning} />
            <Text style={{ flex: 1 }}>
              Aún no entregamos en el sector de tu dirección principal. Puedes elegir otra al pagar.
            </Text>
          </Card>
        ) : null}

        {q &&
        q.missingForFreeDelivery !== null &&
        q.missingForFreeDelivery > 0 &&
        !q.freeDelivery ? (
          <Card style={{ gap: 8 }}>
            <Text variant="bodyStrong">
              Agrega{' '}
              <Text variant="bodyStrong" color={colors.glow}>
                {formatDOP(q.missingForFreeDelivery)}
              </Text>{' '}
              y el envío es gratis
            </Text>
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: colors.surfaceAlt,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: colors.glow,
                  width: `${Math.min(100, Math.round((q.subtotal / (q.subtotal + q.missingForFreeDelivery)) * 100))}%`,
                }}
              />
            </View>
          </Card>
        ) : null}

        <Card style={{ borderRadius: radii.xl }}>
          {quote.isLoading ? (
            <Skeleton height={90} />
          ) : (
            <>
              <Row label="Subtotal" value={formatDOP(subtotal)} />
              <Row
                label="Envío"
                value={
                  q?.zone
                    ? q.freeDelivery
                      ? 'Gratis'
                      : formatDOP(q.deliveryFee)
                    : 'Se calcula con tu dirección'
                }
                muted={!q?.zone}
              />
              <Divider />
              <Row
                label={hasVariable ? 'Total estimado' : 'Total'}
                value={formatDOP(q?.total ?? subtotal)}
                strong
              />
              {hasVariable ? (
                <Text variant="caption" muted style={{ marginTop: 6 }}>
                  Pesamos al empacar y cobramos el peso real. Si pesa menos, te devolvemos la
                  diferencia.
                </Text>
              ) : null}
            </>
          )}
        </Card>
      </ScrollView>

      <FooterBar>
        <Button
          title={`Continuar · ${formatDOP(q?.total ?? subtotal)}`}
          disabled={blocked || quote.isLoading}
          testID="go-checkout"
          onPress={() => {
            if (requireSession('/checkout')) router.push('/checkout');
          }}
        />
      </FooterBar>
    </SafeAreaView>
  );
}
