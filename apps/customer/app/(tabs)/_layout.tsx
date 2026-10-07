import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { Platform, StyleSheet } from 'react-native';
import { Icon, fonts, useTheme } from '@jellyfish/mobile-core';
import { selectCount, useCart } from '../../src/store/cart';

type IconName = Parameters<typeof Icon>[0]['name'];

type TabOptions = NonNullable<ComponentProps<typeof Tabs.Screen>['options']>;

const TAB = (title: string, icon: IconName, iconActive: IconName): TabOptions => ({
  title,
  tabBarIcon: ({ color, focused }) => (
    <Icon name={focused ? iconActive : icon} size={25} color={String(color)} />
  ),
});

export default function TabsLayout() {
  const { colors } = useTheme();
  const count = useCart(selectCount);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.glow,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: Platform.OS === 'web' ? 64 : undefined,
        },
        tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 11 },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen name="index" options={TAB('Inicio', 'home-outline', 'home')} />
      <Tabs.Screen name="search" options={TAB('Buscar', 'magnify', 'magnify')} />
      <Tabs.Screen
        name="cart"
        options={{
          ...TAB('Carrito', 'cart-outline', 'cart'),
          tabBarBadge: count > 0 ? count : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.accent,
            color: '#fff',
            fontFamily: fonts.bold,
          },
        }}
      />
      <Tabs.Screen name="orders" options={TAB('Pedidos', 'receipt-text', 'receipt-text')} />
      <Tabs.Screen name="profile" options={TAB('Perfil', 'account-outline', 'account')} />
    </Tabs>
  );
}
