/**
 * publicTickers.ts — real prices for the pre-login ticker strip (login /
 * register / landing). Unauthenticated, so it exposes only what the trade
 * page already shows anyone: last price and 24h change for the MARKET_SYMBOLS
 * pairs. Cached briefly so anonymous traffic can't turn into DB load.
 *
 *   price         trading_pairs.last_price (kept fresh by the Kraken feed)
 *   change24hPct  vs. the last 1h candle close at or before now - 24h;
 *                 null when there's no reference candle yet (fresh DB)
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { tradableSymbols } from "./marketSymbols.js";

export interface PublicTicker {
    symbol: string;              // "BTC/USD"
    price: string | null;        // decimal string, null until the first tick
    change24hPct: number | null; // e.g. 2.31 for +2.31%
}

const CACHE_TTL_MS = 10_000;
let cache: { at: number; data: PublicTicker[] } | null = null;

export function computeChangePct(price: string | null, refClose: string | null): number | null {
    if (price == null || refClose == null) return null;
    const p = Number(price);
    const r = Number(refClose);
    if (!Number.isFinite(p) || !Number.isFinite(r) || r <= 0) return null;
    return Math.round(((p / r) - 1) * 10_000) / 100;
}

export async function getPublicTickers(
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<PublicTicker[]> {
    const now = Date.now();
    if (cache && allow === config.marketSymbols && now - cache.at < CACHE_TTL_MS) return cache.data;

    const { rows } = await pool.query<{ symbol: string; price: string | null; ref_close: string | null }>(
        `SELECT tp.symbol,
                tp.last_price::text AS price,
                (SELECT c.close::text
                   FROM candles c
                  WHERE c.pair_id = tp.id
                    AND c.timeframe = '1h'
                    AND c.ts <= now() - interval '24 hours'
                  ORDER BY c.ts DESC
                  LIMIT 1) AS ref_close
           FROM trading_pairs tp
          WHERE tp.is_active = true AND tp.symbol = ANY($1)
          ORDER BY tp.symbol`,
        [tradableSymbols(allow)],
    );

    const data = rows.map((r) => ({
        symbol: r.symbol,
        price: r.price,
        change24hPct: computeChangePct(r.price, r.ref_close),
    }));
    if (allow === config.marketSymbols) cache = { at: now, data };
    return data;
}

/** Test hook: drop the cache. */
export function resetPublicTickerCache(): void {
    cache = null;
}
