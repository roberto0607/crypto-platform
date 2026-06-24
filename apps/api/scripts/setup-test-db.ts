/**
 * setup-test-db.ts — create + migrate the dedicated *_test database on demand.
 *
 * The test suite already does this automatically via vitest globalSetup; this
 * script exposes the same step for manual use (`pnpm test:db:setup`).
 */
import globalSetup from "../src/testing/globalSetup";
import { resolveTestDatabaseUrl } from "../src/testing/testDbUrl";

globalSetup()
  .then(() => {
    console.log(`Test DB ready: ${resolveTestDatabaseUrl()}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("Test DB setup failed:", err);
    process.exit(1);
  });
