/**
 * marketFillPrice.ts — what a system fill pays: one pure model for MARKET
 * orders, liquidations and match-end closes, so no way out of a position
 * avoids slippage.
 *
 * For `qty` against one side of the real Kraken book:
 *   1. Touch band: the first `touchBandQuote` of notional fills at the touch.
 *      An order inside it fills exactly at the touch, as it always has, and
 *      needs no depth (a ticker reference is enough).
 *   2. Book walk: the rest walks the levels, starting where the band's share
 *      of the book ends. So there is no jump at the band's edge: one dollar
 *      over it costs one dollar's worth of walking.
 *   3. Beyond the book: anything left starts at the last level and pays a
 *      linear impact, `impactBpsPerBand` for each band of quote. The average
 *      over that stretch is half its end impact. Bounded by MAX_BEYOND_BOOK_BPS
 *      because reduce-only closes have no size cap, and a SELL must stay > 0.
 *
 * The result is one volume-weighted price, deterministic given the book.
 * Above the band with no depth to walk it returns null: the caller decides.
 * An order that opens or adds rejects; one that only shrinks the position, and
 * match end, fill at the touch.
 */
import Decimal from "decimal.js";
import { D, ZERO, BPS_DIVISOR } from "../utils/decimal";
import type { SimulationConfig } from "../sim/simTypes";

/** End impact past the book, in bps: the average there is at most half of it. */
export const MAX_BEYOND_BOOK_BPS = 5000;

export type FillModel = {
    /** Notional filled at the touch (simulation_settings.liquidity_quote_per_tick). */
    touchBandQuote: Decimal;
    /** Bps of impact per touchBandQuote past the book (.impact_bps_per_10k_quote, despite the name). */
    impactBpsPerBand: Decimal;
};

export function fillModelOf(cfg: Pick<SimulationConfig, "liquidity_quote_per_tick" | "impact_bps_per_10k_quote">): FillModel {
    return { touchBandQuote: D(cfg.liquidity_quote_per_tick), impactBpsPerBand: D(cfg.impact_bps_per_10k_quote) };
}

export type DepthLevel = { price: number; qty: number };

export type MarketFill = {
    /** Volume-weighted fill price. */
    price: Decimal;
    /** How far it is from the touch, always >= 0 (worse for the taker). */
    slippageBps: Decimal;
    /** Base quantity priced past the last visible level. */
    beyondBookQty: Decimal;
};

export function priceMarketFill(input: {
    /** The side the taker crosses, best first (asks for a BUY, bids for a SELL). */
    levels: readonly DepthLevel[] | undefined;
    touch: Decimal;
    side: "BUY" | "SELL";
    qty: Decimal;
    model: FillModel;
}): MarketFill | null {
    const { levels, touch, side, qty, model } = input;

    if (qty.mul(touch).lte(model.touchBandQuote)) {
        return { price: touch, slippageBps: ZERO, beyondBookQty: ZERO };
    }
    if (!levels || levels.length === 0) return null;

    const bandQty = model.touchBandQuote.div(touch);
    let cost = model.touchBandQuote;
    let left = qty.minus(bandQty);
    let skip = bandQty;
    let last = touch;

    for (const level of levels) {
        if (left.lte(0)) break;
        const price = D(String(level.price));
        let available = D(String(level.qty));
        last = price;
        if (skip.gte(available)) {
            skip = skip.minus(available);
            continue;
        }
        available = available.minus(skip);
        skip = ZERO;
        const take = Decimal.min(left, available);
        cost = cost.plus(take.mul(price));
        left = left.minus(take);
    }

    const beyondBookQty = Decimal.max(left, ZERO);
    if (beyondBookQty.gt(0)) {
        const excessQuote = beyondBookQty.mul(last);
        const endBps = model.touchBandQuote.gt(0)
            ? Decimal.min(excessQuote.div(model.touchBandQuote).mul(model.impactBpsPerBand), MAX_BEYOND_BOOK_BPS)
            : D(MAX_BEYOND_BOOK_BPS);
        const averageMove = endBps.div(2).div(BPS_DIVISOR);
        const price = last.mul(side === "BUY" ? D(1).plus(averageMove) : D(1).minus(averageMove));
        cost = cost.plus(beyondBookQty.mul(price));
    }

    const price = cost.div(qty);
    const slippageBps = price.minus(touch).abs().div(touch).mul(BPS_DIVISOR);
    return { price, slippageBps, beyondBookQty };
}
