/**
 * symbolRegistry.ts — reads the live, DB-driven active symbol set for a
 * given exchange (trading_pairs × exchange_symbol_map, both is_active =
 * true), replacing the hardcoded SYMBOL_MAP/PRODUCT_MAP/CB_PAIR_MAP literals
 * previously in krakenWs.ts/coinbaseWs.ts/candleBackfill.ts. See
 * docs/designs/2026-07-22-multi-asset-datafeed-gate1.md section 2.3.
 *
 * Restricted to the MARKET_SYMBOLS allowlist (market/marketSymbols.ts), so
 * the Kraken/Coinbase WS feeds subscribe only to tradable pairs — a stray
 * active row for any other pair is never streamed.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { tradableSymbols } from "./marketSymbols.js";

export interface ActiveSymbol {
    ourSymbol: string;   // e.g. "BTC/USD" — matches trading_pairs.symbol
    wsSymbol: string;    // exchange WS subscribe symbol
    restSymbol: string;  // exchange REST symbol
    pairId: string;
}

export async function loadActiveSymbols(
    exchange: "kraken" | "coinbase",
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<ActiveSymbol[]> {
    const { rows } = await pool.query<{
        symbol: string;
        ws_symbol: string;
        rest_symbol: string;
        pair_id: string;
    }>(
        `SELECT tp.symbol, esm.ws_symbol, esm.rest_symbol, esm.pair_id
         FROM trading_pairs tp
         JOIN exchange_symbol_map esm ON esm.pair_id = tp.id
         WHERE tp.is_active = true AND esm.exchange = $1 AND esm.is_active = true
           AND tp.symbol = ANY($2)
         ORDER BY tp.symbol`,
        [exchange, tradableSymbols(allow)],
    );

    return rows.map((r) => ({
        ourSymbol: r.symbol,
        wsSymbol: r.ws_symbol,
        restSymbol: r.rest_symbol,
        pairId: r.pair_id,
    }));
}
