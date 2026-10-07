import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { APP_SCHEME } from './config';

/**
 * Abre la página de pago de la pasarela y espera a que termine.
 * En el teléfono usa un navegador seguro del sistema que vuelve a la app con `jellyfish://`;
 * en la web (solo desarrollo) abre otra pestaña y el pedido se actualiza solo.
 */
export async function openCardCheckout(redirectUrl: string): Promise<void> {
  if (Platform.OS === 'web') {
    // Nueva pestaña: la actual sigue consultando el pedido y se actualiza sola al aprobarse el pago.
    globalThis.open?.(redirectUrl, '_blank', 'noopener');
    return;
  }
  await WebBrowser.openAuthSessionAsync(redirectUrl, `${APP_SCHEME}://`);
}
