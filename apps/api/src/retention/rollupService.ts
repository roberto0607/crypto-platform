import type { PoolClient } from "pg";

/**
 * Roll up raw equity_snapshots into 1-minute buckets.
 * Takes the last value per (user_id, minute) for rows older than cutoffMs.
 * Idempotent via ON CONFLICT DO UPDATE.
 */
export async function rollupEquity1m(
    client: PoolClient,
    cutoffMs: number,
): Promise<number> {
    const result = await client.query(
        `INSERT INTO equity_snapshots_1m
             (user_id, bucket_ts, equity_quote, cash_quote, holdings_quote,
              unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote)
         SELECT DISTINCT ON (user_id, floor(ts / 60000) * 60000)
                user_id,
                floor(ts / 60000) * 60000 AS bucket_ts,
                equity_quote, cash_quote, holdings_quote,
                unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote
         FROM equity_snapshots
         WHERE ts < $1
         ORDER BY user_id, floor(ts / 60000) * 60000, ts DESC
         ON CONFLICT (user_id, bucket_ts) DO UPDATE SET
             equity_quote         = EXCLUDED.equity_quote,
             cash_quote           = EXCLUDED.cash_quote,
             holdings_quote       = EXCLUDED.holdings_quote,
             unrealized_pnl_quote = EXCLUDED.unrealized_pnl_quote,
             realized_pnl_quote   = EXCLUDED.realized_pnl_quote,
             fees_paid_quote      = EXCLUDED.fees_paid_quote`,
        [cutoffMs],
    );
    return result.rowCount ?? 0;
}

/**
 * Roll up 1-minute equity snapshots into 1-day buckets.
 * Takes the last value per (user_id, UTC date) for rows older than cutoffMs.
 * Idempotent via ON CONFLICT DO UPDATE.
 */
export async function rollupEquity1d(
    client: PoolClient,
    cutoffMs: number,
): Promise<number> {
    const result = await client.query(
        `INSERT INTO equity_snapshots_1d
             (user_id, bucket_date, equity_quote, cash_quote, holdings_quote,
              unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote)
         SELECT DISTINCT ON (user_id, (to_timestamp(bucket_ts / 1000.0) AT TIME ZONE 'UTC')::date)
                user_id,
                (to_timestamp(bucket_ts / 1000.0) AT TIME ZONE 'UTC')::date AS bucket_date,
                equity_quote, cash_quote, holdings_quote,
                unrealized_pnl_quote, realized_pnl_quote, fees_paid_quote
         FROM equity_snapshots_1m
         WHERE bucket_ts < $1
         ORDER BY user_id, (to_timestamp(bucket_ts / 1000.0) AT TIME ZONE 'UTC')::date, bucket_ts DESC
         ON CONFLICT (user_id, bucket_date) DO UPDATE SET
             equity_quote         = EXCLUDED.equity_quote,
             cash_quote           = EXCLUDED.cash_quote,
             holdings_quote       = EXCLUDED.holdings_quote,
             unrealized_pnl_quote = EXCLUDED.unrealized_pnl_quote,
             realized_pnl_quote   = EXCLUDED.realized_pnl_quote,
             fees_paid_quote      = EXCLUDED.fees_paid_quote`,
        [cutoffMs],
    );
    return result.rowCount ?? 0;
}
