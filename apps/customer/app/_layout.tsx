import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Sora_600SemiBold, Sora_700Bold, useFonts } from '@expo-google-fonts/sora';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  ThemeProvider,
  configureApp,
  configureNotificationHandling,
  queryClient,
  usePushRegistration,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { API_URL } from '../src/lib/config';

// Antes de cualquier pantalla: a qué API se conecta esta app y cómo reacciona a una sesión vencida.
configureApp({ apiUrl: API_URL });
void SplashScreen.preventAutoHideAsync();

/** Tocar un aviso de pedido abre ese pedido (si ya no hay sesión, primero pide entrar). */
function openOrderFromPush(orderId: string) {
  if (!useSession.getState().token) {
    router.push({ pathname: '/login', params: { next: `/order/${orderId}` } });
    return;
  }
  router.push({ pathname: '/order/[id]', params: { id: orderId } });
}

function Shell() {
  const { colors, dark } = useTheme();
  // Con sesión, registra este teléfono para los avisos; al cerrar sesión lo da de baja solo.
  usePushRegistration();
  useEffect(() => {
    // Un aviso que abrió la app desde cero llega cuando el navegador ya está montado (Shell está dentro).
    return configureNotificationHandling({
      onOrderOpened: (orderId) => {
        try {
          openOrderFromPush(orderId);
        } catch {
          /* el navegador aún no estaba listo: la persona abre el pedido desde Pedidos */
        }
      },
    });
  }, []);
  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" options={{ presentation: 'modal' }} />
        <Stack.Screen name="verify" />
        <Stack.Screen name="address-new" options={{ presentation: 'modal' }} />
      </Stack>
    </>
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
