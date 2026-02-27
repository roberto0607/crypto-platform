import "dotenv/config";
import { pool } from "../db/pool";

/*
 * Safe dev-only reset script.
 *
 * Truncates all transactional data (orders, trades, positions, etc.)
 * and resets wallet balances to zero.
 *
 * Guards:
 *   - Refuses to run if NODE_ENV === "production"
 *   - Requires --force CLI flag
 *   - Wraps all destructive ops in a single transaction
 */

async function reset(): Promise<void> {
  // ── Guard: production check ──
  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv === "production") {
    console.error("ABORT: reset.ts cannot run in production (NODE_ENV=production).");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  // ── Guard: --force flag ──
  if (!process.argv.includes("--force")) {
    console.error("ABORT: reset requires --force flag.");
    console.error("Usage: pnpm tsx src/sandbox/reset.ts --force");
    process.exitCode = 1;
    await pool.end();
    return;
  }

  const client = await pool.connect();

  try {
    console.warn("WARNING: Destructive reset — wiping dev data...");

    await client.query("BEGIN");

    // Order matters: child tables first to respect FK constraints
    // TRUNCATE ... CASCADE would also work, but explicit ordering is clearer
    await client.query("TRUNCATE trades CASCADE");
    await client.query("TRUNCATE orders CASCADE");
    await client.query("TRUNCATE positions CASCADE");
    await client.query("TRUNCATE equity_snapshots CASCADE");
    await client.query("TRUNCATE idempotency_keys CASCADE");
    await client.query("TRUNCATE replay_sessions CASCADE");
    await client.query("TRUNCATE ledger_entries CASCADE");
    await client.query("TRUNCATE circuit_breakers CASCADE");

    // Reset wallet balances to zero (wallets themselves preserved)
    await client.query("UPDATE wallets SET balance = '0.00000000', reserved = '0.00000000'");

    await client.query("COMMIT");
    console.log("Reset complete. Run seed.ts to re-populate.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reset failed, rolled back:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

reset();
