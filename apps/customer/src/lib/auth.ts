import { router } from 'expo-router';
import { useSession } from '@jellyfish/mobile-core';

/**
 * Lleva a iniciar sesión (y vuelve a `next` al terminar). Devuelve true si ya hay sesión.
 * Se puede mirar y llenar el carrito sin cuenta; solo se pide al pagar.
 */
export function requireSession(next: string): boolean {
  if (useSession.getState().token) return true;
  router.push({ pathname: '/login', params: { next } });
  return false;
}
