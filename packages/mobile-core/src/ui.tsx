import * as Haptics from 'expo-haptics';
import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { fonts, Text, useTheme } from './theme';
import { Icon } from './Icon';

export const tap = () => {
  if (Platform.OS !== 'web') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
export const success = () => {
  if (Platform.OS !== 'web')
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
};

// ───────────── Pantalla ─────────────

interface ScreenProps {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  /** Contenido fijo al fondo (barra de acción). */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}

export function Screen({
  children,
  scroll = true,
  padded = true,
  footer,
  contentStyle,
}: ScreenProps) {
  const { colors, spacing } = useTheme();
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[
        { paddingHorizontal: padded ? spacing.lg : 0, paddingBottom: spacing.xxl },
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1, paddingHorizontal: padded ? spacing.lg : 0 }, contentStyle]}>
      {children}
    </View>
  );
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: colors.background }}
      edges={['top', 'left', 'right']}
    >
      {body}
      {footer}
    </SafeAreaView>
  );
}

/** Barra de acción fija abajo (carrito, checkout). */
export function FooterBar({ children }: { children: ReactNode }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        padding: spacing.lg,
        paddingBottom: Math.max(insets.bottom, spacing.lg),
        backgroundColor: colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        gap: spacing.sm,
      }}
    >
      {children}
    </View>
  );
}

// ───────────── Botones ─────────────

interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  icon?: Parameters<typeof Icon>[0]['name'];
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  loading,
  disabled,
  icon,
  small,
  style,
  testID,
}: ButtonProps) {
  const { colors, palette, radii } = useTheme();
  const off = disabled || loading;
  const bg =
    variant === 'primary'
      ? colors.primary
      : variant === 'danger'
        ? palette.danger
        : variant === 'secondary'
          ? colors.surfaceAlt
          : 'transparent';
  const fg =
    variant === 'primary' ? colors.onPrimary : variant === 'danger' ? '#FFFFFF' : colors.text;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: radii.pill,
          // Los botones chicos también llegan a 44 de alto (tamaño táctil mínimo).
          minHeight: small ? 44 : undefined,
          paddingVertical: small ? 10 : 15,
          paddingHorizontal: small ? 16 : 22,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 8,
          opacity: off ? 0.5 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
          borderWidth: variant === 'ghost' ? 1 : 0,
          borderColor: colors.border,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : icon ? (
        <Icon name={icon} size={small ? 17 : 20} color={fg} />
      ) : null}
      <Text variant={small ? 'bodyStrong' : 'heading'} color={fg}>
        {title}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  icon,
  onPress,
  label,
  badge,
  size = 44,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  onPress: () => void;
  label: string;
  badge?: number;
  size?: number;
}) {
  const { colors, palette } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={22} color={colors.text} />
      {badge ? (
        <View
          style={{
            position: 'absolute',
            top: -2,
            right: -2,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            paddingHorizontal: 5,
            backgroundColor: palette.coral,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text variant="caption" color="#fff" style={{ fontFamily: fonts.bold, fontSize: 11 }}>
            {badge > 99 ? '99+' : badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ───────────── Contenedores ─────────────

export function Card({
  children,
  style,
  onPress,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  testID?: string;
}) {
  const { colors, radii, spacing } = useTheme();
  const base: ViewStyle = {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  };
  if (!onPress)
    return (
      <View testID={testID} style={[base, style]}>
        {children}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [base, { opacity: pressed ? 0.9 : 1 }, style]}
    >
      {children}
    </Pressable>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  icon,
  disabled,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: ReactNode;
  disabled?: boolean;
}) {
  const { colors, radii } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 9,
        paddingHorizontal: 14,
        borderRadius: radii.pill,
        backgroundColor: selected ? colors.primary : colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: selected ? colors.primary : colors.border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {icon}
      <Text variant="bodyStrong" color={selected ? colors.onPrimary : colors.text}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({
  label,
  tone = 'info',
}: {
  label: string;
  tone?: 'info' | 'success' | 'warning' | 'danger';
}) {
  const { palette } = useTheme();
  const color = {
    info: palette.cyan,
    success: palette.success,
    warning: palette.warning,
    danger: palette.danger,
  }[tone];
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 999,
        backgroundColor: color + '26',
      }}
    >
      <Text variant="caption" color={color} style={{ fontFamily: fonts.bold }}>
        {label}
      </Text>
    </View>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: spacing.xl,
        marginBottom: spacing.md,
      }}
    >
      <Text variant="title">{title}</Text>
      {action ? (
        <Pressable onPress={onAction} accessibilityRole="link" hitSlop={10}>
          <Text variant="bodyStrong" color={colors.accent}>
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return (
    <View
      style={{
        height: StyleSheet.hairlineWidth,
        backgroundColor: colors.border,
        marginVertical: 12,
      }}
    />
  );
}

export function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text variant={strong ? 'heading' : 'body'} muted={muted}>
        {label}
      </Text>
      <Text variant={strong ? 'heading' : 'bodyStrong'} muted={muted}>
        {value}
      </Text>
    </View>
  );
}

// ───────────── Estados ─────────────

export function Skeleton({
  height,
  width,
  radius = 16,
  style,
}: {
  height: number;
  width?: number | `${number}%`;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const native = Platform.OS !== 'web';
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: native }),
        Animated.timing(pulse, { toValue: 0.4, duration: 800, useNativeDriver: native }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      style={[
        {
          height,
          width: width ?? '100%',
          borderRadius: radius,
          backgroundColor: colors.surfaceAlt,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

export function EmptyState({
  icon,
  title,
  text,
  action,
  onAction,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  text?: string;
  action?: string;
  onAction?: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        paddingVertical: spacing.xxl * 1.5,
        paddingHorizontal: spacing.xl,
        gap: spacing.md,
      }}
    >
      <View
        style={{
          width: 84,
          height: 84,
          borderRadius: 42,
          backgroundColor: colors.surfaceAlt,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name={icon} size={38} color={colors.glow} />
      </View>
      <Text variant="title" center>
        {title}
      </Text>
      {text ? (
        <Text muted center>
          {text}
        </Text>
      ) : null}
      {action ? (
        <Button title={action} onPress={onAction} style={{ marginTop: spacing.sm }} />
      ) : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      icon="alert-circle-outline"
      title="Ups"
      text={message}
      action={onRetry ? 'Reintentar' : undefined}
      onAction={onRetry}
    />
  );
}

// ───────────── Campos ─────────────

interface FieldProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string | null;
  prefix?: string;
  hint?: string;
}

export const TextField = forwardRef<TextInput, FieldProps>(function TextField(
  { label, error, prefix, hint, multiline, ...rest },
  ref,
) {
  const { colors, palette, radii } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {label ? (
        <Text variant="label" muted>
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          backgroundColor: colors.surface,
          borderRadius: radii.md,
          borderWidth: 1.5,
          borderColor: error ? palette.danger : focused ? colors.glow : colors.border,
          paddingHorizontal: 14,
        }}
      >
        {prefix ? (
          <Text variant="bodyStrong" muted style={{ marginRight: 8 }}>
            {prefix}
          </Text>
        ) : null}
        <TextInput
          ref={ref}
          placeholderTextColor={colors.textMuted}
          multiline={multiline}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          accessibilityLabel={label}
          style={{
            flex: 1,
            color: colors.text,
            fontFamily: fonts.medium,
            fontSize: 16,
            paddingVertical: 14,
            minHeight: multiline ? 84 : undefined,
            textAlignVertical: multiline ? 'top' : 'center',
            ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null),
          }}
          {...rest}
        />
      </View>
      {error ? (
        <Text variant="caption" color={palette.danger}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" muted>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});
