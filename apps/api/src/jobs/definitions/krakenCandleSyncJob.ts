import type { JobDefinition } from "../jobTypes.js";
import { pool } from "../../db/pool.js";
import { fetchOHLC, REST_PAIR_MAP, sleep } from "../../market/krakenRest.js";
import { listActivePairs } from "../../trading/pairRepo.js";
import { publish } from "../../events/eventBus.js";
import { createEvent } from "../../events/eventTypes.js";
import { logger as rootLogger } from "../../observability/logContext.js";

const logger = rootLogger.child({ module: "krakenCandleSync" });

/**
 * Periodically fetch completed 1m candles from Kraken REST API and upsert
 * into the candles table. This ensures our candle data mirrors Kraken exactly,
 * regardless of whether our server was running or had WS connectivity.
 *
 * Runs every 60s. Fetches the last ~15 minutes of 1m data per pair to catch
 * any recently completed candles. ON CONFLICT DO UPDATE overwrites any
 * tick-aggregated candle with Kraken's authoritative OHLC values.
 */

const LOOKBACK_SECONDS = 900; // 15 minutes — enough to catch recently closed candles

async function syncPair(pairId: string, pairSymbol: string, krakenPair: string): Promise<number> {
    const since = Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;

    const result = await fetchOHLC(krakenPair, 1, since);

    // Drop the last entry (current in-progress candle)
    const completed = result.candles.slice(0, -1);
    if (completed.length === 0) return 0;

    let inserted = 0;
    for (const c of completed) {
        const ts = new Date(c.time * 1000).toISOString();

        const res = await pool.query(
            `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume)
             VALUES ($1, '1m', $2, $3, $4, $5, $6, $7)
             ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
                 open = EXCLUDED.open,
                 high = EXCLUDED.high,
                 low = EXCLUDED.low,
                 close = EXCLUDED.close,
                 volume = EXCLUDED.volume`,
            [pairId, ts, c.open, c.high, c.low, c.close, c.volume],
        );
        if (res.rowCount && res.rowCount > 0) inserted++;

        // Publish candle.closed event so live charts update
        publish(createEvent("candle.closed", {
            pairId,
            timeframe: "1m",
            ts: c.time * 1000,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            buyVolume: "0",
            sellVolume: "0",
        }));
    }

    return inserted;
}

export const krakenCandleSyncJob: JobDefinition = {
    name: "kraken-candle-sync",
    intervalSeconds: 60,
    async run(_ctx) {
        const pairs = await listActivePairs();
        const mapped = pairs.filter((p) => REST_PAIR_MAP[p.symbol]);

        for (const pair of mapped) {
            try {
                const krakenPair = REST_PAIR_MAP[pair.symbol]!;
                const count = await syncPair(pair.id, pair.symbol, krakenPair);
                if (count > 0) {
                    logger.debug({ pair: pair.symbol, synced: count }, "kraken_candle_sync_done");
                }
            } catch (err) {
                logger.warn({ pair: pair.symbol, err: (err as Error).message }, "kraken_candle_sync_error");
            }

            // Rate limit between pairs
            if (mapped.length > 1) await sleep(500);
        }
    },
};
