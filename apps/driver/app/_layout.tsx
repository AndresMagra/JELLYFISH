import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Sora_600SemiBold, Sora_700Bold, useFonts } from '@expo-google-fonts/sora';
import {
  ThemeProvider,
  configureApp,
  configureNotificationHandling,
  queryClient,
  usePushRegistration,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, router, usePathname, useRootNavigationState } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { API_URL } from '../src/config';
import { TrackingProvider } from '../src/tracking';

configureApp({ apiUrl: API_URL });
void SplashScreen.preventAutoHideAsync();

/**
 * Tocar una notificación de pedido abre esa entrega. Si la app estaba cerrada, espera a que la
 * navegación esté lista; sin sesión no abre nada (primero hay que entrar).
 */
function NotificationRouter() {
  const token = useSession((s) => s.token);
  const ready = !!useRootNavigationState()?.key;
  const pathname = usePathname();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => configureNotificationHandling({ onOrderOpened: setPending }), []);

  useEffect(() => {
    if (!pending || !ready) return;
    setPending(null);
    if (!token || pathname === `/delivery/${pending}`) return;
    router.push({ pathname: '/delivery/[id]', params: { id: pending } });
  }, [pending, ready, token, pathname]);

  return null;
}

function Shell() {
  const { colors, dark } = useTheme();
  // Registra este teléfono para recibir avisos mientras haya sesión (y lo da de baja al salir).
  usePushRegistration();
  return (
    <TrackingProvider>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <NotificationRouter />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      />
    </TrackingProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Sora_600SemiBold,
    Sora_700Bold,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });
  const hydrated = useSession((s) => s.hydrated);

  useEffect(() => {
    void useSession.getState().hydrate();
  }, []);

  const ready = fontsLoaded && hydrated;
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
