import { formatDOP, type QuoteCouponDTO } from '@jellyfish/shared';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  Button,
  Card,
  Icon,
  Text,
  TextField,
  normalizeCouponCode,
  success,
  tap,
  useTheme,
} from '@jellyfish/mobile-core';

interface Props {
  /** Cupón que el servidor aceptó en la última cotización. */
  coupon: QuoteCouponDTO | null;
  /** Código que se mandó a cotizar (aceptado o no). */
  sentCode: string | undefined;
  /** Por qué el servidor no lo aceptó (en español). */
  error: string | null | undefined;
  /** Cotizando con el cupón. */
  busy: boolean;
  onApply: (code: string) => void;
  onRemove: () => void;
}

/** "¿Tienes un cupón?": escribe el código, ve el descuento o el motivo por el que no sirve. */
export function CouponField({ coupon, sentCode, error, busy, onApply, onRemove }: Props) {
  const { colors, palette } = useTheme();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  if (coupon) {
    return (
      <Card
        testID="coupon-applied"
        style={{ gap: 6, borderColor: palette.success, borderWidth: 1 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon name="ticket-percent" size={26} color={palette.success} />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">Cupón {coupon.code} aplicado</Text>
            <Text variant="caption" muted>
              {coupon.description}
              {coupon.discount > 0 ? ` · Ahorras ${formatDOP(coupon.discount)}` : ''}
            </Text>
          </View>
          <Button
            title="Quitar"
            variant="ghost"
            small
            testID="coupon-remove"
            onPress={() => {
              setText('');
              setOpen(false);
              onRemove();
            }}
          />
        </View>
      </Card>
    );
  }

  const typed = normalizeCouponCode(text);
  // El motivo solo vale para el código que se mandó; si ya escribió otro, se calla hasta aplicarlo.
  const shownError = error && sentCode && typed === sentCode ? error : null;

  if (!open) {
    return (
      <Pressable
        testID="coupon-open"
        accessibilityRole="button"
        accessibilityLabel="¿Tienes un cupón?"
        onPress={() => {
          tap();
          setOpen(true);
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 56,
          padding: 14,
          borderRadius: 20,
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: colors.border,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Icon name="ticket-percent-outline" size={24} color={colors.glow} />
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          ¿Tienes un cupón?
        </Text>
        <Icon name="chevron-down" size={22} color={colors.textMuted} />
      </Pressable>
    );
  }

  const submit = () => {
    if (!typed || busy) return;
    success();
    onApply(typed);
  };

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="ticket-percent-outline" size={22} color={colors.glow} />
        <Text variant="bodyStrong" style={{ flex: 1 }}>
          ¿Tienes un cupón?
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <TextField
            label="Código de cupón"
            value={text}
            onChangeText={setText}
            placeholder="Ej: BIENVENIDA10"
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={submit}
            error={shownError}
            testID="coupon-input"
          />
        </View>
        <Button
          title="Aplicar"
          onPress={submit}
          loading={busy}
          disabled={!typed}
          testID="coupon-apply"
          style={{ marginTop: 21 }}
        />
      </View>
    </Card>
  );
}
