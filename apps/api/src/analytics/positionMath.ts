import Decimal from "decimal.js";
import { ZERO } from "../utils/decimal";

/** A position's size and P&L state: qty > 0 long, < 0 short, 0 flat. */
export type PositionState = {
    qty: Decimal;
    avgEntry: Decimal;
    realizedPnl: Decimal;
};

/**
 * Apply one fill to a position. Pure: the single place the position math
 * lives, shared by the live fill path (positionRepo.applyFillToPositionTx)
 * and the rebuild-from-trades replay (repair/positionRebuildService).
 *
 * Longs and shorts are symmetric:
 *   - a fill in the position's direction (or from flat) adds to it: the
 *     entry becomes the size-weighted average;
 *   - a fill against it reduces it: P&L is realized on the reduced part at
 *     the entry (long: price − entry, short: entry − price) and the entry is
 *     unchanged; flat resets the entry to 0;
 *   - a fill larger than the position closes it all, then opens the rest in
 *     the other direction at the fill price.
 *
 * Fees are not part of this — callers accumulate them separately.
 */
export function applyFill(
    pos: PositionState,
    side: "BUY" | "SELL",
    fillQty: Decimal,
    fillPrice: Decimal,
): PositionState {
    if (fillQty.lte(ZERO)) return pos;

    const { qty, avgEntry, realizedPnl } = pos;
    const signedFill = side === "BUY" ? fillQty : fillQty.neg();
    const nextQty = qty.plus(signedFill);

    // Adding (or opening from flat): size-weighted average entry.
    if (qty.isZero() || qty.isNegative() === signedFill.isNegative()) {
        const size = qty.abs();
        return {
            qty: nextQty,
            avgEntry: size.mul(avgEntry).plus(fillQty.mul(fillPrice)).div(size.plus(fillQty)),
            realizedPnl,
        };
    }

    // Reducing: realize P&L on the closed part at the entry.
    const closedQty = Decimal.min(fillQty, qty.abs());
    const pnlPerUnit = qty.isNegative() ? avgEntry.minus(fillPrice) : fillPrice.minus(avgEntry);
    const nextRealized = realizedPnl.plus(closedQty.mul(pnlPerUnit));

    let nextEntry: Decimal;
    if (nextQty.isZero()) nextEntry = ZERO;                                  // flat
    else if (nextQty.isNegative() === qty.isNegative()) nextEntry = avgEntry; // still open, same side
    else nextEntry = fillPrice;                                              // flipped: the rest opened here

    return { qty: nextQty, avgEntry: nextEntry, realizedPnl: nextRealized };
}
