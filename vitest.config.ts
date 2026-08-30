import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // Les tests d'intégration montent de vrais serveurs TLS : laisser du mou.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
