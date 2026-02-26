import { pool } from "../db/pool";
import type { PoolClient } from "pg";

export type IdempotencyRow = {
    user_id: string;
    key: string;
    order_id: string;
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
        SELECT user_id, key, order_id, created_at
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
 * Must be called inside the same transaction that creates the order
 * to guarantee atomicity.
 */
export async function putIdempotencyKeyTx(
    client: PoolClient,
    userId: string,
    key: string,
    orderId: string
): Promise<void> {
    await client.query(
        `
        INSERT INTO idempotency_keys (user_id, key, order_id)
        VALUES ($1, $2, $3)
        `,
        [userId, key, orderId]
    );
}
