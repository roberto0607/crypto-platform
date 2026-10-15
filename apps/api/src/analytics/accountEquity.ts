/**
 * What a position is worth to the account at a mark price — the per-position
 * term of accountEquity (docs/designs/2026-10-13-leverage-design.md §2.2):
 *
 *   equity = USD balance + Σ positionValue(pos, mark).holdings
 *
 *   SPOT      base_qty × mark (the base sits in the base wallet), uPnL on
 *             the entry. Exactly how equity was computed before leverage.
 *   ISOLATED  no base is held: the position is worth its margin + uPnL,
 *             with the loss capped at the margin, so never below 0.
 *
 * The portfolio summary (and the competition leaderboard built on it) and
 * the per-fill portfolio snapshot use this, so a 10x position counts as its
 * margin, not ten times it.
 */
import Decimal from "decimal.js";
import { D } from "../utils/decimal";
import { marginHealth, type MarginSide } from "../trading/margin";

export type ValuedPosition = {
    base_qty: string;
    avg_entry_price: string;
    /** Absent on rows read before leverage (treated as SPOT). */
    margin_mode?: "SPOT" | "ISOLATED" | string;
    isolated_margin?: string;
};

export function positionValue(pos: ValuedPosition, mark: Decimal): { holdings: Decimal; unrealized: Decimal } {
    const qty = D(pos.base_qty);
    const unrealized = qty.mul(mark.minus(D(pos.avg_entry_price)));
    if (pos.margin_mode !== "ISOLATED") {
        return { holdings: qty.mul(mark), unrealized };
    }
    const margin = D(pos.isolated_margin ?? "0");
    const capped = Decimal.max(unrealized, margin.neg());
    return { holdings: margin.plus(capped), unrealized: capped };
}

/** Margin health at `mark` for an open ISOLATED position (1 at entry, 0 at liq). */
export function isolatedHealth(
    pos: ValuedPosition & { maintenance_margin_bps: number },
    mark: Decimal,
): Decimal {
    const qty = D(pos.base_qty);
    const side: MarginSide = qty.isPositive() ? "LONG" : "SHORT";
    return marginHealth({
        side,
        qty: qty.abs(),
        entry: D(pos.avg_entry_price),
        margin: D(pos.isolated_margin ?? "0"),
        mmrBps: pos.maintenance_margin_bps,
    }, mark);
}
