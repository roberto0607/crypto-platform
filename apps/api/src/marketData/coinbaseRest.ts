/**
 * Coinbase Advanced Trade REST client for fetching historical OHLCV data.
 *
 * Docs: https://docs.cdp.coinbase.com/advanced-trade/reference/retailbrokerageapi_getcandles
 *
 * Public endpoint — no authentication required.
 * Returns up to 300 candles per request.
 * Pagination: use `start` and `end` Unix timestamps to page through history.
 *
 * Granularities: ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, ONE_HOUR, SIX_HOUR, ONE_DAY
 * (no native 4h — roll up from 1h)
 */

const COINBASE_BASE_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";

/** Map our pair symbols → Coinbase product IDs */
export const CB_PAIR_MAP: Record<string, string> = {
    "BTC/USD": "BTC-USD",
    "ETH/USD": "ETH-USD",
    "SOL/USD": "SOL-USD",
};

/** Coinbase granularity enum values */
export type CoinbaseGranularity =
    | "ONE_MINUTE"
    | "FIVE_MINUTE"
    | "FIFTEEN_MINUTE"
    | "ONE_HOUR"
    | "SIX_HOUR"
    | "ONE_DAY";

/** Map our timeframe codes → Coinbase granularity + seconds per candle */
export const TF_TO_GRANULARITY: Record<string, { granularity: CoinbaseGranularity; candleSeconds: number }> = {
    "1m":  { granularity: "ONE_MINUTE",      candleSeconds: 60 },
    "5m":  { granularity: "FIVE_MINUTE",     candleSeconds: 300 },
    "15m": { granularity: "FIFTEEN_MINUTE",  candleSeconds: 900 },
    "1h":  { granularity: "ONE_HOUR",        candleSeconds: 3600 },
    "1d":  { granularity: "ONE_DAY",         candleSeconds: 86400 },
};

export interface OHLCEntry {
    time: number;     // Unix timestamp (seconds)
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

/**
 * Fetch a page of candles from Coinbase Advanced Trade REST API.
 *
 * @param productId  e.g. "BTC-USD"
 * @param granularity  e.g. "ONE_HOUR"
 * @param start  Unix timestamp (seconds) — inclusive lower bound
 * @param end    Unix timestamp (seconds) — inclusive upper bound
 * @returns Array of candles sorted ascending by time
 */
export async function fetchCoinbaseCandles(
    productId: string,
    granularity: CoinbaseGranularity,
    start: number,
    end: number,
): Promise<OHLCEntry[]> {
    const url =
        `${COINBASE_BASE_URL}/${productId}/candles` +
        `?granularity=${granularity}&start=${start}&end=${end}`;

    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Coinbase candles HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as {
        candles: Array<{
            start: string;   // Unix timestamp (seconds) as string
            low: string;
            high: string;
            open: string;
            close: string;
            volume: string;
        }>;
    };

    if (!json.candles || json.candles.length === 0) {
        return [];
    }

    // Coinbase returns newest-first — reverse to ascending
    const entries: OHLCEntry[] = json.candles.map((c) => ({
        time: parseInt(c.start, 10),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
    }));

    entries.sort((a, b) => a.time - b.time);
    return entries;
}

/**
 * Sleep for `ms` milliseconds. Used for rate limiting.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
