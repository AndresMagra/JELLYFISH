import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Sora_600SemiBold, Sora_700Bold, useFonts } from '@expo-google-fonts/sora';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  ThemeProvider,
  configureApp,
  queryClient,
  useSession,
  useTheme,
} from '@jellyfish/mobile-core';
import { API_URL } from '../src/lib/config';

// Antes de cualquier pantalla: a qué API se conecta esta app y cómo reacciona a una sesión vencida.
configureApp({ apiUrl: API_URL });
void SplashScreen.preventAutoHideAsync();

function Shell() {
  const { colors, dark } = useTheme();
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
