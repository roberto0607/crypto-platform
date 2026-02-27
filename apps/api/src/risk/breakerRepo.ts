import type { PoolClient } from "pg";
import type { CircuitBreakerRow } from "./riskTypes";

const BREAKER_COLUMNS = `id, breaker_key, status, opened_at, closes_at, reason, metadata, created_at, updated_at`;

/**
 * Get all OPEN breakers matching the given keys.
 * Auto-closes expired breakers (closes_at < NOW()) before returning.
 */
export async function getOpenBreakers(
  client: PoolClient,
  keys: string[],
): Promise<CircuitBreakerRow[]> {
  if (keys.length === 0) return [];

  // Auto-close expired breakers first
  await client.query(
    `UPDATE circuit_breakers
        SET status = 'CLOSED'
      WHERE status = 'OPEN'
        AND closes_at IS NOT NULL
        AND closes_at < now()`,
  );

  const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query<CircuitBreakerRow>(
    `SELECT ${BREAKER_COLUMNS}
       FROM circuit_breakers
      WHERE breaker_key IN (${placeholders})
        AND status = 'OPEN'`,
    keys,
  );
  return rows;
}

/**
 * List all breakers (admin view).
 */
export async function listBreakers(
  client: PoolClient,
): Promise<CircuitBreakerRow[]> {
  const { rows } = await client.query<CircuitBreakerRow>(
    `SELECT ${BREAKER_COLUMNS} FROM circuit_breakers ORDER BY created_at DESC`,
  );
  return rows;
}

/**
 * Trip (open) a breaker. Upserts by breaker_key.
 */
export async function tripBreaker(
  client: PoolClient,
  params: {
    breakerKey: string;
    reason: string;
    cooldownSeconds: number;
    metadata?: Record<string, unknown>;
  },
): Promise<CircuitBreakerRow> {
  const { rows } = await client.query<CircuitBreakerRow>(
    `INSERT INTO circuit_breakers (breaker_key, status, opened_at, closes_at, reason, metadata)
      VALUES ($1, 'OPEN', now(), now() + make_interval(secs => $2), $3, $4)
      ON CONFLICT (breaker_key)
      DO UPDATE SET
        status    = 'OPEN',
        opened_at = now(),
        closes_at = now() + make_interval(secs => $2),
        reason    = $3,
        metadata  = $4
      RETURNING ${BREAKER_COLUMNS}`,
    [
      params.breakerKey,
      params.cooldownSeconds,
      params.reason,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return rows[0];
}

/**
 * Reset (close) a breaker by key, or all breakers if key is null.
 */
export async function resetBreaker(
  client: PoolClient,
  breakerKey: string | null,
): Promise<number> {
  if (breakerKey) {
    const result = await client.query(
      `UPDATE circuit_breakers
          SET status = 'CLOSED'
        WHERE breaker_key = $1
          AND status = 'OPEN'`,
      [breakerKey],
    );
    return result.rowCount ?? 0;
  }

  const result = await client.query(
    `UPDATE circuit_breakers
        SET status = 'CLOSED'
      WHERE status = 'OPEN'`,
  );
  return result.rowCount ?? 0;
}
