import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    setupFiles: ['tests/setup/load-env.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // All integration tests share ONE test database, so run their files one at a time.
          fileParallelism: false,
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
