import { type OrderDTO, formatDOP } from '@jellyfish/shared';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  FooterBar,
  Header,
  Icon,
  Text,
  errorMessage,
  quantityLabel,
  slotLabel,
  success,
  useTheme,
} from '@jellyfish/mobile-core';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCollectCash, useDeliveries, useMove } from '../../src/api/hooks';
import { amountDue, googleMapsUrl, wazeUrl, whatsappUrl } from '../../src/due';

const FAIL_REASONS = [
  'No contestó el teléfono',
  'No había nadie',
  'Dirección incorrecta o no la encontré',
  'El cliente rechazó el pedido',
  'Otro motivo',
];

const open = (url: string) => void Linking.openURL(url);

/** Vuelve a la lista que ya está en la pila (no apila otra copia congelada con datos viejos). */
const goToList = () => (router.canGoBack() ? router.back() : router.replace('/'));

function Action({
  icon,
  label,
  url,
  testID,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  label: string;
  url: string;
  testID?: string;
}) {
  const { colors, radii } = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      testID={testID}
      onPress={() => open(url)}
      style={({ pressed }) => ({
        flex: 1,
        alignItems: 'center',
        gap: 6,
        paddingVertical: 12,
        borderRadius: radii.md,
        backgroundColor: colors.surfaceAlt,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={24} color={colors.glow} />
      <Text variant="caption">{label}</Text>
    </Pressable>
  );
}

export default function Delivery() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, palette, spacing } = useTheme();
  const q = useDeliveries();
  const move = useMove();
  const collect = useCollectCash();
  const [failing, setFailing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const order: OrderDTO | undefined = q.data?.find((o) => o.id === id);

  if (!order) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg }}>
        <Header title="Entrega" />
        {q.isLoading ? null : (
          <EmptyState
            icon="check-circle"
            title="Esta entrega ya no está activa"
            text="La entregaste, la cancelaron o ya no está asignada a ti."
            action="Ver mis entregas"
            onAction={goToList}
          />
        )}
      </SafeAreaView>
    );
  }

  const due = amountDue(order);
  const slot = order.slotStart && order.slotEnd ? slotLabel(order.slotStart, order.slotEnd) : null;
  const run = async (fn: () => Promise<unknown>, ok?: () => void) => {
    setError(null);
    try {
      await fn();
      success();
      ok?.();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const busy = move.isPending || collect.isPending;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.md,
          paddingBottom: spacing.xxl * 2,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Header title={order.code} />

        <Card style={{ gap: 10 }}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text variant="title">{order.customer.name || 'Cliente'}</Text>
            {order.status === 'out_for_delivery' ? (
              <Badge label="En camino" tone="warning" />
            ) : order.status === 'packed' ? (
              <Badge label="Listo para salir" />
            ) : (
              <Badge label="No se pudo entregar" tone="danger" />
            )}
          </View>
          {slot ? (
            <Text muted>
              {slot.day} · {slot.time}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Action icon="phone" label="Llamar" url={`tel:${order.customer.phone}`} testID="call" />
            <Action
              icon="whatsapp"
              label="WhatsApp"
              url={whatsappUrl(order.customer.phone)}
              testID="whatsapp"
            />
          </View>
        </Card>

        <Card style={{ gap: 10 }}>
          <Text variant="heading">Dónde entregar</Text>
          <Text variant="bodyStrong">
            {order.address.line1}, {order.address.sector}
          </Text>
          <Text muted>{order.address.city}</Text>
          {order.address.reference ? (
            <View
              style={{
                backgroundColor: colors.surfaceAlt,
                borderRadius: 14,
                padding: 12,
                flexDirection: 'row',
                gap: 10,
              }}
            >
              <Icon name="information-outline" size={20} color={colors.accent} />
              <Text style={{ flex: 1 }}>{order.address.reference}</Text>
            </View>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Action icon="map-marker" label="Waze" url={wazeUrl(order)} testID="waze" />
            <Action
              icon="map-marker-outline"
              label="Google Maps"
              url={googleMapsUrl(order)}
              testID="gmaps"
            />
          </View>
        </Card>

        <Card style={{ gap: 6 }}>
          <Text variant="heading">Qué llevas</Text>
          {order.items.map((it) => (
            <View
              key={it.id}
              style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}
            >
              <Text style={{ flex: 1 }}>
                {it.name}
                {it.variant ? ` · ${it.variant}` : ''}
              </Text>
              <Text variant="bodyStrong">
                {quantityLabel(it.pricingUnit, it.finalQuantity ?? it.quantity)}
              </Text>
            </View>
          ))}
          <Divider />
          <Text variant="caption" muted>
            Producto congelado: entrégalo en la bolsa con hielo y no lo dejes fuera de frío.
          </Text>
          {order.notes ? (
            <View
              style={{ backgroundColor: palette.warning + '33', borderRadius: 12, padding: 10 }}
            >
              <Text variant="bodyStrong">Nota del cliente: {order.notes}</Text>
            </View>
          ) : null}
        </Card>

        <Card style={{ gap: 6 }}>
          <Text variant="heading">Pago</Text>
          {due ? (
            <>
              <Text variant="display" color={colors.glow} testID="amount-due">
                {formatDOP(due)}
              </Text>
              <Text muted>Cobra este monto exacto en efectivo antes de entregar.</Text>
            </>
          ) : order.paymentMethod === 'cash' ? (
            <Badge label="Efectivo ya cobrado" tone="success" />
          ) : (
            <Badge label="Ya está pagado: no cobres nada" tone="success" />
          )}
        </Card>

        {error ? (
          <Card style={{ borderColor: palette.danger }}>
            <Text color={palette.danger} testID="driver-error">
              {error}
            </Text>
          </Card>
        ) : null}
      </ScrollView>

      <FooterBar>
        {order.status === 'packed' || order.status === 'delivery_failed' ? (
          <Button
            title={order.status === 'packed' ? 'Salir a entregar' : 'Reintentar entrega'}
            icon="truck-delivery"
            loading={busy}
            testID="act-out"
            onPress={() => run(() => move.mutateAsync({ id: order.id, to: 'out_for_delivery' }))}
          />
        ) : null}
        {order.status === 'out_for_delivery' ? (
          <>
            {due ? (
              <Button
                title={`Ya cobré ${formatDOP(due)}`}
                icon="cash"
                loading={busy}
                testID="act-collect"
                onPress={() => run(() => collect.mutateAsync({ id: order.id, amount: due }))}
              />
            ) : (
              <Button
                title="Entregado"
                icon="check-circle"
                loading={busy}
                testID="act-delivered"
                onPress={() =>
                  run(() => move.mutateAsync({ id: order.id, to: 'delivered' }), goToList)
                }
              />
            )}
            <Button
              title="No pude entregar"
              variant="ghost"
              disabled={busy}
              testID="act-failed"
              onPress={() => setFailing(true)}
            />
          </>
        ) : null}
      </FooterBar>

      <Modal
        visible={failing}
        transparent
        animationType="fade"
        onRequestClose={() => setFailing(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(2,6,18,0.65)', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 28,
              borderTopRightRadius: 28,
              padding: spacing.lg,
              gap: 10,
            }}
          >
            <Text variant="title">¿Qué pasó?</Text>
            {FAIL_REASONS.map((r) => (
              <Button
                key={r}
                title={r}
                variant="secondary"
                testID={`fail-${r.slice(0, 6)}`}
                onPress={() =>
                  run(
                    () => move.mutateAsync({ id: order.id, to: 'delivery_failed', note: r }),
                    () => {
                      setFailing(false);
                      goToList();
                    },
                  )
                }
              />
            ))}
            <Button title="Volver" variant="ghost" onPress={() => setFailing(false)} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
