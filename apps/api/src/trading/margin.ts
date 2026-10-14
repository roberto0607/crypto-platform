/**
 * Isolated-margin math (USD-margined, linear). Pure: no I/O, no rounding of
 * results — callers round when they store (toFixed8) or display.
 *
 * Design: docs/designs/2026-10-13-leverage-design.md §3. With Q = size in
 * base (> 0), E = average entry, L = leverage, M = the position's isolated
 * margin, P = mark price and mmr = maintenance-margin rate:
 *
 *   notional            Q·E               (at open)
 *   initial margin      notional / L      (summed over adds → M)
 *   unrealized P&L      long Q·(P − E),   short Q·(E − P)
 *   maintenance margin  Q·P·mmr
 *   liquidatable when   M + uPnL ≤ Q·P·mmr
 *   liq price           long  (Q·E − M) / (Q·(1 − mmr))
 *                       short (Q·E + M) / (Q·(1 + mmr))
 *   bankruptcy price    long E − M/Q,     short E + M/Q   (equity = 0)
 *
 * The liq price uses the stored M, not E/L, so it stays right after adds and
 * partial closes. A loss is capped at the position's margin (settleReduce).
 *
 * The web order panel and position card use a copy of this module
 * (apps/web/src/lib/margin.ts); both run the cases in
 * __tests__/marginCases.json.
 */
import Decimal from "decimal.js";
import { D, ZERO, BPS_DIVISOR } from "../utils/decimal";

export type MarginSide = "LONG" | "SHORT";

/** An isolated position. qty is the size (> 0); side gives the direction. */
export type MarginPosition = {
    side: MarginSide;
    qty: Decimal;
    entry: Decimal;
    margin: Decimal;
    /** Maintenance-margin rate in bps (50 = 0.5%). */
    mmrBps: number;
};

const ONE = D(1);

function mmRate(mmrBps: number): Decimal {
    return D(mmrBps).div(BPS_DIVISOR);
}

/** qty × price. */
export function notional(qty: Decimal, price: Decimal): Decimal {
    return qty.mul(price);
}

/** Margin a notional locks at a leverage. */
export function initialMargin(notionalValue: Decimal, leverage: Decimal): Decimal {
    return notionalValue.div(leverage);
}

/**
 * Size (base) a margin buys at a leverage and price, rounded DOWN to 8 dp so
 * the margin the fill actually locks never exceeds what the user entered.
 */
export function sizeForMargin(margin: Decimal, leverage: Decimal, price: Decimal): Decimal {
    return margin.mul(leverage).div(price).toDecimalPlaces(8, Decimal.ROUND_DOWN);
}

/** Q·P·mmr: the equity a position must keep at mark P. */
export function maintenanceMargin(qty: Decimal, mark: Decimal, mmrBps: number): Decimal {
    return qty.mul(mark).mul(mmRate(mmrBps));
}

/** Long Q·(P − E), short Q·(E − P). Not capped (see positionEquity). */
export function unrealizedPnl(side: MarginSide, qty: Decimal, entry: Decimal, mark: Decimal): Decimal {
    const move = side === "LONG" ? mark.minus(entry) : entry.minus(mark);
    return qty.mul(move);
}

/**
 * M + uPnL with the loss capped at the margin: an isolated position is never
 * worth less than 0 to the account, however far price gaps.
 */
export function positionEquity(margin: Decimal, uPnl: Decimal): Decimal {
    return Decimal.max(ZERO, margin.plus(uPnl));
}

/** M + uPnL ≤ Q·P·mmr (at the liq price exactly, it is liquidatable). */
export function isLiquidatable(pos: MarginPosition, mark: Decimal): boolean {
    const equity = pos.margin.plus(unrealizedPnl(pos.side, pos.qty, pos.entry, mark));
    return equity.lte(maintenanceMargin(pos.qty, mark, pos.mmrBps));
}

/**
 * The mark at which the position becomes liquidatable. A long whose margin
 * covers its whole notional (1x) can't be liquidated above 0 → 0.
 */
export function liquidationPrice(pos: MarginPosition): Decimal {
    const mmr = mmRate(pos.mmrBps);
    const cost = pos.qty.mul(pos.entry);
    if (pos.side === "LONG") {
        return Decimal.max(ZERO, cost.minus(pos.margin).div(pos.qty.mul(ONE.minus(mmr))));
    }
    return cost.plus(pos.margin).div(pos.qty.mul(ONE.plus(mmr)));
}

/** The mark at which equity reaches 0 (long floored at 0). */
export function bankruptcyPrice(pos: Pick<MarginPosition, "side" | "qty" | "entry" | "margin">): Decimal {
    const perUnit = pos.margin.div(pos.qty);
    return pos.side === "LONG" ? Decimal.max(ZERO, pos.entry.minus(perUnit)) : pos.entry.plus(perUnit);
}

/**
 * Margin health for the UI, linear in price: 1 at entry, 0 at the liq price,
 * clamped to [0, 1] (above 1 when in profit is shown as full).
 *   (equity − MM) / (M − MM at entry)
 */
export function marginHealth(pos: MarginPosition, mark: Decimal): Decimal {
    const equity = pos.margin.plus(unrealizedPnl(pos.side, pos.qty, pos.entry, mark));
    const buffer = equity.minus(maintenanceMargin(pos.qty, mark, pos.mmrBps));
    const full = pos.margin.minus(maintenanceMargin(pos.qty, pos.entry, pos.mmrBps));
    if (full.lte(ZERO)) return ZERO;
    return Decimal.min(ONE, Decimal.max(ZERO, buffer.div(full)));
}

/** Margin released by closing closeQty of a position of size posQty: M·Δq/Q. */
export function releasedMargin(margin: Decimal, closeQty: Decimal, posQty: Decimal): Decimal {
    if (closeQty.gte(posQty)) return margin;
    return margin.mul(closeQty).div(posQty);
}

export type ReduceSettlement = {
    /** USD credited to the wallet: released + pnl − fee, never below 0. */
    credit: Decimal;
    /** P&L booked to the position: the loss is capped at the released margin. */
    bookedPnl: Decimal;
    /** Fee actually charged: whatever the released margin + P&L can cover. */
    bookedFee: Decimal;
    /** Fee left uncharged because nothing was left to pay it. */
    uncollectedFee: Decimal;
    /** Loss beyond the released margin (a price gap), absorbed. */
    shortfall: Decimal;
};

/**
 * Settle a reduce (partial close, full close or liquidation) with the loss
 * cap: the user can lose the released margin and nothing more, so the USD
 * balance never goes negative because of a position.
 *
 *   credit    = max(0, released + pnl − fee)
 *   bookedPnl = max(pnl, −released)
 *   bookedFee = min(fee, max(0, released + pnl))
 *   shortfall = max(0, −(released + pnl))
 *
 * so credit = released + bookedPnl − bookedFee in every case.
 */
export function settleReduce(released: Decimal, pnl: Decimal, fee: Decimal): ReduceSettlement {
    const left = released.plus(pnl);
    const bookedFee = Decimal.min(fee, Decimal.max(ZERO, left));
    return {
        credit: Decimal.max(ZERO, left.minus(fee)),
        bookedPnl: Decimal.max(pnl, released.neg()),
        bookedFee,
        uncollectedFee: fee.minus(bookedFee),
        shortfall: Decimal.max(ZERO, left.neg()),
    };
}

/**
 * Whether `leverage` is allowed under `cap`: a finite number ≥ 1 and ≤ cap,
 * with at most 2 decimals (the NUMERIC(6, 2) columns).
 */
export function isValidLeverage(leverage: number, cap: number): boolean {
    return Number.isFinite(leverage)
        && leverage >= 1
        && leverage <= cap
        && Math.round(leverage * 100) === leverage * 100;
}
