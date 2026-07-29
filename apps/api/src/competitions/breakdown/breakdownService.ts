/**
 * breakdownService.ts — DB read layer for the post-match trade breakdown.
 *
 * SOURCE: orders.match_id (migration 066) is the clean scoping key. trades
 * has no match_id of its own -- it's joined in via buy_order_id/sell_order_id
 * so a fill inherits its order's match scope. Deliberately NOT reusing the
 * closed_trades/open_lots journal system: that's keyed by competition_id (the
 * unrelated weekly-competition tier system), and match-scoped orders don't
 * set a competitionId, so a user's in-match fills land in the same FIFO lot
 * queue as their free-play trades -- reusing it here would risk misattributed
 * P&L. orders.match_id has no such contamination risk.
 *
 * Grouped at order level (not raw fills) with a qty-weighted avg fill price,
 * since "a trade I made" reads naturally as one order, not its individual
 * partial-fill line items.
 */
import { pool } from "../../db/pool.js";
import { getMatchById } from "../matchService.js";

export class BreakdownError extends Error {
    constructor(public code: "match_not_found" | "match_not_ended") {
        super(code);
    }
}

const TERMINAL_STATUSES = new Set(["COMPLETED", "FORFEITED"]);

export interface BreakdownOrder {
    orderId: string;
    pairSymbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    qty: string;
    qtyFilled: string;
    avgFillPrice: string | null;
    status: string;
    placedAt: string;
    lastFillAt: string | null;
}

export interface MatchBreakdown {
    match: {
        id: string;
        status: string;
        endedAt: string | null;
        challenger: { id: string; name: string };
        opponent: { id: string; name: string };
    };
    challengerOrders: BreakdownOrder[];
    opponentOrders: BreakdownOrder[];
}

interface RawOrderRow {
    order_id: string;
    user_id: string;
    pair_symbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    qty: string;
    qty_filled: string;
    avg_fill_price: string | null;
    status: string;
    placed_at: Date;
    last_fill_at: Date | null;
}

export async function getMatchBreakdown(matchId: string): Promise<MatchBreakdown> {
    const match = await getMatchById(matchId);
    if (!match) throw new BreakdownError("match_not_found");
    if (!TERMINAL_STATUSES.has(match.status)) throw new BreakdownError("match_not_ended");

    const { rows } = await pool.query<RawOrderRow>(
        `SELECT
            o.id AS order_id,
            o.user_id AS user_id,
            tp.symbol AS pair_symbol,
            o.side AS side,
            o.type AS type,
            o.qty AS qty,
            o.qty_filled AS qty_filled,
            o.status AS status,
            o.created_at AS placed_at,
            CASE WHEN SUM(t.qty) > 0 THEN SUM(t.qty * t.price) / SUM(t.qty) ELSE NULL END AS avg_fill_price,
            MAX(t.executed_at) AS last_fill_at
         FROM orders o
         JOIN trading_pairs tp ON tp.id = o.pair_id
         LEFT JOIN trades t ON (t.buy_order_id = o.id OR t.sell_order_id = o.id)
         WHERE o.match_id = $1
         GROUP BY o.id, tp.symbol
         ORDER BY o.created_at ASC`,
        [matchId],
    );

    const toBreakdownOrder = (r: RawOrderRow): BreakdownOrder => ({
        orderId: r.order_id,
        pairSymbol: r.pair_symbol,
        side: r.side,
        type: r.type,
        qty: r.qty,
        qtyFilled: r.qty_filled,
        avgFillPrice: r.avg_fill_price,
        status: r.status,
        placedAt: r.placed_at.toISOString(),
        lastFillAt: r.last_fill_at ? r.last_fill_at.toISOString() : null,
    });

    return {
        match: {
            id: match.id,
            status: match.status,
            endedAt: match.completed_at,
            challenger: { id: match.challenger_id, name: match.challenger_name ?? "CHALLENGER" },
            opponent: { id: match.opponent_id, name: match.opponent_name ?? "OPPONENT" },
        },
        challengerOrders: rows.filter((r) => r.user_id === match.challenger_id).map(toBreakdownOrder),
        opponentOrders: rows.filter((r) => r.user_id === match.opponent_id).map(toBreakdownOrder),
    };
}
