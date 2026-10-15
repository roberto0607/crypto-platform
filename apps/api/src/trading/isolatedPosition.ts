/**
 * One fill applied to an isolated-margin position (pure). The single place
 * the ISOLATED position math lives: the matching engine sizes an order's
 * margin with it before the fills (buying power) and settles each fill with
 * it (isolatedSettlement.ts), so the check and the settlement can't disagree.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §2.2 and §3.
 *
 *   increase (same side, or from flat)
 *     Q += Δq, E = size-weighted average, M += Δq·p / L.
 *     From flat: epoch + 1, leverage = the order's.
 *   reduce (opposite side, Δq ≤ |Q|)
 *     pnl = Δq·(p − E) long / Δq·(E − p) short, released = M·Δq/|Q|,
 *     settled with the loss cap (margin.settleReduce). E and the liq price
 *     don't move (M/Q is constant). Flat: M = 0, E = 0, liq = NULL.
 *   flip (opposite side, Δq > |Q|)
 *     a full close of |Q|, then an increase of Δq − |Q| from flat at p with
 *     the order's leverage. The fill's fee is split pro rata by qty.
 *
 * Amounts are rounded down to 8 dp (the NUMERIC(28, 8) columns), so a fill
 * never locks more margin than notional / L.
 */
import Decimal from "decimal.js";
import { ZERO } from "../utils/decimal";
import { liquidationPrice, settleReduce, type ReduceSettlement } from "./margin";

export type IsolatedState = {
    /** Signed size in base: > 0 long, < 0 short, 0 flat. */
    qty: Decimal;
    entry: Decimal;
    margin: Decimal;
    leverage: Decimal;
    epoch: number;
    /** null when flat. */
    liqPrice: Decimal | null;
};

export type IsolatedFillResult = {
    next: IsolatedState;
    /** The closing part of the fill, if any. */
    reduce: null | {
        closeQty: Decimal;
        pnl: Decimal;
        released: Decimal;
        fee: Decimal;
        settlement: ReduceSettlement;
    };
    /** The opening/adding part of the fill, if any. */
    open: null | { qty: Decimal; margin: Decimal; fee: Decimal };
    /** The fill started a new position episode (from flat, or a flip). */
    openedFromFlat: boolean;
};

export const FLAT: IsolatedState = {
    qty: ZERO, entry: ZERO, margin: ZERO, leverage: new Decimal(1), epoch: 0, liqPrice: null,
};

const dp8 = (d: Decimal) => d.toDecimalPlaces(8, Decimal.ROUND_DOWN);

function liqOf(qty: Decimal, entry: Decimal, margin: Decimal, mmrBps: number): Decimal | null {
    if (qty.isZero()) return null;
    return dp8(liquidationPrice({
        side: qty.isPositive() ? "LONG" : "SHORT",
        qty: qty.abs(),
        entry,
        margin,
        mmrBps,
    }));
}

/**
 * Apply one fill of `fillQty` at `fillPrice` with total fee `fee` to `pos`.
 * `leverage` is the order's; it only applies to a part that opens from flat
 * (an add keeps the position's leverage — the engine rejects a mismatch).
 */
export function applyIsolatedFill(
    pos: IsolatedState,
    side: "BUY" | "SELL",
    fillQty: Decimal,
    fillPrice: Decimal,
    fee: Decimal,
    leverage: Decimal,
    mmrBps: number,
): IsolatedFillResult {
    const signed = side === "BUY" ? fillQty : fillQty.neg();
    const opposite = !pos.qty.isZero() && pos.qty.isNegative() !== signed.isNegative();

    let state = pos;
    let reduce: IsolatedFillResult["reduce"] = null;
    let openQty = fillQty;
    let openFee = fee;

    if (opposite) {
        const size = pos.qty.abs();
        const closeQty = Decimal.min(fillQty, size);
        const closeFee = closeQty.eq(fillQty) ? fee : dp8(fee.mul(closeQty).div(fillQty));
        const perUnit = pos.qty.isPositive() ? fillPrice.minus(pos.entry) : pos.entry.minus(fillPrice);
        const pnl = dp8(closeQty.mul(perUnit));
        const released = closeQty.eq(size) ? pos.margin : dp8(pos.margin.mul(closeQty).div(size));
        reduce = { closeQty, pnl, released, fee: closeFee, settlement: settleReduce(released, pnl, closeFee) };

        const restQty = pos.qty.isPositive() ? pos.qty.minus(closeQty) : pos.qty.plus(closeQty);
        const restMargin = pos.margin.minus(released);
        state = restQty.isZero()
            ? { ...pos, qty: ZERO, entry: ZERO, margin: ZERO, liqPrice: null }
            : { ...pos, qty: restQty, margin: restMargin, liqPrice: liqOf(restQty, pos.entry, restMargin, mmrBps) };

        openQty = fillQty.minus(closeQty);
        openFee = fee.minus(closeFee);
    }

    if (openQty.isZero()) {
        return { next: state, reduce, open: null, openedFromFlat: false };
    }

    const fromFlat = state.qty.isZero();
    const lev = fromFlat ? leverage : state.leverage;
    const margin = dp8(openQty.mul(fillPrice).div(lev));
    const size = state.qty.abs();
    const nextSize = size.plus(openQty);
    const entry = dp8(size.mul(state.entry).plus(openQty.mul(fillPrice)).div(nextSize));
    const qty = side === "BUY" ? nextSize : nextSize.neg();
    const totalMargin = state.margin.plus(margin);

    return {
        next: {
            qty,
            entry,
            margin: totalMargin,
            leverage: lev,
            epoch: fromFlat ? state.epoch + 1 : state.epoch,
            liqPrice: liqOf(qty, entry, totalMargin, mmrBps),
        },
        reduce,
        open: { qty: openQty, margin, fee: openFee },
        openedFromFlat: fromFlat,
    };
}
