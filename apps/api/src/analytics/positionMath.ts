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
 * Fees are not part of this — callers accumulate them separately.
 */
export function applyFill(
    pos: PositionState,
    side: "BUY" | "SELL",
    fillQty: Decimal,
    fillPrice: Decimal,
): PositionState {
    let currentQty = pos.qty;
    let avgEntry = pos.avgEntry;
    let realizedPnl = pos.realizedPnl;

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
        } else if (currentQty.eq(ZERO)) {
            avgEntry = ZERO;
        }
        // If still positive, avgEntry unchanged
    }

    return { qty: currentQty, avgEntry, realizedPnl };
}
