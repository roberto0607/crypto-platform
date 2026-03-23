/**
 * CryptoCompare REST client for fetching deep historical OHLCV data.
 *
 * Docs: https://developers.coindesk.com/documentation/legacy/Historical/dataHistoday
 *
 * Public endpoints — no API key required (rate limited by IP).
 * Returns up to 2000 candles per request.
 * Pagination: use `toTs` parameter to walk backwards through history.
 *
 * Rate limits (free, no key):
 *   5/sec, 300/min, 3,000/hr, 7,500/day
 *
 * Available endpoints:
 *   histoday    — full history (BTC→2010, ETH→2015, SOL→2020)
 *   histohour   — full history per coin
 *   histominute — last 7 days only (same as Coinbase, not useful here)
 */

const CC_BASE_URL = "https://min-api.cryptocompare.com/data/v2";

/** Map our pair symbols → CryptoCompare fsym/tsym */
export const CC_PAIR_MAP: Record<string, { fsym: string; tsym: string }> = {
    "BTC/USD": { fsym: "BTC", tsym: "USD" },
    "ETH/USD": { fsym: "ETH", tsym: "USD" },
    "SOL/USD": { fsym: "SOL", tsym: "USD" },
};

export type CCEndpoint = "histoday" | "histohour" | "histominute";

export interface OHLCEntry {
    time: number;     // Unix timestamp (seconds)
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface CCPage {
    candles: OHLCEntry[];
    timeFrom: number;   // earliest timestamp in response (for pagination)
    timeTo: number;     // latest timestamp in response
}

/**
 * Fetch a page of candles from CryptoCompare.
 *
 * @param endpoint  "histoday" | "histohour" | "histominute"
 * @param fsym      e.g. "BTC"
 * @param tsym      e.g. "USD"
 * @param limit     max candles to return (1-2000)
 * @param toTs      Unix timestamp — return candles ending at this time (0 = latest)
 * @returns Page of candles sorted ascending by time, plus pagination cursors
 */
export async function fetchCCCandles(
    endpoint: CCEndpoint,
    fsym: string,
    tsym: string,
    limit: number = 2000,
    toTs: number = 0,
): Promise<CCPage> {
    let url = `${CC_BASE_URL}/${endpoint}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
    if (toTs > 0) {
        url += `&toTs=${toTs}`;
    }

    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`CryptoCompare ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as {
        Response: string;
        Message: string;
        Data: {
            TimeFrom: number;
            TimeTo: number;
            Data: Array<{
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volumefrom: number;
                volumeto: number;
            }>;
        };
    };

    if (json.Response !== "Success") {
        throw new Error(`CryptoCompare ${endpoint} error: ${json.Message}`);
    }

    const raw = json.Data.Data;
    if (!raw || raw.length === 0) {
        return { candles: [], timeFrom: 0, timeTo: 0 };
    }

    // Filter out zero-data candles (CryptoCompare returns placeholders with all zeros
    // for timestamps before the coin existed)
    const candles: OHLCEntry[] = raw
        .filter((c) => c.open > 0 || c.high > 0 || c.close > 0 || c.volumefrom > 0)
        .map((c) => ({
            time: c.time,
            open: c.open.toString(),
            high: c.high.toString(),
            low: c.low.toString(),
            close: c.close.toString(),
            volume: c.volumefrom.toString(),  // volumefrom = volume in base asset (BTC, ETH, etc.)
        }));

    return {
        candles,
        timeFrom: json.Data.TimeFrom,
        timeTo: json.Data.TimeTo,
    };
}

/**
 * Fetch ALL daily candles using the allData=true shortcut.
 * Returns the complete history in a single request.
 */
export async function fetchCCAllDaily(
    fsym: string,
    tsym: string,
): Promise<OHLCEntry[]> {
    const url = `${CC_BASE_URL}/histoday?fsym=${fsym}&tsym=${tsym}&allData=true`;

    const res = await fetch(url);
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`CryptoCompare histoday allData HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = await res.json() as {
        Response: string;
        Message: string;
        Data: {
            Data: Array<{
                time: number;
                open: number;
                high: number;
                low: number;
                close: number;
                volumefrom: number;
            }>;
        };
    };

    if (json.Response !== "Success") {
        throw new Error(`CryptoCompare histoday allData error: ${json.Message}`);
    }

    return (json.Data.Data ?? [])
        .filter((c) => c.open > 0 || c.high > 0 || c.close > 0 || c.volumefrom > 0)
        .map((c) => ({
            time: c.time,
            open: c.open.toString(),
            high: c.high.toString(),
            low: c.low.toString(),
            close: c.close.toString(),
            volume: c.volumefrom.toString(),
        }));
}

/**
 * Sleep for `ms` milliseconds. Used for rate limiting.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
