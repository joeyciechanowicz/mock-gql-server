import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The runnable examples are executed too, so documented usage cannot rot.
    include: ['test/**/*.spec.ts', 'example/**/*.test.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
    environment: 'node',
    testTimeout: 15000,
  },
});
