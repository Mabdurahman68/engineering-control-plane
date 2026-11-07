import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // The real-process suites contend for CPU, and a starved one times out for no reason of its own.
    maxWorkers: 4,
  },
});
