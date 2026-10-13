import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import type { TriggerKind, TriggerOrderRow, TriggerStatus } from "./triggerTypes";

const TRIGGER_COLUMNS = `id, user_id, pair_id, kind, side, trigger_price, limit_price, qty, status, oco_group_id, derived_order_id, fail_reason, trailing_offset, trailing_high_water_mark, trade_proposal_id, match_id, created_at, updated_at`;

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
    tradeProposalId?: string;
    /**
     * The scope the trigger acts on, fixed at creation: the user's ACTIVE
     * match at that moment, or null for free-play. Required (no default) so
     * every caller resolves it explicitly — fireTrigger routes and clamps by
     * it, never by whatever match the user is in when it fires.
     */
    matchId: string | null;
}): Promise<TriggerOrderRow> {
    const result = await pool.query<TriggerOrderRow>(
        `
        INSERT INTO trigger_orders (user_id, pair_id, kind, side, trigger_price, limit_price, qty, oco_group_id, trailing_offset, trailing_high_water_mark, trade_proposal_id, match_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
            params.tradeProposalId ?? null,
            params.matchId,
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

/**
 * Every trigger kind (STOP / TAKE_PROFIT / TRAILING) protects a position, so a
 * trigger on `side` exists to reduce the position that side closes:
 * SELL triggers reduce a long (base_qty > 0), BUY triggers reduce a short.
 */
export function reducedDirectionSql(side: "BUY" | "SELL"): string {
    return side === "SELL" ? "base_qty > 0" : "base_qty < 0";
}

/**
 * Cancel a user's ACTIVE `side` triggers on a pair, in one scope (free-play =
 * matchId null, or one match), once nothing is left for them to reduce there —
 * the user holds no position in that direction on the pair in that scope.
 * Triggers in other scopes are untouched: closing a free-play long never
 * cancels a match stop, and vice versa.
 *
 * Runs inside the caller's transaction. `reason` is stored in fail_reason
 * (the trigger's status-reason column). Returns the canceled rows.
 */
export async function cancelReducingTriggersTx(
    client: PoolClient,
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    matchId: string | null,
    reason: string,
): Promise<TriggerOrderRow[]> {
    const result = await client.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'CANCELED', fail_reason = $4
        WHERE user_id = $1 AND pair_id = $2 AND side = $3 AND status = 'ACTIVE'
          AND match_id IS NOT DISTINCT FROM $5::uuid
          AND NOT EXISTS (
              SELECT 1 FROM positions
              WHERE user_id = $1 AND pair_id = $2 AND ${reducedDirectionSql(side)}
                AND competition_id IS NULL
                AND match_id IS NOT DISTINCT FROM $5::uuid
          )
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [userId, pairId, side, reason, matchId],
    );
    return result.rows;
}

/**
 * A match has ended (completed, forfeited or canceled): cancel every ACTIVE
 * trigger scoped to it. Runs inside the match-end transaction; publish the
 * returned rows after COMMIT.
 */
export async function cancelMatchTriggersTx(
    client: PoolClient,
    matchId: string,
    reason: string,
): Promise<TriggerOrderRow[]> {
    const result = await client.query<TriggerOrderRow>(
        `
        UPDATE trigger_orders
        SET status = 'CANCELED', fail_reason = $2
        WHERE match_id = $1 AND status = 'ACTIVE'
        RETURNING ${TRIGGER_COLUMNS}
        `,
        [matchId, reason],
    );
    return result.rows;
}

/**
 * How much a `side` trigger may reduce right now: the size of the user's
 * position in the direction it closes, in the scope its derived order will
 * land in (free-play / competition / match). 0 = nothing to reduce.
 */
export async function reducibleQty(
    userId: string,
    pairId: string,
    side: "BUY" | "SELL",
    scope: { competitionId: string | null; matchId: string | null },
): Promise<string> {
    const { rows } = await pool.query<{ qty: string }>(
        `
        SELECT GREATEST(${side === "SELL" ? "base_qty" : "-base_qty"}, 0)::text AS qty
        FROM positions
        WHERE user_id = $1 AND pair_id = $2
          AND COALESCE(competition_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND COALESCE(match_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        `,
        [userId, pairId, scope.competitionId, scope.matchId],
    );
    return rows[0]?.qty ?? "0";
}

/** The pair of a trigger the user owns, or null. */
export async function findTriggerPairIdForUser(userId: string, triggerId: string): Promise<string | null> {
    const { rows } = await pool.query<{ pair_id: string }>(
        `SELECT pair_id FROM trigger_orders WHERE id = $1 AND user_id = $2`,
        [triggerId, userId],
    );
    return rows[0]?.pair_id ?? null;
}

/**
 * Edit an ACTIVE trigger in place (TP/SL price, or a trailing stop's offset).
 * The row keeps its id and oco_group_id, so an OCO pair stays linked — unlike
 * cancel-then-create, which orphaned the sibling.
 *
 * For a trailing stop the effective trigger price is re-derived from the
 * current high-water mark: hwm - offset (SELL) / hwm + offset (BUY).
 */
export async function updateTriggerByUser(
    userId: string,
    triggerId: string,
    patch: { triggerPrice?: string; trailingOffset?: string },
): Promise<TriggerOrderRow> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const lock = await client.query<TriggerOrderRow>(
            `SELECT ${TRIGGER_COLUMNS} FROM trigger_orders WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [triggerId, userId],
        );
        const row = lock.rows[0];
        if (!row) throw new Error("trigger_not_found");
        if (row.status !== "ACTIVE") throw new Error("trigger_not_editable");

        let triggerPrice: string;
        let trailingOffset: string | null = row.trailing_offset;
        if (row.kind === "TRAILING_STOP_MARKET") {
            if (!patch.trailingOffset || patch.triggerPrice) throw new Error("invalid_input");
            trailingOffset = patch.trailingOffset;
            const hwm = Number(row.trailing_high_water_mark ?? row.trigger_price);
            const offset = Number(trailingOffset);
            triggerPrice = Math.max(0, row.side === "SELL" ? hwm - offset : hwm + offset).toFixed(8);
        } else {
            if (!patch.triggerPrice || patch.trailingOffset) throw new Error("invalid_input");
            triggerPrice = patch.triggerPrice;
        }

        const result = await client.query<TriggerOrderRow>(
            `UPDATE trigger_orders SET trigger_price = $2, trailing_offset = $3
             WHERE id = $1 RETURNING ${TRIGGER_COLUMNS}`,
            [triggerId, triggerPrice, trailingOffset],
        );
        await client.query("COMMIT");
        return result.rows[0];
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}
