import { View } from 'react-native';
import { Icon, Text, useTheme } from '@jellyfish/mobile-core';

/** Aclaración que se repite donde se ven los favoritos: no están en la cuenta, están en el teléfono. */
export function LocalFavoritesNote() {
  const { colors } = useTheme();
  return (
    <View
      testID="favorites-note"
      style={{
        flexDirection: 'row',
        gap: 10,
        alignItems: 'center',
        backgroundColor: colors.surfaceAlt,
        borderRadius: 16,
        padding: 12,
      }}
    >
      <Icon name="cellphone" size={22} color={colors.glow} />
      <Text variant="caption" style={{ flex: 1 }}>
        Tus favoritos se guardan solo en este teléfono. Si cambias de teléfono o borras la app,
        tendrás que marcarlos de nuevo.
      </Text>
    </View>
  );
}
