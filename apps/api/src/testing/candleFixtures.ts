import type { Pool } from "pg";

/** A throwaway inactive trading pair (outside MARKET_SYMBOLS) for candle tests. */
export async function createCandleFixturePair(pool: Pool, prefix: string) {
    const uid = Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows: a } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $1, 8), ($2, $2, 2) RETURNING id`,
        [`${prefix}${uid}`, `${prefix}Q${uid}`],
    );
    const assetIds = a.map((r) => r.id);
    const { rows: p } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
         VALUES ($1, $2, $3, false) RETURNING id`,
        [assetIds[0], assetIds[1], `${prefix}${uid}/USD`],
    );
    const pairId = p[0]!.id;
    return {
        pairId,
        async cleanup() {
            await pool.query(`DELETE FROM candles WHERE pair_id = $1`, [pairId]);
            await pool.query(`DELETE FROM trading_pairs WHERE id = $1`, [pairId]);
            await pool.query(`DELETE FROM assets WHERE id = ANY($1)`, [assetIds]);
        },
    };
}

export interface Row {
    tsMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

/** Bulk-insert candle rows for one (pair, timeframe). */
export async function insertCandles(pool: Pool, pairId: string, timeframe: string, rows: Row[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             SELECT $1, $2, to_timestamp(t / 1000.0), o, h, l, c, v
             FROM unnest($3::bigint[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[])
                  AS x(t, o, h, l, c, v)`,
            [
                pairId, timeframe,
                chunk.map((r) => r.tsMs), chunk.map((r) => r.open), chunk.map((r) => r.high),
                chunk.map((r) => r.low), chunk.map((r) => r.close), chunk.map((r) => r.volume),
            ],
        );
    }
}

/** Deterministic 1m rows for every minute in [fromMs, toMs). */
export function minuteRows(fromMs: number, toMs: number, priceAt: (k: number) => number = (k) => 100 + (k % 7)): Row[] {
    const rows: Row[] = [];
    for (let t = fromMs, k = 0; t < toMs; t += 60_000, k++) {
        const o = priceAt(k);
        rows.push({ tsMs: t, open: o, high: o + 3, low: o - 2, close: o + 1, volume: 2 });
    }
    return rows;
}

/** OHLCV aggregate of time-ordered rows, as numbers. */
export function aggregate(rows: Row[]) {
    return {
        open: rows[0]!.open,
        high: Math.max(...rows.map((r) => r.high)),
        low: Math.min(...rows.map((r) => r.low)),
        close: rows[rows.length - 1]!.close,
        volume: rows.reduce((s, r) => s + r.volume, 0),
    };
}
