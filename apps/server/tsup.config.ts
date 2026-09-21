import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', seed: 'prisma/seed.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Native/generated packages stay external and are resolved from node_modules at runtime.
  external: ['@prisma/client'],
});
