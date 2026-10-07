import { type QuantityRules, stepDown, stepUp } from '@jellyfish/shared';
import { Pressable, View } from 'react-native';
import { Icon, Text, quantityLabel, tap, useTheme } from '@jellyfish/mobile-core';

interface Props {
  rules: QuantityRules;
  quantity: number;
  available?: number;
  onChange: (next: number) => void;
  /** Con 0 muestra solo "+". */
  compact?: boolean;
}

/** − 2.5 lb +   (media libra por paso; por debajo del mínimo la línea se quita). */
export function QuantityStepper({ rules, quantity, available, onChange, compact }: Props) {
  const { colors, radii } = useTheme();
  const canUp = stepUp(quantity, rules, available) !== quantity;
  const btn = (name: 'plus' | 'minus', enabled: boolean, onPress: () => void, label: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={!enabled}
      onPress={() => {
        tap();
        onPress();
      }}
      hitSlop={6}
      style={({ pressed }) => ({
        width: compact ? 34 : 40,
        height: compact ? 34 : 40,
        borderRadius: radii.pill,
        backgroundColor: name === 'plus' ? colors.primary : colors.surfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: !enabled ? 0.35 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={name} size={20} color={name === 'plus' ? colors.onPrimary : colors.text} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      {quantity > 0 ? (
        <>
          {btn('minus', true, () => onChange(stepDown(quantity, rules)), 'Quitar')}
          <Text variant="bodyStrong" style={{ minWidth: 58, textAlign: 'center' }}>
            {quantityLabel(rules.pricingUnit, quantity)}
          </Text>
        </>
      ) : null}
      {btn('plus', canUp, () => onChange(stepUp(quantity, rules, available)), 'Agregar')}
    </View>
  );
}
