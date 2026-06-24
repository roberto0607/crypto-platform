/**
 * reconstructPnlCurve.ts — pure per-candle P&L reconstruction for match replay.
 *
 * Given a player's positions and the candle timeline of a match window, produce
 * an equity/P&L curve sampled at each candle time. No I/O — the DB read layer
 * (replayService.ts) supplies the inputs and the markPrice lookup.
 *
 * Per candle time T, each position contributes:
 *   - openedAt > T              → nothing (not open yet)
 *   - openedAt <= T < closedAt  → UNREALIZED, marked to the pair's candle close at T
 *        LONG : (markClose - entryPrice) * qty
 *        SHORT: (entryPrice - markClose) * qty
 *   - closedAt <= T             → REALIZED, frozen at the position's STORED realizedPnl
 *        (stored pnl is the source of truth — see seed reconcile #79; recomputing
 *         from the back-solved exit would reintroduce sub-dollar rounding drift)
 *
 *   equity(T) = startingCapital + Σ realized(by T) + Σ unrealized(open at T)
 *   pnlPct(T) = (equity(T) - startingCapital) / startingCapital * 100
 *
 * Oracle alignment: at the final candle (window is padded past the last close)
 * every position is closed, so unrealized = 0 and the final point equals
 * Σ(stored pnl)/capital*100 — which post-#79 equals the stored headline pnl_pct.
 * Marking only moves the MIDDLE of the curve, never the endpoint.
 */

export interface NormalizedPosition {
    pairId: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    qty: number;
    openedAt: number; // epoch ms
    closedAt: number; // epoch ms
    realizedPnl: number; // stored realized P&L (source of truth)
}

export interface CurvePoint {
    ts: number; // epoch ms
    equity: number;
    pnlPct: number;
    realizedPnl: number;
    unrealizedPnl: number;
}

/** Last candle close at-or-before T for a pair, or null if none exists yet. */
export type MarkPriceLookup = (pairId: string, ts: number) => number | null;

export function reconstructPnlCurve(
    positions: NormalizedPosition[],
    candleTimes: number[],
    markPrice: MarkPriceLookup,
    startingCapital: number,
): CurvePoint[] {
    return candleTimes.map((T) => {
        let realized = 0;
        let unrealized = 0;

        for (const p of positions) {
            if (p.openedAt > T) continue; // not open yet
            if (p.closedAt <= T) {
                realized += p.realizedPnl; // closed → stored realized
            } else {
                const mark = markPrice(p.pairId, T);
                if (mark != null) {
                    unrealized += p.side === "LONG"
                        ? (mark - p.entryPrice) * p.qty
                        : (p.entryPrice - mark) * p.qty;
                }
                // no candle yet for this pair at T → contributes 0 (conservative)
            }
        }

        const equity = startingCapital + realized + unrealized;
        const pnlPct = startingCapital > 0
            ? ((equity - startingCapital) / startingCapital) * 100
            : 0;

        return { ts: T, equity, pnlPct, realizedPnl: realized, unrealizedPnl: unrealized };
    });
}
