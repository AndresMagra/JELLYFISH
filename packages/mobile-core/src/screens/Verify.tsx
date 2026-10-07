import { formatDominicanPhone } from '@jellyfish/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '../api';
import { useRequestOtp, useVerifyOtp } from '../auth-hooks';
import { Header } from '../Header';
import { Button, success } from '../ui';
import { useSession } from '../session';
import { fonts, Text, useTheme } from '../theme';

const RESEND_SECONDS = 30;

export function VerifyScreen() {
  const { colors, palette, spacing, radii } = useTheme();
  const { phone, next } = useLocalSearchParams<{ phone: string; next?: string }>();
  const [code, setCode] = useState('');
  const [seconds, setSeconds] = useState(RESEND_SECONDS);
  const verify = useVerifyOtp();
  const resend = useRequestOtp();
  const input = useRef<TextInput>(null);
  const submitted = useRef('');

  useEffect(() => {
    if (seconds <= 0) return;
    const t = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [seconds]);

  const submit = async (value: string) => {
    if (value.length !== 6 || !phone || submitted.current === value) return;
    submitted.current = value;
    try {
      const res = await verify.mutateAsync({ phone, code: value });
      await useSession.getState().signIn(res.token, res.user);
      success();
      router.dismissAll();
      router.replace((next || '/') as never);
    } catch {
      submitted.current = '';
      setCode('');
      input.current?.focus();
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, padding: spacing.lg }}
      >
        <Header title="" />
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: 6 }}>
            <Text variant="display">Escribe tu código</Text>
            <Text muted>
              Lo enviamos al{' '}
              <Text variant="bodyStrong">{phone ? formatDominicanPhone(phone) : ''}</Text>
            </Text>
          </View>

          <View>
            {/* Una sola entrada real (autocompletado de SMS) dibujada como 6 casillas. */}
            <TextInput
              ref={input}
              value={code}
              onChangeText={(t) => {
                const d = t.replace(/\D/g, '').slice(0, 6);
                setCode(d);
                if (verify.isError) verify.reset();
                void submit(d);
              }}
              autoFocus
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              maxLength={6}
              accessibilityLabel="Código de verificación"
              testID="otp-input"
              style={{
                position: 'absolute',
                opacity: 0.02,
                width: '100%',
                height: 64,
                zIndex: 2,
                color: 'transparent',
              }}
            />
            <View
              style={{ flexDirection: 'row', gap: 10, justifyContent: 'space-between' }}
              pointerEvents="none"
            >
              {Array.from({ length: 6 }, (_, i) => {
                const active = i === code.length;
                return (
                  <View
                    key={i}
                    style={{
                      flex: 1,
                      height: 64,
                      borderRadius: radii.md,
                      backgroundColor: colors.surface,
                      borderWidth: 1.5,
                      borderColor: verify.isError
                        ? palette.danger
                        : active
                          ? colors.glow
                          : colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontFamily: fonts.display, fontSize: 26 }}>{code[i] ?? ''}</Text>
                  </View>
                );
              })}
            </View>
          </View>

          {verify.isError ? (
            <Text variant="caption" color={palette.danger}>
              {errorMessage(verify.error)}
            </Text>
          ) : null}

          <Button
            title="Verificar"
            onPress={() => void submit(code)}
            loading={verify.isPending}
            disabled={code.length !== 6}
            testID="verify-code"
          />

          <Button
            variant="ghost"
            title={seconds > 0 ? `Reenviar código en ${seconds} s` : 'Reenviar código'}
            disabled={seconds > 0}
            loading={resend.isPending}
            onPress={async () => {
              if (!phone) return;
              try {
                await resend.mutateAsync(phone);
                submitted.current = '';
                setSeconds(RESEND_SECONDS);
              } catch {
                /* se muestra abajo */
              }
            }}
          />
          {resend.isError ? (
            <Text variant="caption" color={palette.danger}>
              {errorMessage(resend.error)}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
