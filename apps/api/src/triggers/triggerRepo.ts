import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import type { TriggerKind, TriggerOrderRow, TriggerStatus } from "./triggerTypes";

const TRIGGER_COLUMNS = `id, user_id, pair_id, kind, side, trigger_price, limit_price, qty, status, oco_group_id, derived_order_id, fail_reason, trailing_offset, trailing_high_water_mark, created_at, updated_at`;

export async function createTriggerOrder(params: {
    userId: string;
    pairId: string;
    kind: TriggerKind;
    side: "BUY" | "SELL";
    triggerPrice: string;
    limitPrice?: string;
    qty: string;
    ocoGroupId?: string;
    trailingOffset?: string;
    trailingHighWaterMark?: string;
}): Promise<TriggerOrderRow> {
    const result = await pool.query<TriggerOrderRow>(
        `
        INSERT INTO trigger_orders (user_id, pair_id, kind, side, trigger_price, limit_price, qty, oco_group_id, trailing_offset, trailing_high_water_mark)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [
            params.userId,
            params.pairId,
            params.kind,
            params.side,
            params.triggerPrice,
            params.limitPrice ?? null,
            params.qty,
            params.ocoGroupId ?? null,
            params.trailingOffset ?? null,
            params.trailingHighWaterMark ?? null,
        ]
    );

    return result.rows[0];
}

export async function listActiveTriggersForPair(
    pairId: string
): Promise<TriggerOrderRow[]> {
    const result = await pool.query<TriggerOrderRow>(
        `
        SELECT ${TRIGGER_COLUMNS}
        FROM trigger_orders
        WHERE pair_id = $1 AND status = 'ACTIVE'
        ORDER BY created_at ASC, id ASC
        `,
        [pairId]
    );

    return result.rows;
}

export async function updateTrailingHwm(
    triggerId: string,
    newHwm: string,
    newTriggerPrice: string,
): Promise<void> {
    await pool.query(
        `UPDATE trigger_orders
         SET trailing_high_water_mark = $2, trigger_price = $3
         WHERE id = $1 AND status = 'ACTIVE'`,
        [triggerId, newHwm, newTriggerPrice],
    );
}

export async function listTriggersByUser(
    userId: string,
    filters: { pairId?: string; status?: string },
    limit: number,
    cursor: { ca: string; id: string } | null
): Promise<TriggerOrderRow[]> {
    let query = `SELECT ${TRIGGER_COLUMNS} FROM trigger_orders WHERE user_id = $1`;
    const params: (string | number)[] = [userId];

    if (filters.pairId) {
        params.push(filters.pairId);
        query += ` AND pair_id = $${params.length}`;
    }

    if (filters.status) {
        params.push(filters.status);
        query += ` AND status = $${params.length}`;
    }

    if (cursor) {
        params.push(cursor.ca);
        const caIdx = params.length;
        params.push(cursor.id);
        const idIdx = params.length;
        query += ` AND (created_at, id) < ($${caIdx}, $${idIdx})`;
    }

    params.push(limit + 1);
    query += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

    const result = await pool.query<TriggerOrderRow>(query, params);
    return result.rows;
}

export async function markTriggeredTx(
    client: PoolClient,
    triggerId: string
): Promise<TriggerOrderRow | null> {
    const lock = await client.query<TriggerOrderRow>(
        `
        SELECT ${TRIGGER_COLUMNS}
        FROM trigger_orders
        WHERE id = $1
        FOR UPDATE
        `,
        [triggerId]
    );

    const row = lock.rows[0];
    if (!row || row.status !== "ACTIVE") return null;

    const result = await client.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'TRIGGERED'
        WHERE id = $1
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [triggerId]
    );

    return result.rows[0];
}

export async function cancelTriggerTx(
    client: PoolClient,
    triggerId: string
): Promise<TriggerOrderRow | null> {
    const lock = await client.query<TriggerOrderRow>(
        `
        SELECT ${TRIGGER_COLUMNS}
        FROM trigger_orders
        WHERE id = $1
        FOR UPDATE
        `,
        [triggerId]
    );

    const row = lock.rows[0];
    if (!row || row.status !== "ACTIVE") return null;

    const result = await client.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'CANCELED'
        WHERE id = $1
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [triggerId]
    );

    return result.rows[0];
}

export async function cancelOcoSiblingTx(
    client: PoolClient,
    ocoGroupId: string,
    excludingTriggerId: string
): Promise<TriggerOrderRow | null> {
    const result = await client.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'CANCELED'
        WHERE oco_group_id = $1
          AND id != $2
          AND status = 'ACTIVE'
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [ocoGroupId, excludingTriggerId]
    );

    return result.rows[0] ?? null;
}

export async function setStatusTx(
    client: PoolClient,
    triggerId: string,
    status: TriggerStatus,
    metadata?: { derivedOrderId?: string; failReason?: string }
): Promise<void> {
    const sets: string[] = ["status = $1"];
    const params: (string | null)[] = [status];

    if (metadata?.derivedOrderId !== undefined) {
        params.push(metadata.derivedOrderId);
        sets.push(`derived_order_id = $${params.length}`);
    }

    if (metadata?.failReason !== undefined) {
        params.push(metadata.failReason);
        sets.push(`fail_reason = $${params.length}`);
    }

    params.push(triggerId);

    await client.query(
        `
        UPDATE trigger_orders
        SET ${sets.join(", ")}
        WHERE id = $${params.length}
        `,
        params
    );
}

export async function cancelTriggerByUser(
    userId: string,
    triggerId: string
): Promise<TriggerOrderRow> {
    // Atomic cancel: ownership, existence, and active-state checks are all part of the UPDATE.
    const result = await pool.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'CANCELED'
        WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [triggerId, userId]
    );

    if (result.rows.length > 0) {
        return result.rows[0];
    }

    // No row updated: either the trigger doesn't exist, doesn't belong to this user,
    // or is not ACTIVE. If it exists for this user and is already CANCELED, return it
    // (idempotent). Otherwise surface trigger_not_found.
    const existing = await pool.query<TriggerOrderRow>(
        `
        SELECT ${TRIGGER_COLUMNS}
        FROM trigger_orders
        WHERE id = $1 AND user_id = $2
        LIMIT 1
        `,
        [triggerId, userId]
    );

    const row = existing.rows[0];
    if (!row) throw new Error("trigger_not_found");
    if (row.status === "CANCELED") return row;
    throw new Error("trigger_not_cancelable");
}
