import { Icon, Text, useTheme } from '@jellyfish/mobile-core';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Hoja modal propia del tema (sin Alert.alert).
 *  - `bottom`: hoja que sube desde abajo (listas de opciones, explicaciones).
 *  - `top`: tarjeta anclada arriba, para pantallas con teclado: así el teclado nunca la tapa,
 *    sin depender de cómo cada teléfono reduce el área al abrirse.
 */
export function Sheet({
  visible,
  onClose,
  children,
  placement = 'bottom',
  dismissable = true,
  label,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  placement?: 'bottom' | 'top';
  dismissable?: boolean;
  /** Nombre accesible de la hoja. */
  label: string;
  testID?: string;
}) {
  const { colors, spacing, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const top = placement === 'top';
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={dismissable ? onClose : undefined}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, justifyContent: top ? 'flex-start' : 'flex-end' }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar"
          onPress={dismissable ? onClose : undefined}
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(2,6,18,0.68)' }]}
        />
        <View
          testID={testID}
          accessibilityViewIsModal
          accessibilityLabel={label}
          style={{
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            padding: spacing.lg,
            gap: spacing.md,
            ...(top
              ? {
                  marginTop: Math.max(insets.top, spacing.lg) + spacing.sm,
                  marginHorizontal: spacing.lg,
                  borderRadius: 28,
                }
              : {
                  paddingBottom: Math.max(insets.bottom, spacing.lg),
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                }),
            shadowColor: '#000',
            shadowOpacity: dark ? 0.5 : 0.18,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: top ? 12 : -6 },
            elevation: 16,
          }}
        >
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** Fila "icono + texto" para listas cortas dentro de una hoja. */
export function SheetPoint({
  icon,
  text,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  text: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={18} color={colors.glow} />
      </View>
      <Text style={{ flex: 1, paddingTop: 5 }}>{text}</Text>
    </View>
  );
}
