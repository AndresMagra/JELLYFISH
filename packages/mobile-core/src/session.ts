import type { UserDTO } from '@jellyfish/shared';
import { create } from 'zustand';
import { configureApi } from './api';
import { queryClient } from './query-client';
import { secureStorage } from './storage';

const TOKEN_KEY = 'jellyfish.token';

interface SessionState {
  token: string | null;
  user: UserDTO | null;
  /** Ya se leyó el almacenamiento seguro (evita parpadeos de "sin sesión"). */
  hydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (token: string, user: UserDTO) => Promise<void>;
  setUser: (user: UserDTO) => void;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  token: null,
  user: null,
  hydrated: false,
  hydrate: async () => {
    const token = await secureStorage.get(TOKEN_KEY);
    set({ token, hydrated: true });
  },
  signIn: async (token, user) => {
    await secureStorage.set(TOKEN_KEY, token);
    set({ token, user });
  },
  setUser: (user) => set({ user }),
  signOut: async () => {
    await secureStorage.remove(TOKEN_KEY);
    // Nadie debe ver pedidos ni direcciones de la sesión anterior.
    queryClient.clear();
    set({ token: null, user: null });
  },
}));

/** Cada app la llama una vez al arrancar con la URL de su API. */
export function configureApp(opts: { apiUrl: string }) {
  configureApi({
    baseUrl: opts.apiUrl,
    getToken: () => useSession.getState().token,
    onUnauthorized: () => {
      void useSession.getState().signOut();
    },
  });
}
