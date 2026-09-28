import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.test.ts', 'tests/compliance.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // A beforeAll that builds a fixture (tests/unit/tour-fixture.test.ts takes ~8 s alone) outran the 10 s default
    // under a full parallel run, so a fresh clone's `npm test` failed (craft review r1). Hooks get the same headroom.
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['core/**/*.ts'],
      exclude: ['core/types.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'tests/report/coverage',
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
