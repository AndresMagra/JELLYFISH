import { type OrderDTO, type OrderStatus, es, formatDOP } from '@jellyfish/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Badge,
  Button,
  Card,
  Divider,
  ErrorState,
  Header,
  Icon,
  Row,
  Skeleton,
  Text,
  TextField,
  dateTimeLabel,
  errorMessage,
  quantityLabel,
  slotLabel,
  useTheme,
} from '@jellyfish/mobile-core';
import {
  useCancelOrder,
  useOrder,
  useStartPayment,
  useSubmitTransferProof,
  useTransferInfo,
} from '../../src/api/hooks';
import { openCardCheckout } from '../../src/lib/pay';

const STEPS: { status: OrderStatus; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { status: 'confirmed', label: 'Confirmado', icon: 'check-circle' },
  { status: 'picking', label: 'Preparando', icon: 'scale' },
  { status: 'packed', label: 'Empacado', icon: 'snowflake' },
  { status: 'out_for_delivery', label: 'En camino', icon: 'truck-delivery' },
  { status: 'delivered', label: 'Entregado', icon: 'home' },
];

function Progress({ status }: { status: OrderStatus }) {
  const { colors, palette } = useTheme();
  const idx = STEPS.findIndex((s) => s.status === status);
  const reached = status === 'delivery_failed' ? 3 : idx;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      {STEPS.map((s, i) => {
        const done = i <= reached;
        return (
          <View key={s.status} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%' }}>
              <View
                style={{
                  flex: 1,
                  height: 3,
                  backgroundColor:
                    i === 0 ? 'transparent' : i <= reached ? palette.cyan : colors.border,
                }}
              />
              <View
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: done ? palette.cyan : colors.surfaceAlt,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={s.icon} size={15} color={done ? palette.abyss : colors.textMuted} />
              </View>
              <View
                style={{
                  flex: 1,
                  height: 3,
                  backgroundColor:
                    i === STEPS.length - 1
                      ? 'transparent'
                      : i < reached
                        ? palette.cyan
                        : colors.border,
                }}
              />
            </View>
            <Text
              variant="caption"
              color={done ? colors.text : colors.textMuted}
              center
              style={{ fontSize: 10.5 }}
            >
              {s.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function PaymentCard({ order }: { order: OrderDTO }) {
  const { colors, palette } = useTheme();
  const startPayment = useStartPayment();
  const proof = useSubmitTransferProof();
  const transfer = useTransferInfo(
    order.paymentMethod === 'transfer' && order.status === 'pending_payment',
  );
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  const p = order.payments[order.payments.length - 1];
  const captured = order.payments.some(
    (x) => x.status === 'captured' || x.status === 'partially_refunded' || x.status === 'refunded',
  );
  const refundPending = order.payments.reduce((a, x) => a + x.refundPending, 0);
  const refunded = order.payments.reduce((a, x) => a + x.refundedAmount, 0);
  const due = order.finalTotal ?? order.total;
  const proofSent = !!p?.proofSubmitted;

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon
          name={
            order.paymentMethod === 'card'
              ? 'credit-card-outline'
              : order.paymentMethod === 'cash'
                ? 'cash'
                : 'bank-transfer'
          }
          size={24}
          color={colors.glow}
        />
        <Text variant="heading" style={{ flex: 1 }}>
          {es.paymentMethodLabel[order.paymentMethod]}
        </Text>
        {captured ? (
          <Badge label="Pagado" tone="success" />
        ) : order.status === 'cancelled' ? (
          <Badge label="Anulado" tone="danger" />
        ) : (
          <Badge label="Pendiente" tone="warning" />
        )}
      </View>

      {order.paymentMethod === 'cash' && !captured && order.status !== 'cancelled' ? (
        <Text>
          Pagas <Text variant="bodyStrong">{formatDOP(due)}</Text> en efectivo al recibir
          {order.finalTotal === null ? ' (monto estimado; se confirma al pesar)' : ''}. Ten el monto
          exacto, por favor.
        </Text>
      ) : null}

      {order.paymentMethod === 'card' && order.status === 'pending_payment' ? (
        <>
          <Text muted>Completa el pago para confirmar tu pedido y reservar tus productos.</Text>
          <Button
            title={`Pagar ${formatDOP(order.total)}`}
            icon="lock-outline"
            loading={startPayment.isPending}
            testID="pay-now"
            onPress={async () => {
              setError(null);
              try {
                const pay = await startPayment.mutateAsync(order.id);
                await openCardCheckout(pay.redirectUrl);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </>
      ) : null}

      {order.paymentMethod === 'transfer' && order.status === 'pending_payment' ? (
        <>
          {transfer.data ? (
            <View
              style={{ backgroundColor: colors.surfaceAlt, borderRadius: 16, padding: 14, gap: 4 }}
            >
              <Text variant="label" muted>
                Transfiere {formatDOP(order.total)} a
              </Text>
              <Text variant="bodyStrong">{transfer.data.bank}</Text>
              <Text>
                {transfer.data.accountType} · {transfer.data.accountNumber}
              </Text>
              <Text>{transfer.data.holder}</Text>
              {transfer.data.taxId ? (
                <Text variant="caption" muted>
                  RNC/Cédula: {transfer.data.taxId}
                </Text>
              ) : null}
            </View>
          ) : transfer.isLoading ? (
            <Skeleton height={90} />
          ) : null}
          <TextField
            label="Número de referencia o confirmación"
            value={reference}
            onChangeText={setReference}
            placeholder="Ej: 889900123"
          />
          <Button
            title={proofSent || proof.isSuccess ? 'Referencia enviada' : 'Ya transferí'}
            disabled={reference.trim().length < 3 || proof.isSuccess}
            loading={proof.isPending}
            onPress={async () => {
              setError(null);
              try {
                await proof.mutateAsync({ id: order.id, reference: reference.trim() });
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
          {proof.isSuccess ? (
            <Text variant="caption" muted>
              Verificaremos tu transferencia y confirmaremos tu pedido.
            </Text>
          ) : null}
        </>
      ) : null}

      {refundPending > 0 ? (
        <Text color={palette.warning} variant="bodyStrong">
          Te devolveremos {formatDOP(refundPending)}.
        </Text>
      ) : null}
      {refunded > 0 ? (
        <Text variant="caption" muted>
          Devuelto: {formatDOP(refunded)}
        </Text>
      ) : null}
      {error ? <Text color={palette.danger}>{error}</Text> : null}
    </Card>
  );
}

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, palette, spacing } = useTheme();
  const { data: order, isLoading, isError, error, refetch } = useOrder(id);
  const cancel = useCancelOrder();

  if (isLoading) {
    return (
      <SafeAreaView
        style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg, gap: 14 }}
      >
        <Header title="Tu pedido" />
        <Skeleton height={150} radius={28} />
        <Skeleton height={120} />
      </SafeAreaView>
    );
  }
  if (isError || !order) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: spacing.lg }}>
        <Header title="Tu pedido" />
        <ErrorState
          message={isError ? errorMessage(error) : 'No encontramos este pedido.'}
          onRetry={() => void refetch()}
        />
      </SafeAreaView>
    );
  }

  const slot =
    order.slotStart && order.slotEnd
      ? slotLabel(order.slotStart, order.slotEnd, new Date(order.createdAt))
      : null;
  const canCancel = order.status === 'pending_payment' || order.status === 'confirmed';
  const finalMode = order.finalTotal !== null;
  const closed = order.status === 'cancelled' || order.status === 'refunded';

  const askCancel = () => {
    const run = () => cancel.mutate({ id: order.id, reason: 'Cancelado por el cliente' });
    if (Platform.OS === 'web') {
      if (globalThis.confirm?.('¿Cancelar este pedido?')) run();
      return;
    }
    Alert.alert(
      '¿Cancelar este pedido?',
      'Liberaremos tus productos. Si ya pagaste, te devolveremos el dinero.',
      [
        { text: 'No, mantener', style: 'cancel' },
        { text: 'Sí, cancelar', style: 'destructive', onPress: run },
      ],
    );
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.lg,
          paddingBottom: spacing.xxl * 1.5,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Header title={`Pedido ${order.code}`} />

        <Card style={{ gap: 16, backgroundColor: colors.surface }}>
          <View style={{ gap: 4 }}>
            <Text variant="title" testID="order-status">
              {es.orderStatusLabel[order.status]}
            </Text>
            <Text muted>{es.orderStatusHint[order.status]}</Text>
          </View>
          {!closed && order.status !== 'pending_payment' ? (
            <Progress status={order.status} />
          ) : null}
          {slot && !closed ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="clock-outline" size={18} color={colors.glow} />
              <Text variant="bodyStrong">
                {slot.day} · {slot.time}
              </Text>
            </View>
          ) : null}
        </Card>

        <PaymentCard order={order} />

        <Card>
          <Text variant="heading" style={{ marginBottom: 8 }}>
            Tu pedido
          </Text>
          {order.items.map((it) => (
            <View
              key={it.id}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                gap: 12,
                paddingVertical: 6,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text variant="bodyStrong">
                  {it.name}
                  {it.variant ? ` · ${it.variant}` : ''}
                </Text>
                <Text variant="caption" muted>
                  {it.finalQuantity !== null && it.finalQuantity !== it.quantity
                    ? `Pedido ${quantityLabel(it.pricingUnit, it.quantity)} · Peso real ${quantityLabel(it.pricingUnit, it.finalQuantity)}`
                    : quantityLabel(it.pricingUnit, it.finalQuantity ?? it.quantity)}
                </Text>
              </View>
              <Text variant="bodyStrong">{formatDOP(it.finalLineTotal ?? it.lineTotal)}</Text>
            </View>
          ))}
          <Divider />
          <Row label="Subtotal" value={formatDOP(order.subtotal)} />
          <Row
            label="Envío"
            value={order.deliveryFee === 0 ? 'Gratis' : formatDOP(order.deliveryFee)}
          />
          <Row
            label={finalMode ? 'Total final (peso real)' : 'Total estimado'}
            value={formatDOP(order.finalTotal ?? order.total)}
            strong
          />
          {finalMode && order.finalTotal !== order.total ? (
            <Text variant="caption" muted style={{ marginTop: 4 }}>
              Estimado inicial: {formatDOP(order.total)}
            </Text>
          ) : null}
        </Card>

        <Card style={{ gap: 6 }}>
          <Text variant="heading">Entrega</Text>
          <Text>
            {order.address.line1}, {order.address.sector}
          </Text>
          {order.address.reference ? (
            <Text variant="caption" muted>
              {order.address.reference}
            </Text>
          ) : null}
        </Card>

        <Card style={{ gap: 8 }}>
          <Text variant="heading">Seguimiento</Text>
          {[...order.timeline].reverse().map((e) => (
            <View key={e.id} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <View
                style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.glow }}
              />
              <Text style={{ flex: 1 }}>{es.orderStatusLabel[e.toStatus]}</Text>
              <Text variant="caption" muted>
                {dateTimeLabel(e.createdAt)}
              </Text>
            </View>
          ))}
        </Card>

        {canCancel ? (
          <Button
            title="Cancelar pedido"
            variant="ghost"
            loading={cancel.isPending}
            onPress={askCancel}
            testID="cancel-order"
          />
        ) : null}
        {cancel.isError ? <Text color={palette.danger}>{errorMessage(cancel.error)}</Text> : null}
        <Button title="Volver al inicio" variant="secondary" onPress={() => router.replace('/')} />
      </ScrollView>
    </SafeAreaView>
  );
}
