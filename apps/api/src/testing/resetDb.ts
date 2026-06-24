import { pool } from "../db/pool";
import { runPendingMigrations } from "../db/migrate";

let migrated = false;

/** Run pending migrations once per test-runner process. */
export async function ensureMigrations(): Promise<void> {
  if (!migrated) {
    await runPendingMigrations(pool);
    migrated = true;
  }
}

/** Truncate all application tables in FK-safe order. */
export async function resetTestData(): Promise<void> {
  // Safety guard: refuse to truncate anything that isn't a dedicated *_test
  // database. This makes it impossible for a misconfigured run (e.g. tests
  // accidentally pointed at the dev DB) to wipe real data. Override with
  // ALLOW_DESTRUCTIVE_RESET=1 only if you really mean it.
  const { rows } = await pool.query<{ db: string }>("SELECT current_database() AS db");
  const db = rows[0]?.db ?? "";
  if (!/_test$/.test(db) && process.env.ALLOW_DESTRUCTIVE_RESET !== "1") {
    throw new Error(
      `resetTestData refused: current database '${db}' is not a *_test database. ` +
        `Point DATABASE_URL at a *_test DB, or set ALLOW_DESTRUCTIVE_RESET=1 to override.`,
    );
  }

  await pool.query(`
    TRUNCATE TABLE
      ledger_entries,
      trades,
      orders,
      equity_snapshots,
      positions,
      outbox_events,
      event_stream,
      strategy_signals,
      strategy_runs,
      trigger_orders,
      candles,
      idempotency_keys,
      wallets,
      refresh_tokens,
      login_attempts,
      api_keys,
      audit_log,
      users,
      trading_pairs,
      assets,
      job_runs,
      beta_invites,
      backup_metadata,
      system_flags
    CASCADE
  `);
}
