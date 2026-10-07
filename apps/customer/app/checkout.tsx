import { type PaymentMethodName, es, formatDOP } from '@jellyfish/shared';
import { Redirect, router } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  Chip,
  Divider,
  FooterBar,
  Header,
  Icon,
  Row,
  Skeleton,
  Text,
  TextField,
  dayKey,
  errorMessage,
  quantityLabel,
  slotLabel,
  success,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import {
  useAddresses,
  useCreateOrder,
  useMe,
  usePaymentMethods,
  useQuote,
  useSlots,
  useStartPayment,
  useUpdateMe,
} from '../src/api/hooks';
import { CouponField } from '../src/components/CouponField';
import { LegalCheckoutNotice } from '../src/components/LegalLinks';
import { ProductImage } from '../src/components/ProductImage';
import { randomKey, shortHash } from '../src/lib/ids';
import { openCardCheckout } from '../src/lib/pay';
import { useCart } from '../src/store/cart';

const METHODS: {
  id: PaymentMethodName;
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  text: string;
}[] = [
  {
    id: 'card',
    icon: 'credit-card-outline',
    title: es.paymentMethodLabel.card,
    text: 'Pagas ahora en la página segura del banco',
  },
  {
    id: 'cash',
    icon: 'cash',
    title: es.paymentMethodLabel.cash,
    text: 'Pagas al repartidor el monto exacto al recibir',
  },
  {
    id: 'transfer',
    icon: 'bank-transfer',
    title: es.paymentMethodLabel.transfer,
    text: 'Te damos los datos y subes tu referencia',
  },
];

const SUBSTITUTIONS = [
  { id: 'contact', label: 'Avísenme' },
  { id: 'substitute', label: 'Sustituyan' },
  { id: 'refund', label: 'Devuélvanme' },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text variant="title">{title}</Text>
      {children}
    </View>
  );
}

export default function Checkout() {
  const token = useSession((s) => s.token);
  if (!token) return <Redirect href={{ pathname: '/login', params: { next: '/checkout' } }} />;
  return <CheckoutInner />;
}

function CheckoutInner() {
  const { colors, palette, spacing, radii } = useTheme();
  const lines = useCart((s) => s.lines);
  const clear = useCart((s) => s.clear);
  const me = useMe();
  const updateMe = useUpdateMe();
  const addresses = useAddresses();
  const slots = useSlots();
  const methods = usePaymentMethods();
  const createOrder = useCreateOrder();
  const startPayment = useStartPayment();

  const [addressId, setAddressId] = useState<string | undefined>();
  const [slotStart, setSlotStart] = useState<string | undefined>();
  const [day, setDay] = useState<string | undefined>();
  const [method, setMethod] = useState<PaymentMethodName>('cash');
  const [substitution, setSubstitution] = useState<'contact' | 'substitute' | 'refund'>('contact');
  const [notes, setNotes] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);
  /** Código de cupón que se manda a cotizar (el servidor dice si sirve). */
  const [couponCode, setCouponCode] = useState<string | undefined>();
  const attempt = useRef(randomKey('co')).current;

  const list = addresses.data ?? [];
  const address = list.find((a) => a.id === addressId) ?? list.find((a) => a.isDefault) ?? list[0];

  const items = lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
  const quote = useQuote(
    {
      items,
      address: address ? { sector: address.sector, city: address.city } : undefined,
      couponCode,
    },
    { keepPrevious: true },
  );
  const q = quote.data;
  // Solo un cupón que el servidor aceptó viaja con el pedido (con uno malo, el pedido se rechazaría).
  const coupon = q?.coupon ?? null;
  const couponError = q?.couponError ?? null;

  const allSlots = slots.data ?? [];
  const days = useMemo(() => [...new Set(allSlots.map((s) => dayKey(s.start)))], [allSlots]);
  const activeDay =
    day ?? days.find((d) => allSlots.some((s) => dayKey(s.start) === d && s.available)) ?? days[0];
  const daySlots = allSlots.filter((s) => dayKey(s.start) === activeDay);

  const needsName = !(me.data?.name || useSession.getState().user?.name);
  const available = methods.data;
  const methodOk = (m: PaymentMethodName) => (available ? available[m].available : m === 'cash');

  const ready =
    !!address &&
    !!slotStart &&
    !!q &&
    !quote.error &&
    q.coverage === 'covered' &&
    q.missingForMinimum === 0 &&
    !quote.isPlaceholderData &&
    methodOk(method) &&
    (!needsName || name.trim().length >= 2);

  const placeOrder = async () => {
    if (!address || !slotStart || !ready) return;
    setError(null);
    try {
      if (needsName) await updateMe.mutateAsync({ name: name.trim() });
      // La clave cambia si cambia el contenido del pedido; un reintento idéntico no lo duplica.
      const idempotencyKey = `${attempt}-${shortHash(JSON.stringify([items, slotStart, method, address.id, substitution, notes, coupon?.code ?? null]))}`;
      const order = await createOrder.mutateAsync({
        items,
        addressId: address.id,
        slotStart,
        paymentMethod: method,
        substitutionPolicy: substitution,
        notes: notes.trim() || undefined,
        ...(coupon ? { couponCode: coupon.code } : null),
        idempotencyKey,
      });
      setPlaced(true); // evita la redirección "carrito vacío" mientras navegamos al pedido
      clear(); // el pedido ya existe y reservó los productos
      success();
      router.replace({ pathname: '/order/[id]', params: { id: order.id } });
      if (method === 'card') {
        const pay = await startPayment.mutateAsync(order.id);
        await openCardCheckout(pay.redirectUrl);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  /** Por qué el botón de confirmar está apagado (siempre se le dice a la persona). */
  const blockedReason = !address
    ? 'Agrega una dirección de entrega'
    : q?.coverage === 'not_covered'
      ? 'Aún no entregamos en esa dirección: elige otra'
      : q && q.missingForMinimum > 0
        ? `Te faltan ${formatDOP(q.missingForMinimum)} para el pedido mínimo de tu zona`
        : !slotStart
          ? 'Elige un horario de entrega'
          : needsName && name.trim().length < 2
            ? 'Escribe tu nombre'
            : !methodOk(method)
              ? 'Ese método de pago no está disponible'
              : quote.error
                ? errorMessage(quote.error)
                : null;

  const busy = createOrder.isPending || startPayment.isPending || updateMe.isPending;

  if (lines.length === 0 && !busy && !placed) return <Redirect href="/cart" />;

  const total = q?.total ?? 0;
  const variable = lines.some((l) => l.variableWeight);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            padding: spacing.lg,
            gap: spacing.xl,
            paddingBottom: spacing.xxl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Header title="Confirmar pedido" />

          <Section title="Tu pedido">
            <Card style={{ gap: 4, padding: 12 }} testID="checkout-items">
              {lines.map((l) => (
                <View
                  key={l.variantId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingVertical: 6,
                  }}
                >
                  <ProductImage
                    category={l.category}
                    photo={l.photo}
                    frozen={false}
                    radius={12}
                    iconSize={18}
                    style={{ width: 48, height: 48 }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyStrong" numberOfLines={1}>
                      {l.name}
                      {l.variant ? ` · ${l.variant}` : ''}
                    </Text>
                    <Text variant="caption" muted>
                      {quantityLabel(l.pricingUnit, l.quantity)}
                    </Text>
                  </View>
                  <Text variant="bodyStrong">
                    {formatDOP(q?.lines.find((x) => x.variantId === l.variantId)?.net ?? 0)}
                  </Text>
                </View>
              ))}
              {lines.some((l) => l.photoIllustrative !== false) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 }}>
                  <Icon name="information-outline" size={14} color={colors.textMuted} />
                  <Text variant="caption" muted style={{ flex: 1 }}>
                    Imágenes ilustrativas: el producto real puede variar un poco.
                  </Text>
                </View>
              ) : null}
            </Card>
          </Section>

          <Section title="Dirección de entrega">
            {addresses.isLoading ? (
              <Skeleton height={80} />
            ) : (
              <>
                {list.map((a) => {
                  const selected = a.id === address?.id;
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => setAddressId(a.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                    >
                      <Card
                        style={{
                          flexDirection: 'row',
                          gap: 12,
                          borderColor: selected ? colors.glow : colors.border,
                          borderWidth: selected ? 1.5 : 0.5,
                        }}
                      >
                        <Icon
                          name={selected ? 'check-circle' : 'map-marker-outline'}
                          size={24}
                          color={selected ? colors.glow : colors.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text variant="bodyStrong">
                            {a.label} · {a.sector}
                          </Text>
                          <Text variant="caption" muted>
                            {a.line1}
                            {a.reference ? ` — ${a.reference}` : ''}
                          </Text>
                        </View>
                      </Card>
                    </Pressable>
                  );
                })}
                <Button
                  title={list.length ? 'Agregar otra dirección' : 'Agregar dirección de entrega'}
                  icon="plus"
                  variant="secondary"
                  onPress={() => router.push('/address-new')}
                  testID="add-address"
                />
              </>
            )}
            {q?.coverage === 'not_covered' ? (
              <Text variant="caption" color={palette.warning}>
                Aún no entregamos en esa dirección. Elige otra.
              </Text>
            ) : null}
          </Section>

          <Section title="¿Cuándo lo quieres?">
            {slots.isLoading ? (
              <Skeleton height={90} />
            ) : (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {days.map((d) => {
                    const first = allSlots.find((s) => dayKey(s.start) === d)!;
                    return (
                      <Chip
                        key={d}
                        label={slotLabel(first.start, first.end).day}
                        selected={d === activeDay}
                        onPress={() => {
                          setDay(d);
                          setSlotStart(undefined);
                        }}
                      />
                    );
                  })}
                </ScrollView>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {daySlots.map((s) => (
                    <Chip
                      key={s.start}
                      label={slotLabel(s.start, s.end).time}
                      selected={slotStart === s.start}
                      disabled={!s.available}
                      onPress={() => setSlotStart(s.start)}
                    />
                  ))}
                  {daySlots.length === 0 ? (
                    <Text muted>No quedan horarios para este día.</Text>
                  ) : null}
                </View>
              </>
            )}
          </Section>

          <Section title="Forma de pago">
            {METHODS.map((m) => {
              const on = methodOk(m.id);
              const selected = method === m.id;
              return (
                <Pressable
                  key={m.id}
                  disabled={!on}
                  onPress={() => setMethod(m.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: !on }}
                  testID={`pay-${m.id}`}
                >
                  <Card
                    style={{
                      flexDirection: 'row',
                      gap: 12,
                      alignItems: 'center',
                      opacity: on ? 1 : 0.45,
                      borderColor: selected ? colors.glow : colors.border,
                      borderWidth: selected ? 1.5 : 0.5,
                    }}
                  >
                    <Icon
                      name={m.icon}
                      size={26}
                      color={selected ? colors.glow : colors.textMuted}
                    />
                    <View style={{ flex: 1 }}>
                      <Text variant="bodyStrong">{m.title}</Text>
                      <Text variant="caption" muted>
                        {on ? m.text : 'No disponible por ahora'}
                      </Text>
                    </View>
                    {selected ? <Icon name="check-circle" size={22} color={colors.glow} /> : null}
                  </Card>
                </Pressable>
              );
            })}
          </Section>

          <Section title="Si falta algo">
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {SUBSTITUTIONS.map((s) => (
                <Chip
                  key={s.id}
                  label={s.label}
                  selected={substitution === s.id}
                  onPress={() => setSubstitution(s.id)}
                />
              ))}
            </View>
            <TextField
              value={notes}
              onChangeText={setNotes}
              placeholder="Notas para el pedido (opcional)"
              multiline
            />
          </Section>

          {needsName ? (
            <Section title="¿Cómo te llamas?">
              <TextField
                value={name}
                onChangeText={setName}
                placeholder="Nombre y apellido"
                autoCapitalize="words"
                testID="checkout-name"
              />
            </Section>
          ) : null}

          <CouponField
            coupon={coupon}
            sentCode={couponCode}
            error={couponError}
            busy={!!couponCode && quote.isFetching && !coupon}
            onApply={setCouponCode}
            onRemove={() => setCouponCode(undefined)}
          />

          <Card style={{ borderRadius: radii.xl }}>
            {quote.isLoading ? (
              <Skeleton height={100} />
            ) : (
              <>
                <Row label="Subtotal" value={formatDOP(q?.subtotal ?? 0)} />
                {coupon && (q?.discount ?? 0) > 0 ? (
                  <View testID="quote-discount">
                    <Row
                      label={`Descuento · ${coupon.code}`}
                      value={`− ${formatDOP(q?.discount ?? 0)}`}
                    />
                  </View>
                ) : null}
                <Row
                  label="Envío"
                  value={q ? (q.freeDelivery ? 'Gratis' : formatDOP(q.deliveryFee)) : '—'}
                />
                <Divider />
                <Row
                  label={variable ? 'Total estimado' : 'Total'}
                  value={formatDOP(total)}
                  strong
                />
                {variable ? (
                  <Text variant="caption" muted style={{ marginTop: 6 }}>
                    El total final se ajusta al peso real. Si pesa más, no pagas de más por encima
                    de {formatDOP(q?.authorizedAmount ?? total)}.
                  </Text>
                ) : null}
              </>
            )}
          </Card>

          {error ? (
            <Card style={{ borderColor: palette.danger, flexDirection: 'row', gap: 10 }}>
              <Icon name="alert-circle-outline" size={22} color={palette.danger} />
              <Text style={{ flex: 1 }}>{error}</Text>
            </Card>
          ) : null}
        </ScrollView>

        <FooterBar>
          <Button
            title={
              method === 'card'
                ? `Pagar ${formatDOP(total)}`
                : `Confirmar pedido · ${formatDOP(total)}`
            }
            onPress={placeOrder}
            loading={busy}
            disabled={!ready}
            testID="place-order"
          />
          {!ready && !busy && blockedReason ? (
            <Text variant="caption" muted center testID="blocked-reason">
              {blockedReason}
            </Text>
          ) : null}
          <LegalCheckoutNotice />
        </FooterBar>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
