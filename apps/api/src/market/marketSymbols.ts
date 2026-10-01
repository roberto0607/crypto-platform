/**
 * marketSymbols.ts — the market-data storage allowlist (MARKET_SYMBOLS).
 *
 * Every code path that persists market-data history (1m candle flush,
 * Kraken REST candle sync, candle rollups, boot backfill, footprint
 * candles, the history backfill script) filters through here, so a pair
 * outside the allowlist can never grow the candles table. The prod DB
 * filled its volume when ~137 auto-synced pairs × 7 timeframes were all
 * being written; with three pairs the steady state is a few hundred MB.
 *
 * Symbols are compared in trading_pairs.symbol form ("BTC/USD").
 */
import { pool } from "../db/pool.js";
import { config, normalizeMarketSymbol } from "../config.js";

export function isMarketDataSymbol(
    symbol: string,
    allow: ReadonlySet<string> = config.marketSymbols,
): boolean {
    try {
        return allow.has(normalizeMarketSymbol(symbol));
    } catch {
        return false;
    }
}

export function filterMarketDataPairs<T>(
    pairs: readonly T[],
    getSymbol: (p: T) => string,
    allow: ReadonlySet<string> = config.marketSymbols,
): T[] {
    return pairs.filter((p) => isMarketDataSymbol(getSymbol(p), allow));
}

// ── pair_id lookup (for write paths that only carry a pair id) ──

const PAIR_ID_CACHE_TTL_MS = 60_000;
let cachedIds: Set<string> | null = null;
let cachedAt = 0;
let cachedFor: ReadonlySet<string> | null = null;

/** pair ids whose symbol is in the allowlist. Cached for 60s. */
export async function getMarketDataPairIds(
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<Set<string>> {
    const now = Date.now();
    if (cachedIds && cachedFor === allow && now - cachedAt < PAIR_ID_CACHE_TTL_MS) {
        return cachedIds;
    }
    const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM trading_pairs WHERE symbol = ANY($1)`,
        [[...allow]],
    );
    cachedIds = new Set(rows.map((r) => r.id));
    cachedAt = now;
    cachedFor = allow;
    return cachedIds;
}

/** Test hook: drop the pair-id cache. */
export function resetMarketDataPairIdCache(): void {
    cachedIds = null;
    cachedAt = 0;
    cachedFor = null;
}
