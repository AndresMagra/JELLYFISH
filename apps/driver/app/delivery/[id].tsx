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
  fonts,
  quantityLabel,
  slotLabel,
  success,
  useTheme,
} from '@jellyfish/mobile-core';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCollectCash, useDeliveries, useMove } from '../../src/api/hooks';
import { ADMIN_CONTACT_PHONE } from '../../src/config';
import {
  type DeliveryStep,
  amountDue,
  deliveryStep,
  googleMapsUrl,
  wazeUrl,
  whatsappUrl,
} from '../../src/due';
import { PIN_MAX_ATTEMPTS, type PinFailure, attemptsText, classifyPinError } from '../../src/pin';
import { PinSheet } from '../../src/PinSheet';
import { Sheet } from '../../src/Sheet';
import { useDangerText } from '../../src/colors';
import { useTracking } from '../../src/tracking';

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

type StepState = 'done' | 'current' | 'todo' | 'blocked';

/** Los pasos para cerrar la entrega, siempre en el mismo orden: cobrar, PIN, entregado. */
function StepsCard({ order, step }: { order: OrderDTO; step: DeliveryStep }) {
  const { colors, palette } = useTheme();
  const dangerText = useDangerText();
  const due = amountDue(order);
  const rows: { key: string; label: string; hint?: string; state: StepState }[] = [];

  if (order.paymentMethod === 'cash') {
    rows.push({
      key: 'cash',
      label: step === 'collect' ? `Cobrar ${formatDOP(due)} en efectivo` : 'Efectivo cobrado',
      state: step === 'collect' ? 'current' : 'done',
    });
  }
  if (order.pinRequired) {
    const left = order.pinAttemptsLeft;
    rows.push({
      key: 'pin',
      label: 'Pedirle el PIN al cliente',
      hint:
        step === 'locked'
          ? 'Se acabaron los intentos: avisa al administrador.'
          : left !== null && left < PIN_MAX_ATTEMPTS
            ? attemptsText(left)
            : 'Son 4 dígitos que el cliente ve en su app.',
      state:
        step === 'collect'
          ? 'todo'
          : step === 'pin'
            ? 'current'
            : step === 'locked'
              ? 'blocked'
              : 'done',
    });
  }
  rows.push({
    key: 'deliver',
    label: 'Marcar como entregado',
    state: step === 'deliver' ? 'current' : 'todo',
  });

  return (
    <Card style={{ gap: 12 }}>
      <Text variant="heading">Cómo cerrar esta entrega</Text>
      {rows.map((r, i) => {
        const tint =
          r.state === 'done'
            ? palette.success
            : r.state === 'blocked'
              ? palette.danger
              : r.state === 'current'
                ? colors.glow
                : colors.textMuted;
        return (
          <View
            key={r.key}
            testID={`step-${r.key}`}
            accessible
            accessibilityLabel={`Paso ${i + 1}: ${r.label}${
              r.state === 'done' ? ', hecho' : r.state === 'blocked' ? ', bloqueado' : ''
            }`}
            style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: r.state === 'todo' ? 'transparent' : tint + '26',
                borderWidth: r.state === 'todo' ? 1.5 : 0,
                borderColor: colors.border,
              }}
            >
              {r.state === 'done' ? (
                <Icon name="check" size={18} color={tint} />
              ) : r.state === 'blocked' ? (
                <Icon name="lock-alert-outline" size={18} color={tint} />
              ) : (
                <Text variant="caption" color={tint} style={{ fontFamily: fonts.bold }}>
                  {i + 1}
                </Text>
              )}
            </View>
            <View style={{ flex: 1 }}>
              <Text
                variant={r.state === 'current' ? 'bodyStrong' : 'body'}
                muted={r.state === 'todo' || r.state === 'done'}
              >
                {r.label}
              </Text>
              {r.hint && r.state !== 'done' ? (
                <Text
                  variant="caption"
                  muted={r.state !== 'blocked'}
                  color={r.state === 'blocked' ? dangerText : undefined}
                >
                  {r.hint}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

export default function Delivery() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, palette, spacing } = useTheme();
  const dangerText = useDangerText();
  const scroll = useRef<ScrollView>(null);
  const q = useDeliveries();
  const move = useMove();
  const collect = useCollectCash();
  const tracking = useTracking();
  const [failing, setFailing] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const order: OrderDTO | undefined = q.data?.find((o) => o.id === id);

  // Un aviso nuevo (p. ej. "primero cobra") se muestra arriba: que no quede fuera de pantalla.
  useEffect(() => {
    if (error) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [error]);

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
  const step = deliveryStep(order);
  const slot = order.slotStart && order.slotEnd ? slotLabel(order.slotStart, order.slotEnd) : null;
  const run = async (fn: () => Promise<unknown>, ok?: () => void) => {
    setError(null);
    try {
      await fn();
      success();
      ok?.();
    } catch (e) {
      const failure = classifyPinError(e);
      // El pedido exige PIN y la pantalla aún no lo sabía: se pide ahora.
      if (failure.kind === 'required') setPinOpen(true);
      else setError(failure.message || errorMessage(e));
    }
  };
  const busy = move.isPending || collect.isPending || departing;

  /** Sale a entregar. La primera vez explica y pide la ubicación; si no la dan, sale igual. */
  const depart = async () => {
    setDeparting(true);
    try {
      await tracking.askBeforeDeparture();
      await run(() => move.mutateAsync({ id: order.id, to: 'out_for_delivery' }));
    } finally {
      setDeparting(false);
    }
  };

  /** Manda el PIN. null = entregado; si no, el fallo para explicarlo en la hoja. */
  const submitPin = async (pin: string): Promise<PinFailure | null> => {
    try {
      await move.mutateAsync({ id: order.id, to: 'delivered', pin });
      success();
      setPinOpen(false);
      goToList();
      return null;
    } catch (e) {
      const failure = classifyPinError(e);
      if (failure.kind === 'cash_not_collected') {
        // El orden manda: primero se cobra. Se cierra la hoja y se vuelve al paso de cobrar.
        setPinOpen(false);
        setError(failure.message);
      }
      return failure;
    }
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <ScrollView
        ref={scroll}
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.md,
          paddingBottom: spacing.xxl * 2,
        }}
        showsVerticalScrollIndicator={false}
      >
        <Header title={order.code} />

        {error ? (
          <Card style={{ borderColor: palette.danger }}>
            <Text color={dangerText} variant="bodyStrong" testID="driver-error">
              {error}
            </Text>
          </Card>
        ) : null}

        {step === 'locked' ? (
          <Card style={{ borderColor: palette.danger, gap: 10 }}>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Icon name="lock-alert-outline" size={24} color={palette.danger} />
              <Text variant="heading" style={{ flex: 1 }}>
                Entrega bloqueada por el PIN
              </Text>
            </View>
            <Text testID="pin-locked-notice">
              Se acabaron los {PIN_MAX_ATTEMPTS} intentos. Pídele al administrador que autorice la
              entrega; no se puede cerrar desde aquí.
            </Text>
            {ADMIN_CONTACT_PHONE ? (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Action
                  icon="phone"
                  label="Llamar al administrador"
                  url={`tel:+${ADMIN_CONTACT_PHONE}`}
                  testID="admin-call"
                />
                <Action
                  icon="whatsapp"
                  label="WhatsApp"
                  url={whatsappUrl(ADMIN_CONTACT_PHONE)}
                  testID="admin-whatsapp"
                />
              </View>
            ) : null}
          </Card>
        ) : null}

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

        {order.status === 'out_for_delivery' ? <StepsCard order={order} step={step} /> : null}

        {order.status !== 'out_for_delivery' && order.pinRequired ? (
          <Card style={{ gap: 6, flexDirection: 'row', alignItems: 'center' }}>
            <Icon name="lock-outline" size={22} color={colors.glow} />
            <Text style={{ flex: 1 }}>
              Esta entrega se cierra con el <Text variant="bodyStrong">PIN de 4 dígitos</Text> del
              cliente. Se lo pides cuando estés frente a él.
            </Text>
          </Card>
        ) : null}

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
      </ScrollView>

      <FooterBar>
        {order.status === 'packed' || order.status === 'delivery_failed' ? (
          <Button
            title={order.status === 'packed' ? 'Salir a entregar' : 'Reintentar entrega'}
            icon="truck-delivery"
            loading={busy}
            testID="act-out"
            onPress={() => void depart()}
          />
        ) : null}
        {order.status === 'out_for_delivery' ? (
          <>
            {step === 'collect' ? (
              <Button
                title={`Ya cobré ${formatDOP(due)}`}
                icon="cash"
                loading={busy}
                testID="act-collect"
                onPress={() => run(() => collect.mutateAsync({ id: order.id, amount: due }))}
              />
            ) : step === 'pin' ? (
              <Button
                title="Pedir PIN y entregar"
                icon="lock-outline"
                loading={busy}
                testID="act-delivered"
                onPress={() => {
                  setError(null);
                  setPinOpen(true);
                }}
              />
            ) : step === 'deliver' ? (
              <Button
                title="Entregado"
                icon="check-circle"
                loading={busy}
                testID="act-delivered"
                onPress={() =>
                  run(() => move.mutateAsync({ id: order.id, to: 'delivered' }), goToList)
                }
              />
            ) : null}
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

      <PinSheet
        visible={pinOpen}
        code={order.code}
        attemptsLeft={order.pinAttemptsLeft}
        onClose={() => setPinOpen(false)}
        onSubmit={submitPin}
      />

      <Sheet
        visible={failing}
        onClose={() => setFailing(false)}
        label="Motivo de la entrega fallida"
        testID="fail-sheet"
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
      </Sheet>
    </SafeAreaView>
  );
}
