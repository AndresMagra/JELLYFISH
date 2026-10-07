import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { plainStorage, toggleFavorite } from '@jellyfish/mobile-core';

interface FavoritesState {
  /** `group` de cada producto favorito, el más reciente primero. Solo viven en este teléfono. */
  groups: string[];
  toggle: (group: string) => void;
  clear: () => void;
}

export const useFavorites = create<FavoritesState>()(
  persist(
    (set) => ({
      groups: [],
      toggle: (group) => set((s) => ({ groups: toggleFavorite(s.groups, group) })),
      clear: () => set({ groups: [] }),
    }),
    {
      name: 'jellyfish.favorites',
      version: 1,
      storage: createJSONStorage(() => plainStorage),
    },
  ),
);

export const selectFavoriteCount = (s: FavoritesState) => s.groups.length;
