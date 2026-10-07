import { type OrderDTO, formatDOP } from '@jellyfish/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  Skeleton,
  Text,
  errorMessage,
  slotLabel,
  useMe,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { Redirect, router } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDeliveries } from '../src/api/hooks';
import { amountDue, isPinLocked, sortDeliveries } from '../src/due';
import { useDangerText } from '../src/colors';
import { TrackingNotice } from '../src/tracking';

const LABEL: Record<string, { text: string; tone: 'info' | 'warning' | 'danger' }> = {
  packed: { text: 'Listo para salir', tone: 'info' },
  out_for_delivery: { text: 'En camino', tone: 'warning' },
  delivery_failed: { text: 'No se pudo entregar', tone: 'danger' },
};

function DeliveryCard({ order }: { order: OrderDTO }) {
  const { colors, palette } = useTheme();
  const dangerText = useDangerText();
  const due = amountDue(order);
  const slot = order.slotStart && order.slotEnd ? slotLabel(order.slotStart, order.slotEnd) : null;
  const status = LABEL[order.status] ?? { text: order.status, tone: 'info' as const };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Entrega ${order.code}`}
      testID={`delivery-${order.code}`}
      onPress={() => router.push({ pathname: '/delivery/[id]', params: { id: order.id } })}
    >
      <Card style={{ gap: 10 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="heading">{order.code}</Text>
          <Badge label={status.text} tone={status.tone} />
        </View>
        <Text variant="bodyStrong">{order.customer.name || 'Cliente'}</Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Icon name="map-marker" size={18} color={colors.glow} />
          <Text style={{ flex: 1 }} numberOfLines={2}>
            {order.address.sector} · {order.address.line1}
          </Text>
        </View>
        {slot ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Icon name="clock-outline" size={18} color={colors.glow} />
            <Text muted>
              {slot.day} · {slot.time}
            </Text>
          </View>
        ) : null}
        {due ? (
          <View
            style={{
              backgroundColor: colors.surfaceAlt,
              borderRadius: 14,
              padding: 10,
              flexDirection: 'row',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Icon name="cash" size={20} color={colors.accent} />
            <Text variant="bodyStrong">Cobrar {formatDOP(due)} en efectivo</Text>
          </View>
        ) : (
          <Badge label="Ya está pagado" tone="success" />
        )}
        {order.pinRequired ? (
          <View
            testID={`pin-flag-${order.code}`}
            accessible
            accessibilityLabel={
              isPinLocked(order)
                ? 'Entrega bloqueada: se acabaron los intentos del PIN'
                : 'Esta entrega se cierra con el PIN del cliente'
            }
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
          >
            <Icon
              name={isPinLocked(order) ? 'lock-alert-outline' : 'lock-outline'}
              size={18}
              color={isPinLocked(order) ? palette.danger : colors.glow}
            />
            <Text
              variant="caption"
              color={isPinLocked(order) ? dangerText : undefined}
              muted={!isPinLocked(order)}
              style={{ flex: 1 }}
            >
              {isPinLocked(order)
                ? 'PIN bloqueado: avisa al administrador'
                : 'PIN requerido: pídeselo al cliente al entregar'}
            </Text>
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}

export default function Deliveries() {
  const { colors, spacing } = useTheme();
  const token = useSession((s) => s.token);
  const me = useMe();
  const q = useDeliveries();

  if (!token) return <Redirect href={{ pathname: '/login', params: { next: '/' } }} />;

  if (me.data && me.data.role !== 'driver') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        <EmptyState
          icon="lock-outline"
          title="Esta cuenta no es de repartidor"
          text="Pide al administrador que te agregue como repartidor con este celular."
          action="Cerrar sesión"
          onAction={() => void useSession.getState().signOut()}
        />
      </SafeAreaView>
    );
  }

  const orders = sortDeliveries(q.data ?? []);
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: spacing.sm,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <View>
          <Text variant="caption" muted>
            {me.data?.name ? `Hola, ${me.data.name.split(' ')[0]}` : 'Hola'}
          </Text>
          <Text variant="display">Mis entregas</Text>
        </View>
        <Button
          title="Salir"
          variant="ghost"
          small
          onPress={() => void useSession.getState().signOut()}
        />
      </View>

      {orders.length > 0 ? (
        <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
          <TrackingNotice hasDeliveries />
        </View>
      ) : null}

      {q.isLoading ? (
        <View style={{ padding: spacing.lg, gap: 12 }}>
          <Skeleton height={170} radius={24} />
          <Skeleton height={170} radius={24} />
        </View>
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : orders.length === 0 ? (
        <EmptyState
          icon="package-variant-closed"
          title="No tienes entregas por ahora"
          text="Cuando te asignen un pedido aparecerá aquí. Se actualiza solo."
          action="Actualizar"
          onAction={() => void q.refetch()}
        />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: spacing.lg, gap: 12, paddingBottom: spacing.xxl * 2 }}
          renderItem={({ item }) => <DeliveryCard order={item} />}
          refreshing={q.isRefetching}
          onRefresh={() => void q.refetch()}
        />
      )}
    </SafeAreaView>
  );
}
