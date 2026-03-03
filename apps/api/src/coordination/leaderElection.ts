import type { Pool, PoolClient } from "pg";
import { logger as rootLogger } from "../observability/logContext";

const logger = rootLogger.child({ module: "leaderElection" });

// ── Lock name constants ──
export const LOCK_NAMES = {
  outbox: "leader:outbox",
  reconciliation: "leader:reconciliation",
  lockSampler: "leader:lockSampler",
  migrations: "leader:migrations",
} as const;

export type LockName = (typeof LOCK_NAMES)[keyof typeof LOCK_NAMES];

/**
 * Map of currently held advisory locks.
 * Key = lock name, Value = dedicated PoolClient holding the session lock.
 *
 * Advisory locks are session-scoped: the lock stays held as long as the
 * connection is alive. If the connection drops, PG auto-releases the lock,
 * allowing another instance to acquire leadership.
 */
const heldLocks: Map<string, PoolClient> = new Map();

/**
 * Try to acquire a session-scoped advisory lock.
 * Uses a dedicated connection held for the lifetime of leadership.
 * Returns true if this instance is now the leader for `lockName`.
 */
export async function tryAcquireLeadership(
  pool: Pool,
  lockName: string,
): Promise<boolean> {
  // Already leader — idempotent
  if (heldLocks.has(lockName)) return true;

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1))",
      [lockName],
    );

    if (rows[0]?.pg_try_advisory_lock) {
      heldLocks.set(lockName, client);
      logger.info({ lockName }, "Leadership acquired");
      return true;
    }

    // Lock held by another instance
    client.release();
    return false;
  } catch (err) {
    client?.release();
    logger.error({ lockName, err }, "Failed to acquire leadership");
    return false;
  }
}

/**
 * Release a previously acquired advisory lock.
 * Unlocks and returns the dedicated connection to the pool.
 */
export async function releaseLeadership(
  _pool: Pool,
  lockName: string,
): Promise<void> {
  const client = heldLocks.get(lockName);
  if (!client) return;

  heldLocks.delete(lockName);

  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]);
  } catch {
    // Connection may already be dead — lock auto-released by PG
  }
  try {
    client.release();
  } catch {
    // Ignore release errors
  }

  logger.info({ lockName }, "Leadership released");
}

/**
 * Acquire leadership, run `fn`, then release.
 * Returns true if leadership was acquired and fn executed.
 */
export async function withLeadership(
  pool: Pool,
  lockName: string,
  fn: () => Promise<void>,
): Promise<boolean> {
  const acquired = await tryAcquireLeadership(pool, lockName);
  if (!acquired) return false;

  try {
    await fn();
  } finally {
    await releaseLeadership(pool, lockName);
  }
  return true;
}

/**
 * Release all held locks — called during graceful shutdown.
 */
export async function releaseAllLeadership(): Promise<void> {
  const lockNames = [...heldLocks.keys()];
  if (lockNames.length === 0) return;

  logger.info({ locks: lockNames }, "Releasing all leadership locks");

  for (const lockName of lockNames) {
    await releaseLeadership(undefined as unknown as Pool, lockName);
  }
}

/**
 * Check if this instance currently holds a specific lock.
 */
export function isLeader(lockName: string): boolean {
  return heldLocks.has(lockName);
}

/**
 * Get leadership status for all known locks.
 * Used by /health/instance endpoint.
 */
export function getLeadershipStatus(): Record<string, boolean> {
  return {
    outbox: heldLocks.has(LOCK_NAMES.outbox),
    reconciliation: heldLocks.has(LOCK_NAMES.reconciliation),
    lockSampler: heldLocks.has(LOCK_NAMES.lockSampler),
  };
}
