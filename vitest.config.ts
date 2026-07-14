import { defineConfig, defineProject } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      defineProject({
        // Unit tests: pure functions only, no network, no Penpot account needed.
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      }),
      defineProject({
        // Integration tests: exercise the real Penpot RPC API against the account
        // configured via PENPOT_BASE_URL/PENPOT_ACCESS_TOKEN in .env. Each test file
        // creates its own scratch project and deletes it in an afterEach/afterAll,
        // even on failure (see test/integration/helpers/scratch-project.ts). Run
        // serially — tests share one Penpot team and concurrent scratch-project
        // churn makes failures harder to attribute.
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/integration/**/*.test.ts'],
          setupFiles: ['./test/integration/helpers/env-loader.ts'],
          testTimeout: 30_000,
          sequence: { concurrent: false },
          pool: 'forks',
          singleFork: true,
        },
      }),
    ],
  },
})
