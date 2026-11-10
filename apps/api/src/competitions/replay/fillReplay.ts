/**
 * fillReplay.ts: match replay from a player's own fills (pure, no I/O).
 *
 * Real matches have no match_positions rows (only the demo seed writes them),
 * but every fill they made is a trade on one of their match-scoped orders,
 * the match-end closes included. Walking those fills through the engine's
 * position math (analytics/positionMath applyFill, rounded to 8 dp as
 * positionRepo stores it) gives the same realized P&L the positions table
 * holds, and each fill's fee is what the engine charged. So the curve ends on
 * the stored headline: Σ realized − Σ fees over starting capital, the same sum
 * calculatePlayerStats takes.
 *
 * Per candle (ts = the 5m bucket's start, marked at its close):
 *   - fills that landed in or before this candle are applied;
 *   - realizedPnl = realized P&L − fees paid so far;
 *   - unrealizedPnl = each open size marked at the candle's close.
 *
 * ISOLATED positions are walked the same way. The one thing not reproduced
 * is the loss cap at the margin (a gap past bankruptcy), which only matters
 * for a liquidation-sized loss.
 */
import Decimal from "decimal.js";
import { applyFill, type PositionState } from "../../analytics/positionMath";
import { D, ZERO } from "../../utils/decimal";
import type { CurvePoint, MarkPriceLookup } from "./reconstructPnlCurve";

/** One of a player's fills, in the order the engine applied them. */
export interface ReplayFill {
    pairId: string;
    side: "BUY" | "SELL";
    qty: string;
    price: string;
    /** What this player paid on the fill (quote). */
    fee: string;
    /** executed_at, epoch ms. */
    ts: number;
}

/** A round trip: from flat to flat (or a flip), for the chart's markers. */
export interface FillTrip {
    pairId: string;
    side: "LONG" | "SHORT";
    /** Average price of the fills that opened or added. */
    entryPrice: number;
    /** Total size opened. */
    qty: number;
    /** Average price of the fills that closed it; null while open. */
    exitPrice: number | null;
    openedAt: number;
    closedAt: number | null;
    /** Realized P&L less every fee paid on it (a flip's fee split by size). */
    pnl: number;
}

const FLAT: PositionState = { qty: ZERO, avgEntry: ZERO, realizedPnl: ZERO };
const dp8 = (d: Decimal) => d.toDecimalPlaces(8);

/** applyFill, stored the way positionRepo stores it (8 dp per column). */
function step(pos: PositionState, f: ReplayFill): PositionState {
    const next = applyFill(pos, f.side, D(f.qty), D(f.price));
    return { qty: dp8(next.qty), avgEntry: dp8(next.avgEntry), realizedPnl: dp8(next.realizedPnl) };
}

export function fillTrips(fills: ReplayFill[]): FillTrip[] {
    interface Open {
        trip: FillTrip;
        entryQty: Decimal; entryCost: Decimal;
        exitQty: Decimal; exitCost: Decimal;
        realizedAtOpen: Decimal; fees: Decimal;
    }
    const trips: FillTrip[] = [];
    const pos = new Map<string, PositionState>();
    const open = new Map<string, Open>();

    const start = (f: ReplayFill, qty: Decimal, fee: Decimal, realized: Decimal) => {
        const trip: FillTrip = {
            pairId: f.pairId, side: f.side === "BUY" ? "LONG" : "SHORT", entryPrice: 0, qty: 0,
            exitPrice: null, openedAt: f.ts, closedAt: null, pnl: 0,
        };
        trips.push(trip);
        open.set(f.pairId, {
            trip, entryQty: qty, entryCost: qty.mul(f.price), exitQty: ZERO, exitCost: ZERO,
            realizedAtOpen: realized, fees: fee,
        });
    };
    const settle = (o: Open, realizedNow: Decimal) => {
        o.trip.entryPrice = o.entryCost.div(o.entryQty).toNumber();
        o.trip.qty = o.entryQty.toNumber();
        o.trip.exitPrice = o.exitQty.gt(0) ? o.exitCost.div(o.exitQty).toNumber() : null;
        o.trip.pnl = realizedNow.minus(o.realizedAtOpen).minus(o.fees).toNumber();
    };

    for (const f of fills) {
        const before = pos.get(f.pairId) ?? FLAT;
        const after = step(before, f);
        pos.set(f.pairId, after);
        const qty = D(f.qty);
        const fee = D(f.fee);
        const o = open.get(f.pairId);

        if (!o) {
            start(f, qty, fee, before.realizedPnl);
            continue;
        }
        const adds = (o.trip.side === "LONG") === (f.side === "BUY");
        if (adds) {
            o.entryQty = o.entryQty.plus(qty);
            o.entryCost = o.entryCost.plus(qty.mul(f.price));
            o.fees = o.fees.plus(fee);
            continue;
        }
        // Reduces, closes or flips: the part up to the size closes this trip.
        const size = before.qty.abs();
        const closeQty = Decimal.min(qty, size);
        const closeFee = closeQty.eq(qty) ? fee : fee.mul(closeQty).div(qty);
        o.exitQty = o.exitQty.plus(closeQty);
        o.exitCost = o.exitCost.plus(closeQty.mul(f.price));
        o.fees = o.fees.plus(closeFee);
        if (after.qty.isZero() || after.qty.isNegative() !== before.qty.isNegative()) {
            settle(o, after.realizedPnl);
            o.trip.closedAt = f.ts;
            open.delete(f.pairId);
            if (!after.qty.isZero()) start(f, qty.minus(closeQty), fee.minus(closeFee), after.realizedPnl);
        }
    }
    for (const [pairId, o] of open) settle(o, (pos.get(pairId) ?? FLAT).realizedPnl);
    return trips;
}

export function reconstructFillCurve(
    fills: ReplayFill[],
    candleTimes: number[],
    markPrice: MarkPriceLookup,
    startingCapital: number,
    bucketMs: number,
): CurvePoint[] {
    const pos = new Map<string, PositionState>();
    let fees = ZERO;
    let i = 0;
    return candleTimes.map((T) => {
        // Fills inside this candle count: it's marked at its close.
        while (i < fills.length && fills[i]!.ts < T + bucketMs) {
            const f = fills[i++]!;
            pos.set(f.pairId, step(pos.get(f.pairId) ?? FLAT, f));
            fees = fees.plus(D(f.fee));
        }
        let realized = ZERO;
        let unrealized = 0;
        for (const [pairId, p] of pos) {
            realized = realized.plus(p.realizedPnl);
            if (p.qty.isZero()) continue;
            const mark = markPrice(pairId, T);
            if (mark != null) unrealized += p.qty.mul(D(mark).minus(p.avgEntry)).toNumber();
        }
        const realizedNet = realized.minus(fees).toNumber();
        const equity = startingCapital + realizedNet + unrealized;
        const pnlPct = startingCapital > 0 ? ((equity - startingCapital) / startingCapital) * 100 : 0;
        return { ts: T, equity, pnlPct, realizedPnl: realizedNet, unrealizedPnl: unrealized };
    });
}
