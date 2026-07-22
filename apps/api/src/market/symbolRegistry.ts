/**
 * symbolRegistry.ts — reads the live, DB-driven active symbol set for a
 * given exchange (trading_pairs × exchange_symbol_map, both is_active =
 * true), replacing the hardcoded SYMBOL_MAP/PRODUCT_MAP/CB_PAIR_MAP literals
 * previously in krakenWs.ts/coinbaseWs.ts/candleBackfill.ts. See
 * docs/designs/2026-07-22-multi-asset-datafeed-gate1.md section 2.3.
 */
import { pool } from "../db/pool.js";

export interface ActiveSymbol {
    ourSymbol: string;   // e.g. "BTC/USD" — matches trading_pairs.symbol
    wsSymbol: string;    // exchange WS subscribe symbol
    restSymbol: string;  // exchange REST symbol
    pairId: string;
}

export async function loadActiveSymbols(exchange: "kraken" | "coinbase"): Promise<ActiveSymbol[]> {
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
         ORDER BY tp.symbol`,
        [exchange],
    );

    return rows.map((r) => ({
        ourSymbol: r.symbol,
        wsSymbol: r.ws_symbol,
        restSymbol: r.rest_symbol,
        pairId: r.pair_id,
    }));
}
