/**
 * Kraken REST API client for fetching historical OHLC data.
 *
 * Docs: https://docs.kraken.com/api/docs/rest-api/get-ohlc-data/
 *
 * Response array format per entry: [time, open, high, low, close, vwap, volume, count]
 * Returns up to 720 entries per request.
 * The `last` field in the response is the cursor for pagination.
 */

const KRAKEN_BASE_URL = "https://api.kraken.com/0/public";

/** Map our pair symbols → Kraken REST pair names */
export const REST_PAIR_MAP: Record<string, string> = {
    "BTC/USD": "XBTUSD",
    "ETH/USD": "ETHUSD",
    "SOL/USD": "SOLUSD",
};

export interface OHLCEntry {
    time: number;     // Unix timestamp (seconds)
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
}

export interface OHLCPage {
    candles: OHLCEntry[];
    last: number;     // cursor for next `since` parameter
}

/**
 * Fetch a page of OHLC data from Kraken REST API.
 *
 * @param krakenPair  e.g. "XBTUSD"
 * @param interval    minutes: 1, 5, 15, 30, 60, 240, 1440
 * @param since       Unix timestamp — fetch entries after this time (0 = from beginning)
 */
export async function fetchOHLC(
    krakenPair: string,
    interval: number,
    since: number = 0,
): Promise<OHLCPage> {
    const url = `${KRAKEN_BASE_URL}/OHLC?pair=${krakenPair}&interval=${interval}&since=${since}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
        throw new Error(`Kraken OHLC HTTP ${res.status}: ${await res.text()}`);
    }

    const json = await res.json() as {
        error: string[];
        result: Record<string, unknown>;
    };

    if (json.error && json.error.length > 0) {
        throw new Error(`Kraken OHLC error: ${json.error.join(", ")}`);
    }

    // The result key is the Kraken-internal pair name (e.g. "XXBTZUSD" or "XBTUSD")
    // plus a "last" key. Find the data key by excluding "last".
    const resultKeys = Object.keys(json.result).filter((k) => k !== "last");
    const dataKey = resultKeys[0];
    if (!dataKey) {
        return { candles: [], last: since };
    }

    const rawEntries = json.result[dataKey] as Array<
        [number, string, string, string, string, string, string, number]
    >;
    const last = json.result.last as number;

    const candles: OHLCEntry[] = rawEntries.map((e) => ({
        time: e[0],
        open: e[1],
        high: e[2],
        low: e[3],
        close: e[4],
        // e[5] = vwap (skip)
        volume: e[6],
        // e[7] = count (skip)
    }));

    return { candles, last };
}

/**
 * Sleep for `ms` milliseconds. Used for rate limiting.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
