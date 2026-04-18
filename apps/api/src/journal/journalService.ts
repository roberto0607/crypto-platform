import type { PoolClient } from "pg";

export interface ClosedTradeInput {
    userId: string;
    pairId: string;
    competitionId: string | null;
    direction: "LONG" | "SHORT";
    entryFillIds: string[];
    entryQty: string;
    entryAvgPrice: string;
    entryFees: string;
    entryAt: Date;
    exitFillIds: string[];
    exitQty: string;
    exitAvgPrice: string;
    exitFees: string;
    exitAt: Date;
}

/**
 * Process a fill into the FIFO journal.
 *
 * Called after each fill inside the order execution transaction.
 * - BUY fill: creates an open lot (or closes SHORT lots if short position exists)
 * - SELL fill: consumes oldest BUY lots (FIFO) and creates closed_trades records
 *
 * @param client - Transaction client (inside the order execution txn)
 * @param params.userId
 * @param params.pairId
 * @param params.fillId - trades.id
 * @param params.side - 'BUY' or 'SELL'
 * @param params.price - fill price
 * @param params.qty - fill quantity
 * @param params.feeQuote - fee charged on this fill
 * @param params.filledAt - fill timestamp
 * @param params.competitionId - nullable
 */
export async function processFillForJournal(
    client: PoolClient,
    params: {
        userId: string;
        pairId: string;
        fillId: string;
        side: "BUY" | "SELL";
        price: string;
        qty: string;
        feeQuote: string;
        filledAt: Date;
        competitionId?: string | null;
    },
): Promise<void> {
    const { userId, pairId, fillId, side, price, qty, feeQuote, filledAt, competitionId } = params;
    const compId = competitionId ?? null;

    // Determine if this fill is opening or closing a position
    // BUY closes SHORT lots; SELL closes LONG (BUY) lots
    const closingSide = side === "BUY" ? "SELL" : "BUY";

    // 1. Fetch oldest open lots on the opposite side (FIFO order)
    const { rows: lots } = await client.query(
        `SELECT id, fill_id, side, price, qty_remaining, fee_quote, filled_at
         FROM open_lots
         WHERE user_id = $1 AND pair_id = $2
           AND COALESCE(competition_id, '00000000-0000-0000-0000-000000000000') =
               COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000')
           AND side = $4 AND qty_remaining > 0
         ORDER BY filled_at ASC, id ASC
         FOR UPDATE`,
        [userId, pairId, compId, closingSide],
    );

    const fillQty = parseFloat(qty);
    if (!Number.isFinite(fillQty) || fillQty <= 0) {
        // Fill qty is invalid — no journal work to do. Caller should treat
        // this as a no-op rather than corrupt the journal with NaN/Infinity.
        return;
    }

    let remaining = fillQty;
    let consumedFeeQuote = 0;

    for (const lot of lots) {
        if (remaining <= 0) break;

        const lotRemaining = parseFloat(lot.qty_remaining);
        if (!Number.isFinite(lotRemaining) || lotRemaining <= 0) {
            // Skip lots with zero or invalid remaining qty — they should have
            // been filtered by the SQL, but defend against NaN/dust anyway.
            continue;
        }
        const consumed = Math.min(remaining, lotRemaining);
        const consumedRatio = consumed / lotRemaining;

        // Proportional fee from the lot
        const lotFee = parseFloat(lot.fee_quote) * consumedRatio;
        // Proportional fee from the current fill (fillQty guaranteed > 0 above)
        const fillFeeShare = parseFloat(feeQuote) * (consumed / fillQty);

        // Determine direction: lot side BUY = LONG trade, lot side SELL = SHORT trade
        const direction = lot.side === "BUY" ? "LONG" : "SHORT";
        const entryPrice = parseFloat(lot.price);
        const exitPrice = parseFloat(price);

        // Gross P&L
        const grossPnl = direction === "LONG"
            ? (exitPrice - entryPrice) * consumed
            : (entryPrice - exitPrice) * consumed;

        const totalFees = lotFee + fillFeeShare;
        const netPnl = grossPnl - totalFees;
        const notional = entryPrice * consumed;
        const returnPct = notional > 0 ? (netPnl / notional) * 100 : 0;
        const holdingSeconds = Math.floor((filledAt.getTime() - new Date(lot.filled_at).getTime()) / 1000);

        // Insert closed trade
        await client.query(
            `INSERT INTO closed_trades
                (user_id, pair_id, competition_id, direction,
                 entry_fill_ids, entry_qty, entry_avg_price, entry_fees, entry_at,
                 exit_fill_ids, exit_qty, exit_avg_price, exit_fees, exit_at,
                 gross_pnl, total_fees, net_pnl, return_pct, holding_seconds)
             VALUES ($1, $2, $3, $4,
                     $5, $6, $7, $8, $9,
                     $10, $11, $12, $13, $14,
                     $15, $16, $17, $18, $19)`,
            [
                userId, pairId, compId, direction,
                [lot.fill_id], consumed.toFixed(8), lot.price, lotFee.toFixed(8), lot.filled_at,
                [fillId], consumed.toFixed(8), price, fillFeeShare.toFixed(8), filledAt.toISOString(),
                grossPnl.toFixed(8), totalFees.toFixed(8), netPnl.toFixed(8),
                returnPct.toFixed(4), holdingSeconds,
            ],
        );

        // Decrement lot
        const newRemaining = lotRemaining - consumed;
        await client.query(
            `UPDATE open_lots SET qty_remaining = $1 WHERE id = $2`,
            [newRemaining.toFixed(8), lot.id],
        );

        remaining -= consumed;
        consumedFeeQuote += fillFeeShare;
    }

    // 2. If there's remaining qty, create a new open lot (opening position)
    if (remaining > 0) {
        const remainingFee = parseFloat(feeQuote) - consumedFeeQuote;
        await client.query(
            `INSERT INTO open_lots
                (user_id, pair_id, competition_id, fill_id, side, price,
                 qty_total, qty_remaining, fee_quote, filled_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                userId, pairId, compId, fillId, side, price,
                remaining.toFixed(8), remaining.toFixed(8),
                remainingFee.toFixed(8), filledAt.toISOString(),
            ],
        );
    }
}
