import { pool } from "../db/pool";
import type { PoolClient } from "pg";

export type IdempotencyRow = {
    user_id: string;
    key: string;
    order_id: string;
    snapshot_json: any;
    created_at: string;
};

/**
 * Look up an existing idempotency key for a user (non-transactional read).
 * Returns the row if found, null otherwise.
 */
export async function getIdempotencyKey(
    userId: string,
    key: string
): Promise<IdempotencyRow | null> {
    const result = await pool.query<IdempotencyRow>(
        `
        SELECT user_id, key, order_id, snapshot_json, created_at
        FROM idempotency_keys
        WHERE user_id = $1 AND key = $2
        LIMIT 1
        `,
        [userId, key]
    );

    return result.rows[0] ?? null;
}

/**
 * Insert an idempotency key within an existing transaction.
 * Uses ON CONFLICT DO NOTHING to handle concurrent duplicate inserts
 * without throwing. Returns the number of rows inserted (1 or 0).
 * Caller should check the return value: if 0, another transaction
 * won the race and the caller should SELECT the existing row.
 */
export async function putIdempotencyKeyTx(
    client: PoolClient,
    userId: string,
    key: string,
    orderId: string,
    snapshotJson: any
): Promise<number> {
    const result = await client.query(
        `
        INSERT INTO idempotency_keys (user_id, key, order_id, snapshot_json)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, key) DO NOTHING
        `,
        [userId, key, orderId, JSON.stringify(snapshotJson)]
    );

    return result.rowCount ?? 0;
}