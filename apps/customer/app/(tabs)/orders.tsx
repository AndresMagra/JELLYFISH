import { type OrderDTO, type OrderStatus, es, formatDOP } from '@jellyfish/shared';
import { router } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
  Text,
  dateTimeLabel,
  errorMessage,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { useOrders } from '../../src/api/hooks';

const TONE: Partial<Record<OrderStatus, 'success' | 'warning' | 'danger' | 'info'>> = {
  pending_payment: 'warning',
  delivered: 'success',
  cancelled: 'danger',
  refunded: 'danger',
  delivery_failed: 'danger',
};

function OrderRow({ order }: { order: OrderDTO }) {
  const summary =
    order.items
      .map((i) => i.name)
      .slice(0, 2)
      .join(', ') + (order.items.length > 2 ? ` y ${order.items.length - 2} más` : '');
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/order/[id]', params: { id: order.id } })}
      accessibilityRole="button"
      accessibilityLabel={`Pedido ${order.code}`}
    >
      <Card style={{ gap: 8 }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="heading">{order.code}</Text>
          <Badge label={es.orderStatusLabel[order.status]} tone={TONE[order.status] ?? 'info'} />
        </View>
        <Text muted numberOfLines={2}>
          {summary}
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text variant="caption" muted>
            {dateTimeLabel(order.createdAt)}
          </Text>
          <Text variant="bodyStrong">{formatDOP(order.finalTotal ?? order.total)}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

export default function Orders() {
  const { colors, spacing } = useTheme();
  const token = useSession((s) => s.token);
  const orders = useOrders();

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <Text variant="display">Mis pedidos</Text>
      </View>
      {!token ? (
        <EmptyState
          icon="receipt-text"
          title="Inicia sesión para ver tus pedidos"
          text="Aquí seguirás cada pedido, desde que lo preparamos hasta que llega a tu puerta."
          action="Entrar"
          onAction={() => router.push({ pathname: '/login', params: { next: '/orders' } })}
        />
      ) : orders.isLoading ? (
        <View style={{ padding: spacing.lg, gap: 12 }}>
          <Skeleton height={110} radius={24} />
          <Skeleton height={110} radius={24} />
        </View>
      ) : orders.isError ? (
        <ErrorState message={errorMessage(orders.error)} onRetry={() => void orders.refetch()} />
      ) : (orders.data ?? []).length === 0 ? (
        <EmptyState
          icon="package-variant"
          title="Aún no tienes pedidos"
          text="Cuando hagas tu primer pedido aparecerá aquí."
          action="Ver productos"
          onAction={() => router.push('/search')}
        />
      ) : (
        <FlatList
          data={orders.data}
          keyExtractor={(o) => o.id}
          contentContainerStyle={{ padding: spacing.lg, gap: 12, paddingBottom: spacing.xxl * 2 }}
          renderItem={({ item }) => <OrderRow order={item} />}
          refreshing={orders.isRefetching}
          onRefresh={() => void orders.refetch()}
        />
      )}
    </SafeAreaView>
  );
}
