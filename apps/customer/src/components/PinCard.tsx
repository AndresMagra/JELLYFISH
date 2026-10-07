import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Icon, Text, fonts, success, tap, useTheme } from '@jellyfish/mobile-core';

/**
 * "Tu PIN de entrega": 4 dígitos grandes que el cliente le dice al repartidor al recibir.
 * Solo se muestra mientras el pedido lo necesita (el servidor lo manda únicamente entonces).
 */
export function PinCard({ pin, attemptsLeft }: { pin: string; attemptsLeft?: number | null }) {
  const { palette } = useTheme();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const t = setTimeout(() => setState('idle'), 2200);
    return () => clearTimeout(t);
  }, [state]);

  const copy = async () => {
    tap();
    try {
      await Clipboard.setStringAsync(pin);
      success();
      setState('copied');
    } catch {
      setState('failed');
    }
  };

  const digits = pin.split('');
  return (
    <LinearGradient
      colors={[palette.tide, palette.deep, palette.abyss]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      testID="pin-card"
      style={{ borderRadius: 28, padding: 20, overflow: 'hidden', gap: 14 }}
    >
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: -40,
          top: -44,
          width: 160,
          height: 160,
          borderRadius: 80,
          backgroundColor: palette.cyan,
          opacity: 0.12,
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="shield-lock-outline" size={20} color={palette.cyanSoft} />
        <Text variant="label" color={palette.cyanSoft}>
          Tu PIN de entrega
        </Text>
      </View>

      <View
        accessible
        accessibilityLabel={`Tu PIN de entrega: ${digits.join(' ')}`}
        style={{ flexDirection: 'row', gap: 10 }}
      >
        {digits.map((d, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              maxWidth: 76,
              height: 76,
              borderRadius: 18,
              backgroundColor: 'rgba(255,255,255,0.10)',
              borderWidth: 1,
              borderColor: 'rgba(165,243,252,0.35)',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text
              testID={i === 0 ? 'pin-digits' : undefined}
              style={{ fontFamily: fonts.display, fontSize: 40, lineHeight: 48 }}
              color="#FFFFFF"
              {...(Platform.OS === 'web' ? { selectable: true } : null)}
            >
              {d}
            </Text>
          </View>
        ))}
      </View>

      <Text color={palette.frost}>
        Dáselo al repartidor cuando te llegue el pedido. No lo compartas por mensaje.
      </Text>

      {attemptsLeft !== null && attemptsLeft !== undefined && attemptsLeft < 5 ? (
        <View
          testID="pin-attempts"
          style={{
            flexDirection: 'row',
            gap: 8,
            alignItems: 'flex-start',
            padding: 10,
            borderRadius: 14,
            backgroundColor: 'rgba(245,158,11,0.16)',
          }}
        >
          <Icon name="alert-outline" size={18} color={palette.warning} />
          <Text variant="caption" color="#FFE3A3" style={{ flex: 1 }}>
            {attemptsLeft === 0
              ? 'El PIN se bloqueó por intentos equivocados. Nuestro equipo te ayudará a cerrar la entrega.'
              : `Alguien probó un PIN equivocado. Quedan ${attemptsLeft} ${attemptsLeft === 1 ? 'intento' : 'intentos'}. Díselo solo a quien te entrega el pedido.`}
          </Text>
        </View>
      ) : null}

      <Pressable
        testID="pin-copy"
        accessibilityRole="button"
        accessibilityLabel={state === 'copied' ? 'PIN copiado' : 'Copiar PIN'}
        onPress={copy}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingHorizontal: 16,
          borderRadius: 999,
          backgroundColor: state === 'copied' ? palette.success : 'rgba(255,255,255,0.14)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.25)',
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <Icon name={state === 'copied' ? 'check' : 'content-copy'} size={18} color="#FFFFFF" />
        <Text variant="bodyStrong" color="#FFFFFF">
          {state === 'copied'
            ? 'PIN copiado'
            : state === 'failed'
              ? 'No se pudo copiar'
              : 'Copiar PIN'}
        </Text>
      </Pressable>
    </LinearGradient>
  );
}
