import type { PoolClient } from "pg";
import { D, toFixed8 } from "../utils/decimal";
import { timedQuery } from "../observability/dbTiming";
import { applyFill } from "./positionMath";

export type PositionRow = {
    user_id: string;
    pair_id: string;
    base_qty: string;
    avg_entry_price: string;
    realized_pnl_quote: string;
    fees_paid_quote: string;
    updated_at: string;
};

const POSITION_COLUMNS = `user_id, pair_id, base_qty, avg_entry_price, realized_pnl_quote, fees_paid_quote, updated_at`;

// Sentinel used by the positions/equity_snapshots unique indexes to collapse
// NULL competition_id / match_id onto a single "free play" row per user+pair.
// Must match the constant the SQL indexes use (migration 042/066).
const NIL_UUID = "'00000000-0000-0000-0000-000000000000'::uuid";

/**
 * Apply a single fill to the user's position within an existing transaction.
 *
 * - BUY increases base_qty, updates avg_entry_price (weighted average)
 * - SELL decreases base_qty, realizes PnL on the sold portion
 * - Accumulates fees_paid_quote
 * - Inserts equity snapshot
 *
 * Handles position flips (long → short via oversized sell) by
 * realizing PnL on the entire old position, then opening a new
 * position at the fill price for the remaining qty.
 *
 * Scope: positions are unique per (user, pair, competition, match). A null
 * competitionId and/or matchId means "free play" or "not match-scoped" and
 * collapses to the nil-UUID slot in the unique index (see migration 066).
 */
export async function applyFillToPositionTx(
    client: PoolClient,
    params: {
        userId: string;
        pairId: string;
        side: "BUY" | "SELL";
        qty: string;
        price: string;
        feeQuote: string;
        ts: number;
        competitionId?: string | null;
        matchId?: string | null;
    }
): Promise<PositionRow> {
    const { userId, pairId, side, qty, price, feeQuote, ts } = params;
    const compId = params.competitionId ?? null;
    const matchId = params.matchId ?? null;
    const fillQty = D(qty);
    const fillPrice = D(price);
    const fee = D(feeQuote);

    // Upsert position row if it doesn't exist. COALESCE-based ON CONFLICT
    // target matches the 4-column unique index created in migration 066.
    await timedQuery(client, "positionRepo.applyFillToPositionTx.upsert",
        `INSERT INTO positions (user_id, pair_id, competition_id, match_id)
         VALUES ($1, $2, $3::uuid, $4::uuid)
         ON CONFLICT (user_id, pair_id,
                      COALESCE(competition_id, ${NIL_UUID}),
                      COALESCE(match_id, ${NIL_UUID}))
         DO NOTHING`,
        [userId, pairId, compId, matchId]
    );

    // Lock and read current position for this exact (user, pair, scope).
    const posResult = await timedQuery<PositionRow & { margin_mode: string }>(client, "positionRepo.applyFillToPositionTx.lock",
        `SELECT ${POSITION_COLUMNS}, margin_mode
         FROM positions
         WHERE user_id = $1 AND pair_id = $2
           AND COALESCE(competition_id, ${NIL_UUID}) = COALESCE($3::uuid, ${NIL_UUID})
           AND COALESCE(match_id, ${NIL_UUID}) = COALESCE($4::uuid, ${NIL_UUID})
         FOR UPDATE`,
        [userId, pairId, compId, matchId]
    );

    const pos = posResult.rows[0];
    // This is the SPOT path. An open ISOLATED position never takes a SPOT
    // fill (the engine keeps an open position's model and blocks resting
    // orders of the other model), so reaching here would corrupt it.
    if (pos.margin_mode === "ISOLATED" && !D(pos.base_qty).isZero()) throw new Error("position_mode_conflict");
    // A flat row left by a closed ISOLATED position starts a fresh SPOT
    // episode: SPOT, 1x, no margin, no liq price, the next epoch. Otherwise
    // the old model would stick to the row and the next close would settle
    // this SPOT position as ISOLATED with margin 0 (leverage PR 7). Rows that
    // were never ISOLATED are untouched.
    const resetFromIsolated = pos.margin_mode === "ISOLATED";
    const { qty: currentQty, avgEntry, realizedPnl } = applyFill(
        { qty: D(pos.base_qty), avgEntry: D(pos.avg_entry_price), realizedPnl: D(pos.realized_pnl_quote) },
        side,
        fillQty,
        fillPrice,
    );
    const feesPaid = D(pos.fees_paid_quote).plus(fee);

    // Update position. Bug L1 fix: WHERE includes competition_id AND match_id
    // so we only touch the exact scope row we just locked — previously this
    // UPDATE could clobber rows in other scopes for the same (user, pair).
    const updateResult = await timedQuery<PositionRow>(client, "positionRepo.applyFillToPositionTx.update",
        `UPDATE positions
         SET base_qty = $3,
             avg_entry_price = $4,
             realized_pnl_quote = $5,
             fees_paid_quote = $6,
             margin_mode = CASE WHEN $9::boolean THEN 'SPOT' ELSE margin_mode END,
             leverage = CASE WHEN $9::boolean THEN 1 ELSE leverage END,
             isolated_margin = CASE WHEN $9::boolean THEN 0 ELSE isolated_margin END,
             liq_price = CASE WHEN $9::boolean THEN NULL ELSE liq_price END,
             epoch = CASE WHEN $9::boolean THEN epoch + 1 ELSE epoch END
         WHERE user_id = $1 AND pair_id = $2
           AND COALESCE(competition_id, ${NIL_UUID}) = COALESCE($7::uuid, ${NIL_UUID})
           AND COALESCE(match_id, ${NIL_UUID}) = COALESCE($8::uuid, ${NIL_UUID})
         RETURNING ${POSITION_COLUMNS}`,
        [
            userId,
            pairId,
            toFixed8(currentQty),
            toFixed8(avgEntry),
            toFixed8(realizedPnl),
            toFixed8(feesPaid),
            compId,
            matchId,
            resetFromIsolated,
        ]
    );

    // Insert equity snapshot scoped to the same (user, ts, competition, match).
    // Equity = realized PnL - total fees (unrealized computed at read time).
    const equity = realizedPnl.minus(feesPaid);
    await timedQuery(client, "positionRepo.applyFillToPositionTx.equitySnapshot",
        `INSERT INTO equity_snapshots (user_id, ts, equity_quote, competition_id, match_id)
         VALUES ($1, $2, $3, $4::uuid, $5::uuid)
         ON CONFLICT (user_id, ts,
                      COALESCE(competition_id, ${NIL_UUID}),
                      COALESCE(match_id, ${NIL_UUID}))
         DO UPDATE SET equity_quote = $3`,
        [userId, ts, toFixed8(equity), compId, matchId]
    );

    return updateResult.rows[0];
}
