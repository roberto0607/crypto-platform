/**
 * Closed higher-timeframe candles for the HTF moving averages (e.g. the daily
 * SMA 200 on a 4h chart), cached per pair + timeframe for the session.
 *
 * The chart never waits on this: `peekHtfCandles` answers synchronously with
 * what is cached (or null) and, when that isn't enough, starts one fetch in
 * the background; `onLoad` runs when new candles land so the chart redraws.
 *
 * - Only CLOSED bars are kept: the API's forming bucket (`partial`) is dropped.
 * - Enough history for the warm-up: the caller asks for N bars (line length +
 *   the span the chart shows); a bigger ask refetches with the bigger limit
 *   (one request, API max 5000), a smaller one reuses the cache.
 * - Refreshed only when a newer HTF bar has closed since the fetch (the last
 *   cached bar + 2 periods is in the past) — so a daily line refetches about
 *   once a day, not on every 4h candle (and at most once a minute while the
 *   API hasn't stored the just-closed bar yet).
 * - A failed fetch isn't retried for 30 s (no request loop).
 */
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { TIMEFRAME_SEC, type HtfTimeframe } from "./sharedIndicators";

const API_MAX_LIMIT = 5000;
const RETRY_AFTER_MS = 30_000;
/** A just-closed bar can take a moment to be stored: re-ask at most this often. */
const STALE_REFETCH_MS = 60_000;

interface Entry {
    /** Closed candles, oldest first. */
    candles: Candle[];
    /** The limit they were fetched with. */
    limit: number;
    /** The API had fewer closed bars than asked: no older history exists. */
    complete: boolean;
    inflight: Promise<void> | null;
    /** Limit of the in-flight request. */
    inflightLimit: number;
    fetchedAt: number;
    failedAt: number;
}

const cache = new Map<string, Entry>();
const key = (pairId: string, tf: HtfTimeframe) => `${pairId}:${tf}`;

/** Does the entry miss a bar that has closed by `nowMs`? */
function stale(e: Entry, tf: HtfTimeframe, nowMs: number): boolean {
    if (nowMs - e.fetchedAt < STALE_REFETCH_MS) return false;
    const last = e.candles[e.candles.length - 1];
    if (!last) return true;
    return nowMs >= Date.parse(last.ts) + 2 * TIMEFRAME_SEC[tf] * 1000;
}

function enough(e: Entry, bars: number): boolean {
    return e.complete || e.candles.length >= bars;
}

function load(pairId: string, tf: HtfTimeframe, limit: number, onLoad: () => void, nowMs: number): void {
    const k = key(pairId, tf);
    const entry: Entry = cache.get(k) ?? { candles: [], limit: 0, complete: false, inflight: null, inflightLimit: 0, fetchedAt: 0, failedAt: 0 };
    cache.set(k, entry);
    // +1: the latest page ends with the forming bucket, which is dropped.
    const request = Math.min(API_MAX_LIMIT, limit + 1);
    entry.inflightLimit = limit;
    entry.inflight = getCandles(pairId, { timeframe: tf as Timeframe, limit: request })
        .then((res) => {
            const closed = res.data.candles.filter((c) => !c.partial);
            entry.candles = closed;
            entry.limit = limit;
            entry.complete = closed.length < limit;
            entry.fetchedAt = nowMs;
            entry.failedAt = 0;
            onLoad();
        })
        .catch(() => {
            entry.failedAt = nowMs;
        })
        .finally(() => {
            entry.inflight = null;
            entry.inflightLimit = 0;
        });
}

/**
 * The cached closed candles for `pairId` / `tf` (oldest first), or null when
 * none are cached yet. Starts a background fetch when the cache has fewer
 * than `bars` (and older ones may exist) or a newer bar has closed since;
 * `onLoad` runs once it lands. Returns the current (possibly short or stale)
 * candles meanwhile, so the line stays up while it refreshes.
 */
export function peekHtfCandles(
    pairId: string,
    tf: HtfTimeframe,
    bars: number,
    onLoad: () => void,
    nowMs = Date.now(),
): Candle[] | null {
    const want = Math.min(API_MAX_LIMIT - 1, Math.max(1, Math.ceil(bars)));
    const e = cache.get(key(pairId, tf));
    const needsFetch = !e || !enough(e, want) || stale(e, tf, nowMs);
    const busy = e?.inflight && e.inflightLimit >= want;
    const coolingDown = e && e.failedAt > 0 && nowMs - e.failedAt < RETRY_AFTER_MS;
    if (needsFetch && !busy && !coolingDown) load(pairId, tf, Math.max(want, e?.limit ?? 0), onLoad, nowMs);
    return e && e.candles.length > 0 ? e.candles : null;
}

/** TEST-ONLY. */
export function __resetHtfCache(): void {
    cache.clear();
}
