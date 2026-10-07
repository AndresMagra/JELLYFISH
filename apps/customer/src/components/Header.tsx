import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text, useTheme } from '../theme';
import { IconButton } from './ui';

/** Cabecera con botón de volver, para las pantallas fuera de las pestañas. */
export function Header({
  title,
  right,
  back = true,
}: {
  title?: string;
  right?: ReactNode;
  back?: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
      }}
    >
      {back ? (
        <IconButton
          icon="chevron-left"
          label="Volver"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
      ) : null}
      <Text variant="title" style={{ flex: 1 }} numberOfLines={1}>
        {title}
      </Text>
      {right}
    </View>
  );
}
