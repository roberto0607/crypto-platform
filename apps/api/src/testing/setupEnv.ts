/**
 * setupEnv.ts — vitest setupFiles entry.
 *
 * Runs in every test worker BEFORE the test module imports config.ts/pool.ts,
 * so it can repoint DATABASE_URL at the dedicated *_test database. config.ts's
 * `import "dotenv/config"` does not override an already-set process.env var, so
 * setting it here wins over .env (which targets the dev DB).
 *
 * Must run before anything that imports pool.ts — keep this file's imports
 * limited to the side-effect-free resolver.
 */
import { resolveTestDatabaseUrl } from "./testDbUrl";

process.env.DATABASE_URL = resolveTestDatabaseUrl();
