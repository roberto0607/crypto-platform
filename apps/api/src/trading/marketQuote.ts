/**
 * marketQuote.ts — what a MARKET order would do right now, without placing it:
 * the order panel's preview and its presets (GET /v1/sim/quote).
 *
 * Same inputs as the matching engine: the same reference, the internal resting
 * orders inside the collar first, then marketFillPrice for the remainder. It
 * reads without the pair lock, so on a moving book it's an estimate; on a
 * static book it's the fill.
 *
 * `budget` asks the other question: how much can this margin open at this
 * leverage? Margin and fee are paid on the fill, not the mid, so the answer
 * has to come from the same curve. It leaves DRIFT_BUFFER_BPS of room for the
 * price moving between the click and the fill, and stays under the pair's cap.
 */
import Decimal from "decimal.js";
import { pool } from "../db/pool";
import { D, ZERO, BPS_DIVISOR, toFixed8 } from "../utils/decimal";
import { AppError } from "../errors/AppError";
import { getSnapshotForUser } from "../replay/replayEngine";
import { resolveSimulationConfig } from "../sim/simConfigRepo";
import { computeMarketExecution } from "../sim/slippageModel";
import { getLatestSimCandle } from "../sim/simCandleRepo";
import { computeFee } from "./feeCalc";
import { findPairById, type PairRow } from "./pairRepo";
import { fetchRestingOrdersBatch, type BookCursor } from "./orderRepo";
import { collarBand, getMarketReference, systemFillPrice, type CollarReference } from "./priceCollar";
import { fillModelOf, priceMarketFill, type FillModel, type MarketFill } from "./marketFillPrice";

/** Room a budget leaves for the price moving before the order reaches the engine. */
export const DRIFT_BUFFER_BPS = 25;
const SOLVE_STEPS = 48;

export type MarketQuote = {
    executable: boolean;
    /** Why not: order_too_large, book_stale_for_size or stale_price_source. */
    reason: string | null;
    qty: string;
    /** The touch the order crosses. */
    touchPrice: string;
    /** Average fill. */
    estimatedPrice: string;
    /** Average fill vs the touch, in bps; negative when resting orders beat it. */
    slippage_bps: string;
    /** The same, in quote. */
    slippageQuote: string;
    /** qty × average fill. */
    requestedNotional: string;
    feeQuote: string;
    maxOrderNotional: string;
};

function levelsFor(ref: CollarReference, side: "BUY" | "SELL") {
    return side === "BUY" ? ref.levels?.asks : ref.levels?.bids;
}

/** The internal resting orders a MARKET order would take first: what they fill, and for how much. */
async function restingInCollar(
    userId: string, pairId: string, side: "BUY" | "SELL", ref: CollarReference, qty: Decimal,
): Promise<{ qty: Decimal; quote: Decimal }> {
    const band = collarBand(ref, side);
    let left = qty;
    let quote = ZERO;
    let cursor: BookCursor | undefined;
    const batchSize = 100;
    while (left.gt(0)) {
        const batch = await fetchRestingOrdersBatch(pool, pairId, side === "BUY" ? "SELL" : "BUY", {
            priceMin: band.min.toFixed(8),
            priceMax: band.max.toFixed(8),
            excludeUserId: userId,
            cursor,
            batchSize,
        });
        for (const o of batch) {
            if (left.lte(0)) break;
            const take = Decimal.min(left, D(o.qty).minus(D(o.qty_filled)));
            quote = quote.plus(take.mul(D(o.limit_price!)));
            left = left.minus(take);
        }
        if (batch.length < batchSize) break;
        const last = batch[batch.length - 1];
        cursor = { limitPrice: last.limit_price!, createdAt: last.created_at };
    }
    return { qty: qty.minus(left), quote };
}

/**
 * Largest qty whose margin + fee fit `budget`, net of the drift buffer, and
 * whose notional stays under the cap. Cost only grows with qty, so bisect.
 * Resting orders are ignored: they can only make the fill cheaper. With no
 * depth, stops at the touch band: anything above it would be rejected.
 */
function solveBudget(input: {
    budget: Decimal; leverage: Decimal; feeBps: Decimal; last: Decimal; maxNotional: Decimal;
    fillAt: (qty: Decimal) => MarketFill | null; touch: Decimal; model: FillModel;
}): Decimal {
    const { budget, leverage, feeBps, last, maxNotional, fillAt, touch, model } = input;
    const keep = D(1).minus(D(DRIFT_BUFFER_BPS).div(BPS_DIVISOR));
    const spend = budget.mul(keep);
    const perQuote = D(1).div(leverage).plus(feeBps.div(BPS_DIVISOR));
    const capQty = maxNotional.mul(keep).div(last);

    let hi = Decimal.min(spend.div(perQuote).div(touch), capQty);
    if (!fillAt(hi)) hi = Decimal.min(hi, model.touchBandQuote.div(touch));
    const fits = (q: Decimal) => {
        const fill = fillAt(q);
        return fill !== null && q.mul(fill.price).mul(perQuote).lte(spend);
    };
    if (fits(hi)) return hi.toDecimalPlaces(8, Decimal.ROUND_DOWN);

    let lo = ZERO;
    for (let i = 0; i < SOLVE_STEPS; i++) {
        const mid = lo.plus(hi).div(2);
        if (fits(mid)) lo = mid;
        else hi = mid;
    }
    return lo.toDecimalPlaces(8, Decimal.ROUND_DOWN);
}

function feeBpsOf(pair: PairRow, userId: string): Decimal {
    return D(computeFee("10000", "TAKER", pair, userId).feeAmount);
}

export async function quoteMarketOrder(input: {
    userId: string;
    pairId: string;
    side: "BUY" | "SELL";
    /** Exactly one of qty / budget. */
    qty?: string;
    budget?: string;
    leverage?: number;
}): Promise<MarketQuote> {
    const { userId, pairId, side } = input;
    const pair = await findPairById(pairId);
    if (!pair) throw new AppError("pair_not_found");

    const snapshot = await getSnapshotForUser(userId, pairId);
    const simConfig = await resolveSimulationConfig(userId, pairId);
    const model = fillModelOf(simConfig);
    const last = D(snapshot.last);
    const maxNotional = D(pair.max_order_notional);
    const replay = snapshot.source === "replay";

    let ref: CollarReference | null = null;
    if (!replay) ref = await getMarketReference(pairId, pair.symbol);

    const unavailable = (reason: string, qty: Decimal, touch: Decimal): MarketQuote => ({
        executable: false, reason, qty: toFixed8(qty), touchPrice: toFixed8(touch),
        estimatedPrice: toFixed8(ZERO), slippage_bps: toFixed8(ZERO), slippageQuote: toFixed8(ZERO),
        requestedNotional: toFixed8(qty.mul(last)), feeQuote: toFixed8(ZERO), maxOrderNotional: maxNotional.toFixed(2),
    });

    const requested = D(input.qty ?? "0");
    if (!replay && !ref) return unavailable("stale_price_source", requested, ZERO);

    // The price curve this order sits on: the book, or a replay session's candle.
    const candle = replay ? await getLatestSimCandle(pairId, snapshot.ts) : null;
    const replayPrice = (qty: Decimal) => D(computeMarketExecution(
        snapshot, side, toFixed8(qty), simConfig, candle?.volume ?? null, candle?.high ?? null, candle?.low ?? null,
    ).execPrice);
    const touch = ref ? systemFillPrice(ref, side) : last;
    const fillAt = (qty: Decimal): MarketFill | null => {
        if (!ref) {
            const price = replayPrice(qty);
            return { price, slippageBps: ZERO, beyondBookQty: ZERO };
        }
        return priceMarketFill({ levels: levelsFor(ref, side), touch, side, qty, model });
    };

    const qty = input.budget !== undefined
        ? solveBudget({
            budget: D(input.budget), leverage: D(input.leverage ?? 1), feeBps: feeBpsOf(pair, userId),
            last, maxNotional, fillAt, touch, model,
        })
        : requested;

    if (qty.mul(last).gt(maxNotional)) return unavailable("order_too_large", qty, touch);

    const resting = ref ? await restingInCollar(userId, pairId, side, ref, qty) : { qty: ZERO, quote: ZERO };
    const remainder = qty.minus(resting.qty);
    const fill = remainder.gt(0) ? fillAt(remainder) : null;
    if (remainder.gt(0) && !fill) return unavailable("book_stale_for_size", qty, touch);

    const notional = resting.quote.plus(fill ? remainder.mul(D(toFixed8(fill.price))) : ZERO);
    const average = qty.gt(0) ? notional.div(qty) : touch;
    const worse = side === "BUY" ? average.minus(touch) : touch.minus(average);
    const noteFee = toFixed8(notional);

    return {
        executable: true,
        reason: null,
        qty: toFixed8(qty),
        touchPrice: toFixed8(touch),
        estimatedPrice: toFixed8(average),
        slippage_bps: toFixed8(touch.gt(0) ? worse.div(touch).mul(BPS_DIVISOR) : ZERO),
        slippageQuote: toFixed8(worse.mul(qty)),
        requestedNotional: noteFee,
        feeQuote: computeFee(noteFee, "TAKER", pair, userId).feeAmount,
        maxOrderNotional: maxNotional.toFixed(2),
    };
}
