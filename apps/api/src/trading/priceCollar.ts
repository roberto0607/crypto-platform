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
 * The reference is the Kraken WS `book` channel state kept in
 * orderFlowFeatures.bookSnapshots (in-process, updated on every book message).
 * If it is missing, older than `maxAgeMs`, one-sided, or crossed, there is no
 * trustworthy reference and the caller rejects the order (stale_price_source).
 */
import Decimal from "decimal.js";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { config } from "../config";
import { D, BPS_DIVISOR } from "../utils/decimal";

export type CollarReference = {
    bestBid: Decimal;
    bestAsk: Decimal;
    ageMs: number;
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

    return { bestBid: D(String(bid)), bestAsk: D(String(ask)), ageMs };
}

/**
 * Price band a taker may fill inside. Taker BUY sweeps resting asks, so the
 * band is centred on Kraken's best ask; taker SELL sweeps bids → best bid.
 * Inclusive on both ends.
 */
export function collarBand(
    ref: CollarReference,
    takerSide: "BUY" | "SELL",
    collarBps: number = config.marketCollarBps,
): CollarBand {
    const center = takerSide === "BUY" ? ref.bestAsk : ref.bestBid;
    const offset = center.mul(collarBps).div(BPS_DIVISOR);
    return { min: center.minus(offset), max: center.plus(offset) };
}

export function isWithinCollar(price: Decimal | string, band: CollarBand): boolean {
    const p = D(price.toString());
    return p.gte(band.min) && p.lte(band.max);
}
