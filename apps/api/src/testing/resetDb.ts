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
