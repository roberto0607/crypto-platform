/**
 * Which exchange's live feed builds a symbol's 1m candles.
 *
 * The live aggregator and the Kraken REST sync (krakenCandleSyncJob) both
 * write the same 1m rows: live writes a minute the moment it closes, then
 * Kraken REST replaces it with Kraken's authoritative OHLC (it re-syncs the
 * last 15 minutes every 60s, so REST wins for every finished minute). If the
 * live candle were built from a different exchange than the REST one, every
 * stored minute would jump when REST replaced it. So a symbol Kraken REST
 * syncs is aggregated from the Kraken feed only; every other symbol from
 * Coinbase trades.
 */
import { REST_PAIR_MAP } from "./krakenRest.js";

export type CandleSource = "kraken" | "coinbase";

export function candleSourceFor(ourSymbol: string): CandleSource {
    return REST_PAIR_MAP[ourSymbol] ? "kraken" : "coinbase";
}
