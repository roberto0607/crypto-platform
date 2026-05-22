import { defineConfig } from "vitest/config";

// Config for integration tests only (*.integration.test.ts). These spin up
// real containers via testcontainers, so they're kept out of the default
// `pnpm test` run (see vitest.config.ts exclude) and invoked explicitly with
// `pnpm test:integration`. Longer hookTimeout because a cold image pull in
// beforeAll can exceed the default 30s.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
