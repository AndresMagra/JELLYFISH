import { normalizeDominicanPhone } from '@jellyfish/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../api';
import { useRequestOtp } from '../auth-hooks';
import { Header } from '../Header';
import { Icon } from '../Icon';
import { Button, TextField } from '../ui';
import { Text, useTheme } from '../theme';

export function LoginScreen() {
  const { colors, spacing } = useTheme();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [phone, setPhone] = useState('');
  const [touched, setTouched] = useState(false);
  const request = useRequestOtp();

  const e164 = normalizeDominicanPhone(phone);
  const invalid = touched && !e164;

  const submit = async () => {
    setTouched(true);
    if (!e164) return;
    try {
      await request.mutateAsync(e164);
      router.push({ pathname: '/verify', params: { phone: e164, next: next ?? '/' } });
    } catch {
      /* el error se muestra abajo */
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, padding: spacing.lg }}
      >
        <Header title="" />
        <View style={{ gap: spacing.lg, flex: 1 }}>
          <View
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              backgroundColor: colors.surfaceAlt,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="jellyfish" size={42} color={colors.glow} />
          </View>
          <View style={{ gap: 6 }}>
            <Text variant="display">Entra a JELLYFISH</Text>
            <Text muted>
              Usa tu número de celular dominicano. Te enviaremos un código de 6 dígitos.
            </Text>
          </View>
          <TextField
            label="Celular"
            prefix="+1"
            value={phone}
            onChangeText={(t) => {
              setPhone(t);
              if (request.isError) request.reset();
            }}
            keyboardType="phone-pad"
            placeholder="809 555 1234"
            autoComplete="tel"
            textContentType="telephoneNumber"
            maxLength={16}
            error={
              invalid
                ? 'Ingresa un número dominicano (809, 829 o 849)'
                : request.isError
                  ? errorMessage(request.error)
                  : null
            }
            onSubmitEditing={submit}
            testID="phone-input"
          />
          <Button
            title="Enviarme el código"
            onPress={submit}
            loading={request.isPending}
            testID="send-code"
          />
          <Text variant="caption" muted center>
            Al continuar aceptas recibir un SMS con tu código. Pueden aplicar tarifas de tu
            operadora.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
