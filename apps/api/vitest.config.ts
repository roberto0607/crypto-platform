import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // Integration tests (*.integration.test.ts) are excluded from the default
    // suite — they spin up real containers (testcontainers) and are slow. Run
    // them via `pnpm test:integration` (vitest.integration.config.ts).
    exclude: ["dist/**", "node_modules/**", "**/*.integration.test.ts"],
  },
});
