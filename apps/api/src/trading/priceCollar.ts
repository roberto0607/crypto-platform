/**
 * priceCollar.ts — market-order price collar against the real Kraken book.
 *
 * A MARKET order may only fill against internal resting orders priced within
 * `collarBps` of the real Kraken touch: resting asks vs Kraken's best ask (taker
 * BUY), resting bids vs Kraken's best bid (taker SELL). Resting orders outside
 * the band — on either side of it — are skipped, never swept.
 *
 * Why: both 2026-10-01 bad BTC/USD fills were market orders sweeping market-
 * maker quotes that had gone stale while the real market moved. The internal
 * book alone can't tell a stale quote from a live one; the external book can.
 *
 * The same reference prices the system-fill remainder (best ask for a BUY,
 * best bid for a SELL — no synthetic spread) and gates which fills may move
 * trading_pairs.last_price. Resolution (getMarketReference):
 *   1. the Kraken WS `book` channel state (orderFlowFeatures.bookSnapshots,
 *      in-process, updated on every book message), if ≤ MARKET_COLLAR_MAX_BOOK_AGE_MS;
 *   2. else the Kraken ticker snapshot's bid/ask, if ≤ MARKET_TICKER_MAX_AGE_MS
 *      (the snapshot store's 10s TTL — the rule the execution agent rejects on);
 *   3. else nothing: the caller rejects the order (stale_price_source). Never
 *      trading_pairs.last_price, which has no staleness bound at all.
 */
import Decimal from "decimal.js";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { getSnapshot } from "../market/snapshotStore";
import { config } from "../config";
import { D, BPS_DIVISOR } from "../utils/decimal";

export type CollarReference = {
    bestBid: Decimal;
    bestAsk: Decimal;
    ageMs: number;
    /** book/ticker = live Kraken; replay = a solo replay session's historical price. */
    source: "book" | "ticker" | "replay";
};

export type CollarBand = { min: Decimal; max: Decimal };

/**
 * Fresh Kraken best bid/ask for a pair, or null when there is no trustworthy
 * reference (no book yet, book older than maxAgeMs, empty side, crossed book).
 */
export function getCollarReference(
    pairId: string,
    now: number = Date.now(),
    maxAgeMs: number = config.marketCollarMaxBookAgeMs,
): CollarReference | null {
    const book = bookSnapshots.get(pairId);
    if (!book) return null;

    const ageMs = now - book.ts;
    if (ageMs > maxAgeMs) return null;

    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (!(bid > 0) || !(ask > 0)) return null;
    if (bid > ask) return null; // crossed — the book state is wrong, not the market

    return { bestBid: D(String(bid)), bestAsk: D(String(ask)), ageMs, source: "book" };
}

/**
 * The live market reference for a pair: fresh Kraken book, else fresh Kraken
 * ticker bid/ask, else null (→ stale_price_source).
 */
export async function getMarketReference(
    pairId: string,
    symbol: string,
    now: number = Date.now(),
): Promise<CollarReference | null> {
    const book = getCollarReference(pairId, now);
    if (book) return book;

    const ticker = await getSnapshot(symbol, config.marketTickerMaxAgeMs);
    if (!ticker || ticker.source !== "live") return null;
    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);
    if (!(bid > 0) || !(ask > 0) || bid > ask) return null;
    const ts = Date.parse(ticker.ts);
    return {
        bestBid: D(ticker.bid!),
        bestAsk: D(ticker.ask!),
        ageMs: Number.isFinite(ts) ? Math.max(0, now - ts) : 0,
        source: "ticker",
    };
}

/** Price a system fill takes: the touch the taker crosses (best ask for BUY, best bid for SELL). */
export function systemFillPrice(ref: CollarReference, takerSide: "BUY" | "SELL"): Decimal {
    return takerSide === "BUY" ? ref.bestAsk : ref.bestBid;
}

/**
 * Whether a fill at `price` may become trading_pairs.last_price: only a live
 * reference, and only within the collar of the real touch (≥ bid − collar,
 * ≤ ask + collar). Keeps an off-market print — a stale-quote sweep, an
 * uncollared LIMIT cross, a replay fill — from poisoning the live price.
 */
export function isOnMarket(
    price: Decimal,
    ref: CollarReference | null,
    collarBps: number = config.marketCollarBps,
): boolean {
    if (!ref || ref.source === "replay") return false;
    const min = ref.bestBid.minus(ref.bestBid.mul(collarBps).div(BPS_DIVISOR));
    const max = ref.bestAsk.plus(ref.bestAsk.mul(collarBps).div(BPS_DIVISOR));
    return price.gte(min) && price.lte(max);
}

/**
 * Price band a taker may fill resting orders inside. Inclusive on both ends.
 *
 * Taker BUY sweeps resting asks: never above Kraken's best ask (the system
 * fill there is cheaper), and no more than the collar below it (a quote that
 * far under market is stale, not a bargain). Taker SELL mirrors it on the bid:
 * never below the best bid, at most the collar above it. So every MARKET fill
 * is at the touch or better; MM quotes only trade with a taker when they have
 * drifted to the taker's side of the touch.
 */
export function collarBand(
    ref: CollarReference,
    takerSide: "BUY" | "SELL",
    collarBps: number = config.marketCollarBps,
): CollarBand {
    if (takerSide === "BUY") {
        const offset = ref.bestAsk.mul(collarBps).div(BPS_DIVISOR);
        return { min: ref.bestAsk.minus(offset), max: ref.bestAsk };
    }
    const offset = ref.bestBid.mul(collarBps).div(BPS_DIVISOR);
    return { min: ref.bestBid, max: ref.bestBid.plus(offset) };
}

export function isWithinCollar(price: Decimal | string, band: CollarBand): boolean {
    const p = D(price.toString());
    return p.gte(band.min) && p.lte(band.max);
}
