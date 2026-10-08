/**
 * rerollCandles.ts — one-time repair of frozen higher-timeframe buckets.
 *
 * Before the rollup lookback fix, candleRollupJob only ever re-aggregated a
 * timeframe's LATEST stored bucket. A bucket that stopped being the latest
 * before its 1m rows settled (live write at minute close, then Kraken REST
 * replacing the last 15 minutes) kept whatever its 1m rows held at that
 * moment — most often 5m, and 4h/1w whenever the boot rollup had stored the
 * in-progress bucket. Those rows are "frozen": they disagree with the 1m
 * rows they were rolled from.
 *
 * This re-derives every 5m/15m/1h/4h/1d/1w bucket from the stored 1m rows,
 * with exactly candleRollupJob's bucketing and aggregation, and replaces the
 * stored row where it differs (or inserts one that's missing). Only buckets
 * that are safe to judge are touched:
 *   - finished, and ended at least ROLLUP_LOOKBACK_MS ago (younger buckets
 *     are still being re-rolled by the job itself);
 *   - FULLY covered by 1m rows (one per minute) — a bucket whose 1m history
 *     is incomplete (e.g. older than 1m retention) is reported and left alone.
 * Driven by src/scripts/rerollCandles.ts (dry run by default).
 */
import type { Pool, PoolClient } from "pg";
import { ROLLUPS, ROLLUP_LOOKBACK_MS } from "../jobs/definitions/candleRollupJob.js";

const WEEK_MINUTES = 10080;
const MONDAY_EPOCH_OFFSET_SEC = 3 * 86_400;

export interface CandleValues {
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    buy_volume: string | null;
    sell_volume: string | null;
}

export interface RerollChange {
    pairId: string;
    symbol: string;
    timeframe: string;
    ts: string; // ISO bucket start
    kind: "ohlc" | "volume" | "insert";
    old: CandleValues | null; // null → row was missing, will be inserted
    new: CandleValues;
}

export interface RerollSeriesSummary {
    symbol: string;
    timeframe: string;
    bucketsChecked: number;   // finished, settled buckets with any 1m data
    incomplete: number;       // skipped: 1m doesn't cover every minute
    unchanged: number;
    changed: number;          // stored OHLC differs → replace
    volumeOnly: number;       // only volume differs → replace (skipped with ohlcOnly)
    missing: number;          // no stored row → insert
}

export interface RerollPlan {
    nowIso: string;
    series: RerollSeriesSummary[];
    changes: RerollChange[];
}

export interface RerollOptions {
    pool: Pick<Pool, "query">;
    symbols: string[];            // trading_pairs.symbol form, e.g. "BTC/USD"
    timeframes?: string[];        // default: every rollup timeframe
    nowMs?: number;
    /**
     * Leave volume-only differences alone. Exchange-native rows (Coinbase
     * backfill) often differ from the sum of their 1m rows in volume only;
     * frozen buckets usually differ in OHLC too.
     */
    ohlcOnly?: boolean;
}

export async function planReroll(opts: RerollOptions): Promise<RerollPlan> {
    const nowMs = opts.nowMs ?? Date.now();
    const tfs = opts.timeframes ?? ROLLUPS.map((r) => r.timeframe);
    const rollups = ROLLUPS.filter((r) => tfs.includes(r.timeframe));
    const unknown = tfs.filter((t) => !ROLLUPS.some((r) => r.timeframe === t));
    if (unknown.length > 0) throw new Error(`Unknown timeframe(s): ${unknown.join(", ")}`);

    const { rows: pairs } = await opts.pool.query<{ id: string; symbol: string }>(
        `SELECT id, symbol FROM trading_pairs WHERE symbol = ANY($1) ORDER BY symbol`,
        [opts.symbols],
    );
    const missingPairs = opts.symbols.filter((s) => !pairs.some((p) => p.symbol === s));
    if (missingPairs.length > 0) throw new Error(`No trading_pairs row for ${missingPairs.join(", ")}`);

    const plan: RerollPlan = { nowIso: new Date(nowMs).toISOString(), series: [], changes: [] };
    const settledBefore = (nowMs - ROLLUP_LOOKBACK_MS) / 1000; // bucket END must be <= this

    for (const pair of pairs) {
        for (const r of rollups) {
            const interval = r.minutes * 60;
            const offset = r.minutes === WEEK_MINUTES ? MONDAY_EPOCH_OFFSET_SEC : 0;
            // Same bucketing + aggregation as candleRollupJob.rollupForPair.
            const { rows } = await opts.pool.query<{
                bucket: Date; n: string;
                open: string; high: string; low: string; close: string; volume: string;
                buy_volume: string | null; sell_volume: string | null;
                s_open: string | null; s_high: string | null; s_low: string | null; s_close: string | null;
                s_volume: string | null; s_buy: string | null; s_sell: string | null; s_exists: boolean;
            }>(
                `WITH bucketed AS (
                     SELECT to_timestamp(floor((extract(epoch FROM ts) + $4) / $3) * $3 - $4) AS bucket,
                            ts, open, high, low, close, volume, buy_volume, sell_volume
                     FROM candles
                     WHERE pair_id = $1 AND timeframe = '1m'
                 ),
                 agg AS (
                     SELECT bucket, count(*) AS n,
                            (array_agg(open ORDER BY ts ASC))[1]   AS open,
                            MAX(high)                              AS high,
                            MIN(low)                               AS low,
                            (array_agg(close ORDER BY ts DESC))[1] AS close,
                            SUM(volume)                            AS volume,
                            SUM(buy_volume)                        AS buy_volume,
                            SUM(sell_volume)                       AS sell_volume
                     FROM bucketed
                     GROUP BY bucket
                     HAVING extract(epoch FROM bucket) + $3 <= $5
                 )
                 SELECT a.bucket, a.n::text,
                        a.open::text, a.high::text, a.low::text, a.close::text, a.volume::text,
                        a.buy_volume::text, a.sell_volume::text,
                        c.open::text AS s_open, c.high::text AS s_high, c.low::text AS s_low, c.close::text AS s_close,
                        c.volume::text AS s_volume, c.buy_volume::text AS s_buy, c.sell_volume::text AS s_sell,
                        (c.ts IS NOT NULL) AS s_exists,
                        (c.ts IS NOT NULL AND c.open = a.open AND c.high = a.high AND c.low = a.low
                                          AND c.close = a.close) AS ohlc_same,
                        (c.volume = a.volume) AS volume_same
                 FROM agg a
                 LEFT JOIN candles c ON c.pair_id = $1 AND c.timeframe = $2 AND c.ts = a.bucket
                 ORDER BY a.bucket`,
                [pair.id, r.timeframe, interval, offset, settledBefore],
            );

            const summary: RerollSeriesSummary = {
                symbol: pair.symbol, timeframe: r.timeframe,
                bucketsChecked: rows.length, incomplete: 0, unchanged: 0, changed: 0, volumeOnly: 0, missing: 0,
            };
            for (const row of rows as Array<typeof rows[number] & { ohlc_same: boolean; volume_same: boolean | null }>) {
                if (Number(row.n) !== r.minutes) { summary.incomplete++; continue; }
                if (row.ohlc_same && row.volume_same) { summary.unchanged++; continue; }
                const next: CandleValues = {
                    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume,
                    buy_volume: row.buy_volume, sell_volume: row.sell_volume,
                };
                const old: CandleValues | null = row.s_exists
                    ? { open: row.s_open!, high: row.s_high!, low: row.s_low!, close: row.s_close!, volume: row.s_volume!, buy_volume: row.s_buy, sell_volume: row.s_sell }
                    : null;
                const kind = !old ? "insert" : row.ohlc_same ? "volume" : "ohlc";
                if (kind === "insert") summary.missing++;
                else if (kind === "ohlc") summary.changed++;
                else {
                    summary.volumeOnly++;
                    if (opts.ohlcOnly) continue;
                }
                plan.changes.push({ pairId: pair.id, symbol: pair.symbol, timeframe: r.timeframe, ts: new Date(row.bucket).toISOString(), kind, old, new: next });
            }
            plan.series.push(summary);
        }
    }
    return plan;
}

async function writeRow(client: PoolClient, pairId: string, timeframe: string, ts: string, v: CandleValues): Promise<void> {
    await client.query(
        `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume, buy_volume, sell_volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
             open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
             volume = EXCLUDED.volume, buy_volume = EXCLUDED.buy_volume, sell_volume = EXCLUDED.sell_volume`,
        [pairId, timeframe, ts, v.open, v.high, v.low, v.close, v.volume, v.buy_volume, v.sell_volume],
    );
}

/** Apply every change in one transaction (all or nothing). */
export async function applyReroll(pool: Pool, changes: RerollChange[]): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        for (const c of changes) await writeRow(client, c.pairId, c.timeframe, c.ts, c.new);
        await client.query("COMMIT");
        return changes.length;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Undo an applied re-roll from its snapshot: restore each replaced row's old
 * values and delete each inserted row — but only where the row still holds
 * exactly what the re-roll wrote, so anything written since (the live
 * rollup job) is never clobbered. Returns what was restored/deleted/skipped.
 */
export async function revertReroll(pool: Pool, changes: RerollChange[]): Promise<{ restored: number; deleted: number; skipped: number }> {
    const client = await pool.connect();
    const out = { restored: 0, deleted: 0, skipped: 0 };
    try {
        await client.query("BEGIN");
        for (const c of changes) {
            const match = `pair_id = $1 AND timeframe = $2 AND ts = $3
                           AND open = $4 AND high = $5 AND low = $6 AND close = $7 AND volume = $8`;
            const key = [c.pairId, c.timeframe, c.ts, c.new.open, c.new.high, c.new.low, c.new.close, c.new.volume];
            if (c.old) {
                const r = await client.query(
                    `UPDATE candles SET open = $9, high = $10, low = $11, close = $12, volume = $13,
                                        buy_volume = $14, sell_volume = $15
                     WHERE ${match}`,
                    [...key, c.old.open, c.old.high, c.old.low, c.old.close, c.old.volume, c.old.buy_volume, c.old.sell_volume],
                );
                if (r.rowCount) out.restored++; else out.skipped++;
            } else {
                const r = await client.query(`DELETE FROM candles WHERE ${match}`, key);
                if (r.rowCount) out.deleted++; else out.skipped++;
            }
        }
        await client.query("COMMIT");
        return out;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}
