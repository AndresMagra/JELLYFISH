import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, useTheme } from './theme';
import { Button, tap } from './ui';
import { Icon, type IconName } from './Icon';

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Línea de apoyo bajo el título. */
  subtitle?: string;
  icon?: IconName;
  children?: ReactNode;
  /** Botones fijos al fondo de la hoja. */
  footer?: ReactNode;
  testID?: string;
}

/**
 * Hoja que sube desde abajo, con el tema de la app (sustituye a Alert.alert en los flujos que
 * importan). Se cierra tocando fuera, con el botón de atrás de Android o con la X.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer,
  testID,
}: SheetProps) {
  const { colors, radii, spacing, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
  }, [visible, progress]);

  if (!mounted) return null;

  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] });

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={['portrait']}
    >
      <View style={styles.root} testID={testID}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cerrar"
            onPress={onClose}
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(3,8,22,0.62)' }]}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          style={{
            transform: [{ translateY }],
            maxHeight: height * 0.88,
            backgroundColor: colors.surface,
            borderTopLeftRadius: radii.xl,
            borderTopRightRadius: radii.xl,
            borderWidth: StyleSheet.hairlineWidth,
            borderBottomWidth: 0,
            borderColor: colors.border,
            paddingTop: spacing.sm,
            // En web la hoja no debe pasar de un ancho cómodo (pantalla ancha de escritorio).
            width: '100%',
            maxWidth: 560,
            alignSelf: 'center',
            ...(Platform.OS === 'web' && !dark
              ? ({ boxShadow: '0 -10px 40px rgba(10,22,51,0.18)' } as object)
              : null),
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.border,
              marginBottom: spacing.sm,
            }}
          />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.md,
            }}
          >
            {icon ? (
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: colors.surfaceAlt,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={icon} size={24} color={colors.glow} />
              </View>
            ) : null}
            <View style={{ flex: 1, paddingTop: icon ? 0 : 2 }}>
              <Text variant="title" accessibilityRole="header">
                {title}
              </Text>
              {subtitle ? (
                <Text muted style={{ marginTop: 2 }}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cerrar"
              onPress={() => {
                tap();
                onClose();
              }}
              hitSlop={8}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                marginTop: -6,
                marginRight: -8,
                borderRadius: 22,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Icon name="close" size={22} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            contentContainerStyle={{
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.md,
              gap: spacing.sm,
            }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.sm,
                paddingBottom: Math.max(insets.bottom, spacing.lg),
                gap: spacing.sm,
              }}
            >
              {footer}
            </View>
          ) : (
            <View style={{ height: Math.max(insets.bottom, spacing.md) }} />
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** Confirmación con el tema de la app (en vez de Alert.alert o window.confirm). */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'No, volver',
  destructive,
  loading,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={title}
      icon={destructive ? 'alert-circle-outline' : 'help-circle-outline'}
      footer={
        <>
          <Button
            title={confirmLabel}
            variant={destructive ? 'danger' : 'primary'}
            loading={loading}
            onPress={onConfirm}
            testID="confirm-sheet-yes"
          />
          <Button title={cancelLabel} variant="ghost" onPress={onClose} testID="confirm-sheet-no" />
        </>
      }
    >
      <Text muted>{message}</Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
});
