import type { Pool, PoolClient } from "pg";
import { pool } from "../db/pool";

export interface SimCandle {
    volume: string;
    high: string;
    low: string;
}

/**
 * Latest 1m candle at/before `ts` for the slippage/liquidity simulation
 * (`computeMarketExecution` / `computeAvailableLiquidity`).
 *
 * Pinned to the **1m** timeframe on purpose:
 *  - Performance: `WHERE pair_id = $1 AND timeframe = '1m' AND ts <= $2 ORDER BY
 *    ts DESC LIMIT 1` is an index seek on the `(pair_id, timeframe, ts)` index.
 *    The previous timeframe-less query could not seek and degraded to a
 *    full-table Parallel Seq Scan that grew with the candles table (~19ms on the
 *    211k-row prod table, the bulk of per-order exec).
 *  - Correctness: 1m is the finest/freshest bar = current liquidity (volume) and
 *    volatility (high-low). The old "latest of ANY timeframe" was nondeterministic
 *    (a coarser, much-larger-volume candle could win if the 1m feed lagged). In
 *    practice the old query already resolved to the 1m bar (1m has the freshest ts).
 *
 * Returns `null` when no 1m candle exists for the pair; callers fall back to
 * default sim params (the sim handles null volume/high/low). See
 * docs/designs/2026-05-27-candles-query-index.md.
 */
export async function getLatestSimCandle(
    pairId: string,
    ts: string,
    q: Pool | PoolClient = pool,
): Promise<SimCandle | null> {
    const { rows } = await q.query<SimCandle>(
        `SELECT volume, high, low FROM candles
         WHERE pair_id = $1 AND timeframe = '1m' AND ts <= $2
         ORDER BY ts DESC LIMIT 1`,
        [pairId, ts],
    );
    return rows[0] ?? null;
}
