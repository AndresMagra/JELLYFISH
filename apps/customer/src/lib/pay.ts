import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { queryClient } from '@jellyfish/mobile-core';
import { APP_SCHEME, IS_DEMO } from './config';

/**
 * Abre la página de pago de la pasarela y espera a que termine.
 * En el teléfono usa un navegador seguro del sistema que vuelve a la app con `jellyfish://`;
 * en la web (solo desarrollo) abre otra pestaña y el pedido se actualiza solo.
 */
export async function openCardCheckout(redirectUrl: string): Promise<void> {
  if (IS_DEMO) {
    // Vista previa: no se abre ninguna pasarela. El servidor de demostración aprueba el pago solo
    // unos segundos después; aquí se espera ese momento y se refresca el pedido.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    await queryClient.invalidateQueries({ queryKey: ['order'] });
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
    return;
  }
  if (Platform.OS === 'web') {
    // Nueva pestaña: la actual sigue consultando el pedido y se actualiza sola al aprobarse el pago.
    globalThis.open?.(redirectUrl, '_blank', 'noopener');
    return;
  }
  await WebBrowser.openAuthSessionAsync(redirectUrl, `${APP_SCHEME}://`);
}
