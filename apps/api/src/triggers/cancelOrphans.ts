/**
 * cancelOrphans.ts — one-time, reversible cleanup of orphaned triggers left
 * in prod before the position-close fix (positionCloseTriggers.ts).
 *
 * An orphan is an ACTIVE trigger whose side would reduce a position the user
 * doesn't hold in ANY scope: a SELL trigger with no long (base_qty > 0) on the
 * pair, or a BUY trigger with no short. Deliberately broader than the scoped
 * close hook (migration 094): legacy rows all have match_id NULL, so "no
 * position anywhere" is the conservative test. Before the fix, every manual close / one-leg fire left
 * these behind, ACTIVE and invisible in the UI. Driven by
 * src/scripts/cancelOrphanTriggers.ts.
 *
 * Safety:
 *   - Only status ACTIVE → CANCELED, with fail_reason 'orphan_cleanup' as the
 *     marker. Nothing is deleted.
 *   - The orphan condition is re-checked inside the UPDATE's own WHERE (atomic,
 *     no TOCTOU): a trigger whose user opened a matching position between the
 *     dry run and --commit is left alone.
 *   - Reversible: revertOrphanCleanup() re-activates exactly the ids the
 *     commit returned, and only rows still carrying the marker. A reverted
 *     trigger is still harmless: triggers are reduce-only at fire time, so
 *     with no position it cancels itself (no_position) instead of trading.
 *   - Caveat: a trigger created through the API as an "entry" order (e.g. a
 *     buy-stop to open a long while flat) looks identical to an orphan. The UI
 *     never creates those, and since this fix all triggers are reduce-only
 *     anyway, so such a trigger could no longer open a position.
 */
import { pool } from "../db/pool.js";

export const ORPHAN_CLEANUP_REASON = "orphan_cleanup";

export interface OrphanTrigger {
    id: string;
    user_id: string;
    email: string | null;
    pair_id: string;
    symbol: string;
    kind: string;
    side: "BUY" | "SELL";
    trigger_price: string;
    qty: string;
    oco_group_id: string | null;
    trailing_offset: string | null;
    trailing_high_water_mark: string | null;
    created_at: string;
    last_price: string | null;
}

/** No position the trigger could reduce, in any scope. `t` = trigger_orders. */
const ORPHAN_SQL = `
    t.status = 'ACTIVE'
    AND NOT EXISTS (
        SELECT 1 FROM positions p
        WHERE p.user_id = t.user_id AND p.pair_id = t.pair_id
          AND ((t.side = 'SELL' AND p.base_qty > 0) OR (t.side = 'BUY' AND p.base_qty < 0))
    )`;

export async function planOrphanCleanup(filter: { userId?: string } = {}): Promise<OrphanTrigger[]> {
    const { rows } = await pool.query<OrphanTrigger>(
        `SELECT t.id, t.user_id, u.email, t.pair_id, tp.symbol, t.kind, t.side,
                t.trigger_price::text, t.qty::text, t.oco_group_id,
                t.trailing_offset::text, t.trailing_high_water_mark::text,
                t.created_at::text, tp.last_price::text
         FROM trigger_orders t
         JOIN trading_pairs tp ON tp.id = t.pair_id
         LEFT JOIN users u ON u.id = t.user_id
         WHERE ${ORPHAN_SQL}
           AND ($1::uuid IS NULL OR t.user_id = $1::uuid)
         ORDER BY tp.symbol, t.user_id, t.created_at`,
        [filter.userId ?? null],
    );
    return rows;
}

/**
 * Cancel the given trigger ids, in one transaction, if they're still orphans.
 * Returns the full rows as they were canceled (for the revert snapshot).
 */
export async function applyOrphanCleanup(ids: readonly string[]): Promise<OrphanTrigger[]> {
    if (ids.length === 0) return [];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query<{ id: string }>(
            `UPDATE trigger_orders t
             SET status = 'CANCELED', fail_reason = $2
             WHERE t.id = ANY($1::uuid[]) AND ${ORPHAN_SQL}
             RETURNING t.id`,
            [ids, ORPHAN_CLEANUP_REASON],
        );
        const { rows: full } = await client.query<OrphanTrigger>(
            `SELECT t.id, t.user_id, u.email, t.pair_id, tp.symbol, t.kind, t.side,
                    t.trigger_price::text, t.qty::text, t.oco_group_id,
                    t.trailing_offset::text, t.trailing_high_water_mark::text,
                    t.created_at::text, tp.last_price::text
             FROM trigger_orders t
             JOIN trading_pairs tp ON tp.id = t.pair_id
             LEFT JOIN users u ON u.id = t.user_id
             WHERE t.id = ANY($1::uuid[])
             ORDER BY tp.symbol, t.user_id, t.created_at`,
            [rows.map((r) => r.id)],
        );
        await client.query("COMMIT");
        return full;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/** Undo a commit: re-activate exactly these ids, only if still canceled by this cleanup. */
export async function revertOrphanCleanup(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { rows } = await pool.query<{ id: string }>(
        `UPDATE trigger_orders
         SET status = 'ACTIVE', fail_reason = NULL
         WHERE id = ANY($1::uuid[]) AND status = 'CANCELED' AND fail_reason = $2
         RETURNING id`,
        [ids, ORPHAN_CLEANUP_REASON],
    );
    return rows.map((r) => r.id);
}

/** % distance from the last price to the trigger price (how close it is to firing). */
export function distancePct(o: Pick<OrphanTrigger, "trigger_price" | "last_price">): number | null {
    if (!o.last_price) return null;
    const last = Number(o.last_price);
    if (!(last > 0)) return null;
    return ((Number(o.trigger_price) - last) / last) * 100;
}
