/**
 * marketSymbols.ts — the MARKET_SYMBOLS allowlist: the single source of
 * truth for which pairs exist in the product. It gates BOTH stored market
 * data (below) AND tradability — pair listings, order/trigger/alert
 * placement, the exchange feeds' subscriptions and the symbol-sync job all
 * filter through isTradableSymbol()/tradableSymbols(). A pair outside the
 * allowlist is not listed, not tradable and not streamed, whatever its
 * trading_pairs.is_active says.
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
import { AppError } from "../errors/AppError.js";

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

/** Tradability uses the same allowlist as stored market data. */
export const isTradableSymbol = isMarketDataSymbol;

/** The allowlist as a sorted array — for `symbol = ANY($n)` SQL params and
 *  the `allowedSymbols` detail on pair_not_tradable errors. */
export function tradableSymbols(
    allow: ReadonlySet<string> = config.marketSymbols,
): string[] {
    return [...allow].sort();
}

/** Throws pair_not_tradable (400) for a pair outside the allowlist. */
export function assertTradableSymbol(
    symbol: string,
    allow: ReadonlySet<string> = config.marketSymbols,
): void {
    if (!isTradableSymbol(symbol, allow)) {
        throw new AppError("pair_not_tradable", { allowedSymbols: tradableSymbols(allow) });
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

/**
 * HTTP-edge tradability check for routes that only carry a pair id (order,
 * trigger/OCO, alert, replay creation). Uses the cached id set above, so it
 * adds no query to the order hot path. Rejects with pair_not_tradable (400)
 * before anything is enqueued or persisted; the matching engine re-checks
 * the symbol as a backstop for non-HTTP callers (agents, trigger engine).
 */
export async function assertTradablePairId(
    pairId: string,
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<void> {
    const ids = await getMarketDataPairIds(allow);
    if (!ids.has(pairId)) {
        throw new AppError("pair_not_tradable", { allowedSymbols: tradableSymbols(allow) });
    }
}

/** Test hook: drop the pair-id cache. */
export function resetMarketDataPairIdCache(): void {
    cachedIds = null;
    cachedAt = 0;
    cachedFor = null;
}

/**
 * Test hook: admit a fixture pair symbol (BASE/QUOTE form) to the live
 * allowlist, so suites that need an isolated order book can still trade on
 * their own pair. Returns the normalized (uppercase) symbol for inline use
 * in fixture payloads, so the stored trading_pairs.symbol matches exactly.
 * Vitest isolates modules per test file, so the addition never leaks into
 * another suite. Refuses to run in production.
 */
export function allowSymbolForTest(symbol: string): string {
    if (config.isProd) throw new Error("allowSymbolForTest is test-only");
    const normalized = normalizeMarketSymbol(symbol);
    (config.marketSymbols as Set<string>).add(normalized);
    resetMarketDataPairIdCache();
    return normalized;
}
