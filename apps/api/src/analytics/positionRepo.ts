import type { PoolClient } from "pg";
import Decimal from "decimal.js";
import { D, ZERO, toFixed8 } from "../utils/decimal";

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
    await client.query(
        `INSERT INTO positions (user_id, pair_id, competition_id, match_id)
         VALUES ($1, $2, $3::uuid, $4::uuid)
         ON CONFLICT (user_id, pair_id,
                      COALESCE(competition_id, ${NIL_UUID}),
                      COALESCE(match_id, ${NIL_UUID}))
         DO NOTHING`,
        [userId, pairId, compId, matchId]
    );

    // Lock and read current position for this exact (user, pair, scope).
    const posResult = await client.query<PositionRow>(
        `SELECT ${POSITION_COLUMNS}
         FROM positions
         WHERE user_id = $1 AND pair_id = $2
           AND COALESCE(competition_id, ${NIL_UUID}) = COALESCE($3::uuid, ${NIL_UUID})
           AND COALESCE(match_id, ${NIL_UUID}) = COALESCE($4::uuid, ${NIL_UUID})
         FOR UPDATE`,
        [userId, pairId, compId, matchId]
    );

    const pos = posResult.rows[0];
    let currentQty = D(pos.base_qty);
    let avgEntry = D(pos.avg_entry_price);
    let realizedPnl = D(pos.realized_pnl_quote);
    let feesPaid = D(pos.fees_paid_quote);

    if (side === "BUY") {
        // Increase position: weighted average entry price
        const oldCost = currentQty.mul(avgEntry);
        const newCost = fillQty.mul(fillPrice);
        const totalQty = currentQty.plus(fillQty);

        if (totalQty.gt(ZERO)) {
            avgEntry = oldCost.plus(newCost).div(totalQty);
        }
        currentQty = totalQty;
    } else {
        // SELL: realize PnL on min(fillQty, currentQty)
        const closingQty = Decimal.min(fillQty, currentQty);

        if (closingQty.gt(ZERO)) {
            const pnl = closingQty.mul(fillPrice.minus(avgEntry));
            realizedPnl = realizedPnl.plus(pnl);
        }

        currentQty = currentQty.minus(fillQty);

        // Position flip: if currentQty went negative, new position at fillPrice
        if (currentQty.lt(ZERO)) {
            avgEntry = fillPrice;
            currentQty = currentQty; // remains negative (short)
        } else if (currentQty.eq(ZERO)) {
            avgEntry = ZERO;
        }
        // If still positive, avgEntry unchanged
    }

    // Accumulate fees
    feesPaid = feesPaid.plus(fee);

    // Update position. Bug L1 fix: WHERE includes competition_id AND match_id
    // so we only touch the exact scope row we just locked — previously this
    // UPDATE could clobber rows in other scopes for the same (user, pair).
    const updateResult = await client.query<PositionRow>(
        `UPDATE positions
         SET base_qty = $3,
             avg_entry_price = $4,
             realized_pnl_quote = $5,
             fees_paid_quote = $6
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
        ]
    );

    // Insert equity snapshot scoped to the same (user, ts, competition, match).
    // Equity = realized PnL - total fees (unrealized computed at read time).
    const equity = realizedPnl.minus(feesPaid);
    await client.query(
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
