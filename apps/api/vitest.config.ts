import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    // Run the entire suite against a dedicated *_test database so tests never
    // truncate the dev DB. globalSetup creates+migrates it once; setupEnv
    // repoints DATABASE_URL in each worker before the pool module is imported.
    globalSetup: ["./src/testing/globalSetup.ts"],
    setupFiles: ["./src/testing/setupEnv.ts"],
    // Integration tests (*.integration.test.ts) are excluded from the default
    // suite — they spin up real containers (testcontainers) and are slow. Run
    // them via `pnpm test:integration` (vitest.integration.config.ts).
    exclude: ["dist/**", "node_modules/**", "**/*.integration.test.ts"],
  },
});
