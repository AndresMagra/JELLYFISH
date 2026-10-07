import { Button, Icon, Text, fonts, useTheme } from '@jellyfish/mobile-core';
import * as Linking from 'expo-linking';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, TextInput, View } from 'react-native';
import { ADMIN_CONTACT_PHONE } from './config';
import { whatsappUrl } from './due';
import {
  PIN_LENGTH,
  PIN_MAX_ATTEMPTS,
  type PinFailure,
  LOCKED_MESSAGE,
  attemptsText,
  isCompletePin,
  sanitizePin,
} from './pin';
import { useDangerText } from './colors';
import { Sheet } from './Sheet';

/** Puntos que muestran cuántos intentos le quedan al repartidor (llenos = disponibles). */
function AttemptDots({ left }: { left: number }) {
  const { colors, palette } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={attemptsText(left)}
      style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}
    >
      {Array.from({ length: PIN_MAX_ATTEMPTS }, (_, i) => (
        <View
          key={i}
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: i < left ? (left <= 1 ? palette.danger : colors.glow) : colors.border,
          }}
        />
      ))}
    </View>
  );
}

/**
 * Hoja para pedir el PIN de 4 dígitos del cliente. `onSubmit` manda el PIN al API y devuelve null
 * si se entregó (la pantalla cierra la hoja) o el fallo para explicarlo aquí mismo.
 * testIDs: pin-input, pin-confirm, pin-error (y pin-locked cuando se agotan los intentos).
 */
export function PinSheet({
  visible,
  code,
  attemptsLeft,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  code: string;
  /** Intentos que quedan según el pedido (null si aún no se sabe). */
  attemptsLeft: number | null;
  onClose: () => void;
  onSubmit: (pin: string) => Promise<PinFailure | null>;
}) {
  const { colors, palette, radii } = useTheme();
  const dangerText = useDangerText();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<PinFailure | null>(null);
  const input = useRef<TextInput>(null);
  const shake = useRef(new Animated.Value(0)).current;

  // Cada vez que se abre: campo limpio y sin errores viejos.
  useEffect(() => {
    if (visible) {
      setPin('');
      setFailure(null);
      setBusy(false);
    }
  }, [visible]);

  const locked = failure?.kind === 'locked' || attemptsLeft === 0;
  const left =
    failure?.kind === 'incorrect' && failure.attemptsLeft !== null
      ? failure.attemptsLeft
      : attemptsLeft;

  const wobble = () => {
    const native = Platform.OS !== 'web';
    Animated.sequence(
      [-10, 10, -8, 8, 0].map((toValue) =>
        Animated.timing(shake, { toValue, duration: 50, useNativeDriver: native }),
      ),
    ).start();
  };

  const submit = async () => {
    if (busy || !isCompletePin(pin)) return;
    setBusy(true);
    setFailure(null);
    const result = await onSubmit(pin);
    setBusy(false);
    if (!result) return; // entregado: la pantalla cierra la hoja
    setFailure(result);
    if (result.kind === 'incorrect') {
      setPin('');
      wobble();
      input.current?.focus();
    }
  };

  const danger = failure?.kind === 'incorrect';
  const adminPhone = ADMIN_CONTACT_PHONE;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      placement="top"
      label="PIN de entrega"
      testID="pin-sheet"
      dismissable={!busy}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: locked ? palette.danger + '26' : colors.surfaceAlt,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon
            name={locked ? 'lock-alert-outline' : 'lock-outline'}
            size={22}
            color={locked ? palette.danger : colors.glow}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title" numberOfLines={1}>
            {locked ? 'Pedido bloqueado' : 'PIN del cliente'}
          </Text>
          <Text variant="caption" muted>
            Pedido {code}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
          onPress={onClose}
          disabled={busy}
          hitSlop={8}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="close" size={22} color={colors.textMuted} />
        </Pressable>
      </View>

      {locked ? (
        <View testID="pin-locked" style={{ gap: 12 }}>
          <Text testID="pin-error" accessibilityLiveRegion="polite">
            {failure?.kind === 'locked' ? failure.message : LOCKED_MESSAGE}
          </Text>
          {adminPhone ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                title="Llamar"
                icon="phone"
                style={{ flex: 1 }}
                testID="pin-call-admin"
                onPress={() => void Linking.openURL(`tel:+${adminPhone}`)}
              />
              <Button
                title="WhatsApp"
                icon="whatsapp"
                variant="secondary"
                style={{ flex: 1 }}
                testID="pin-whatsapp-admin"
                onPress={() => void Linking.openURL(whatsappUrl(adminPhone))}
              />
            </View>
          ) : (
            <Text variant="caption" muted>
              Avísale al administrador por el medio que usan siempre. Con su autorización queda
              entregada.
            </Text>
          )}
          <Button title="Entendido" variant="ghost" onPress={onClose} testID="pin-close" />
        </View>
      ) : (
        <>
          <Text muted>
            Pídele al cliente los {PIN_LENGTH} dígitos de su PIN. Los ve en su app, en este pedido.
          </Text>

          <Animated.View style={{ transform: [{ translateX: shake }] }}>
            {/* Una sola entrada real (teclado numérico) dibujada como 4 casillas. */}
            <TextInput
              ref={input}
              value={pin}
              onChangeText={(t) => {
                setPin(sanitizePin(t));
                if (failure) setFailure(null);
              }}
              autoFocus
              editable={!busy}
              keyboardType="number-pad"
              inputMode="numeric"
              maxLength={PIN_LENGTH + 6}
              autoComplete="off"
              autoCorrect={false}
              importantForAutofill="no"
              accessibilityLabel="PIN de entrega del cliente"
              testID="pin-input"
              onSubmitEditing={() => void submit()}
              style={{
                position: 'absolute',
                opacity: 0.02,
                width: '100%',
                height: 68,
                zIndex: 2,
                color: 'transparent',
                ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
              }}
            />
            <View
              style={{ flexDirection: 'row', gap: 12, justifyContent: 'center' }}
              pointerEvents="none"
            >
              {Array.from({ length: PIN_LENGTH }, (_, i) => {
                const active = i === pin.length && !busy;
                return (
                  <View
                    key={i}
                    style={{
                      flex: 1,
                      maxWidth: 76,
                      height: 68,
                      borderRadius: radii.md,
                      backgroundColor: colors.surfaceAlt,
                      borderWidth: 2,
                      borderColor: danger ? palette.danger : active ? colors.glow : colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontFamily: fonts.display, fontSize: 30, lineHeight: 36 }}>
                      {pin[i] ?? ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          </Animated.View>

          <View style={{ minHeight: 40, gap: 6 }}>
            {failure ? (
              <Text
                testID="pin-error"
                variant="bodyStrong"
                color={dangerText}
                accessibilityLiveRegion="polite"
              >
                {failure.message}
              </Text>
            ) : null}
            {failure?.kind === 'incorrect' && failure.lastChance ? (
              <Text variant="caption" color={dangerText}>
                Es tu último intento: si fallas, el pedido se bloquea y necesitarás la autorización
                del administrador.
              </Text>
            ) : null}
            {left !== null && left < PIN_MAX_ATTEMPTS && !failure ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <AttemptDots left={left} />
                <Text variant="caption" muted>
                  {attemptsText(left)}
                </Text>
              </View>
            ) : null}
          </View>

          <Button
            title="Confirmar y entregar"
            icon="check-circle"
            loading={busy}
            disabled={!isCompletePin(pin)}
            onPress={() => void submit()}
            testID="pin-confirm"
          />
        </>
      )}
    </Sheet>
  );
}
