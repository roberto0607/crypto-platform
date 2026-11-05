/**
 * Isolated-margin math for the order panel and position card. Mirror of the
 * server's (apps/api/src/trading/margin.ts); both are tested on the same
 * cases (apps/api/src/trading/__tests__/marginCases.json), so the liq price
 * shown before submit is the one the engine computes.
 *
 * Q = size (> 0), E = entry, L = leverage, M = isolated margin, P = mark,
 * mmr = maintenance-margin rate:
 *   liquidatable when  M + uPnL ≤ Q·P·mmr
 *   liq price          long (Q·E − M) / (Q·(1 − mmr)), short (Q·E + M) / (Q·(1 + mmr))
 *   bankruptcy price   long E − M/Q, short E + M/Q
 * A loss is capped at the position's margin (settleReduce).
 */
import Decimal from "decimal.js-light";

export type MarginSide = "LONG" | "SHORT";

export type MarginPosition = {
  side: MarginSide;
  qty: Decimal;
  entry: Decimal;
  margin: Decimal;
  /** Maintenance-margin rate in bps (50 = 0.5%). */
  mmrBps: number;
};

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const BPS = new Decimal(10000);
const max = (a: Decimal, b: Decimal) => (a.gt(b) ? a : b);
const min = (a: Decimal, b: Decimal) => (a.lt(b) ? a : b);

function mmRate(mmrBps: number): Decimal {
  return new Decimal(mmrBps).div(BPS);
}

/** qty × price. */
export function notional(qty: Decimal, price: Decimal): Decimal {
  return qty.mul(price);
}

/** Margin a notional locks at a leverage. */
export function initialMargin(notionalValue: Decimal, leverage: Decimal): Decimal {
  return notionalValue.div(leverage);
}

/** Size a margin buys at a leverage and price, rounded down to 8 dp. */
export function sizeForMargin(margin: Decimal, leverage: Decimal, price: Decimal): Decimal {
  return margin.mul(leverage).div(price).todp(8, Decimal.ROUND_DOWN);
}

/** Q·P·mmr. */
export function maintenanceMargin(qty: Decimal, mark: Decimal, mmrBps: number): Decimal {
  return qty.mul(mark).mul(mmRate(mmrBps));
}

/** Long Q·(P − E), short Q·(E − P). */
export function unrealizedPnl(side: MarginSide, qty: Decimal, entry: Decimal, mark: Decimal): Decimal {
  return qty.mul(side === "LONG" ? mark.minus(entry) : entry.minus(mark));
}

/** M + uPnL, never below 0 (the loss is capped at the margin). */
export function positionEquity(margin: Decimal, uPnl: Decimal): Decimal {
  return max(ZERO, margin.plus(uPnl));
}

/** M + uPnL ≤ Q·P·mmr. */
export function isLiquidatable(pos: MarginPosition, mark: Decimal): boolean {
  const equity = pos.margin.plus(unrealizedPnl(pos.side, pos.qty, pos.entry, mark));
  return equity.lte(maintenanceMargin(pos.qty, mark, pos.mmrBps));
}

/** The mark at which the position becomes liquidatable (a 1x long: 0). */
export function liquidationPrice(pos: MarginPosition): Decimal {
  const mmr = mmRate(pos.mmrBps);
  const cost = pos.qty.mul(pos.entry);
  if (pos.side === "LONG") {
    return max(ZERO, cost.minus(pos.margin).div(pos.qty.mul(ONE.minus(mmr))));
  }
  return cost.plus(pos.margin).div(pos.qty.mul(ONE.plus(mmr)));
}

/**
 * A position's liq price to show, null when it has none. A long at 1x can't
 * be liquidated, whatever is stored: margin rounds down to 8 dp, so its
 * liq_price is usually dust (cost − margin > 0), not 0.
 */
export function shownLiqPrice<T extends number | Decimal>(side: MarginSide, leverage: number | Decimal, liq: T | null): T | null {
  if (liq === null || !(Number(liq) > 0)) return null;
  return side === "LONG" && Number(leverage) <= 1 ? null : liq;
}

/** The mark at which equity reaches 0 (long floored at 0). */
export function bankruptcyPrice(pos: Pick<MarginPosition, "side" | "qty" | "entry" | "margin">): Decimal {
  const perUnit = pos.margin.div(pos.qty);
  return pos.side === "LONG" ? max(ZERO, pos.entry.minus(perUnit)) : pos.entry.plus(perUnit);
}

/** Health bar: 1 at entry, 0 at the liq price, clamped to [0, 1]. */
export function marginHealth(pos: MarginPosition, mark: Decimal): Decimal {
  const equity = pos.margin.plus(unrealizedPnl(pos.side, pos.qty, pos.entry, mark));
  const buffer = equity.minus(maintenanceMargin(pos.qty, mark, pos.mmrBps));
  const full = pos.margin.minus(maintenanceMargin(pos.qty, pos.entry, pos.mmrBps));
  if (full.lte(ZERO)) return ZERO;
  return min(ONE, max(ZERO, buffer.div(full)));
}

const dp8 = (d: Decimal) => d.todp(8, Decimal.ROUND_DOWN);

/**
 * An add of `addQty` at `price` to an open position, the way the engine
 * books it (apps/api isolatedPosition.applyIsolatedFill, increase):
 * Q += Δq, E = size-weighted average, M += Δq·p / L, each rounded down to
 * 8 dp like the position columns; then the liq price of the result
 * (0 = can't be liquidated). L is the position's leverage (an add must match it).
 */
export function increasePosition(
  pos: MarginPosition,
  addQty: Decimal,
  price: Decimal,
  leverage: Decimal,
): { qty: Decimal; entry: Decimal; margin: Decimal; liqPrice: Decimal } {
  const qty = pos.qty.plus(addQty);
  const entry = dp8(pos.qty.mul(pos.entry).plus(addQty.mul(price)).div(qty));
  const margin = pos.margin.plus(dp8(addQty.mul(price).div(leverage)));
  const liqPrice = dp8(liquidationPrice({ side: pos.side, qty, entry, margin, mmrBps: pos.mmrBps }));
  return { qty, entry, margin, liqPrice };
}

/** M·Δq/Q. */
export function releasedMargin(margin: Decimal, closeQty: Decimal, posQty: Decimal): Decimal {
  if (closeQty.gte(posQty)) return margin;
  return margin.mul(closeQty).div(posQty);
}

export type ReduceSettlement = {
  credit: Decimal;
  bookedPnl: Decimal;
  bookedFee: Decimal;
  uncollectedFee: Decimal;
  shortfall: Decimal;
};

/** A reduce with the loss capped at the released margin (see the server copy). */
export function settleReduce(released: Decimal, pnl: Decimal, fee: Decimal): ReduceSettlement {
  const left = released.plus(pnl);
  const bookedFee = min(fee, max(ZERO, left));
  return {
    credit: max(ZERO, left.minus(fee)),
    bookedPnl: max(pnl, released.neg()),
    bookedFee,
    uncollectedFee: fee.minus(bookedFee),
    shortfall: max(ZERO, left.neg()),
  };
}

/** A finite number ≥ 1 and ≤ cap, with at most 2 decimals. */
export function isValidLeverage(leverage: number, cap: number): boolean {
  return Number.isFinite(leverage)
    && leverage >= 1
    && leverage <= cap
    && Math.round(leverage * 100) === leverage * 100;
}
