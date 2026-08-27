import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
      reporter: ['text', 'html'],
      // Floors, not targets: set a couple of points under what the suite
      // currently reaches so an unrelated refactor does not fail CI, while a
      // meaningful drop still does.
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 85,
        lines: 93,
      },
    },
  },
});
