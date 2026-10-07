import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'apps/api/test/**/*.test.ts',
      'data/catalog/**/*.test.ts',
    ],
    environment: 'node',
    // Cada PGlite nuevo tarda unos segundos en arrancar (WASM + migraciones).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
