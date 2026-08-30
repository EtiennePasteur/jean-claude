import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // CLI et non librairie : pas de `.d.ts` à publier.
  dts: false,
  clean: true,
  outDir: 'dist',
});
