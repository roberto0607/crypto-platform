import client from "prom-client";
import { pool } from "../db/pool.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { logger } from "../observability/logContext.js";
import { getMarketDataPairIds } from "./marketSymbols.js";

interface Tick {
    price: string;
    volume: string;
    ts: number; // epoch ms
    side?: "buy" | "sell";
}

interface OpenCandle {
    pairId: string;
    minuteKey: number; // epoch ms of the minute start (floored to 60s)
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    buyVolume: string;
    sellVolume: string;
    tickCount: number;
}

// Map<pairId, OpenCandle>
const openCandles = new Map<string, OpenCandle>();
// Newest minute a candle has been opened for, per pair. Never moves back.
const latestMinute = new Map<string, number>();

const lateTicksDropped = new client.Counter({
    name: "tradr_candle_late_ticks_dropped_total",
    help: "Ticks for a minute older than the pair's current 1m candle, dropped instead of reopening (and later re-flushing over) that minute",
});

function minuteFloor(tsMs: number): number {
    return Math.floor(tsMs / 60_000) * 60_000;
}

/**
 * Ingest a single price tick. Updates the open 1m candle in memory.
 * If the tick belongs to a new minute, the previous candle is marked for flushing.
 *
 * A tick for a minute OLDER than the pair's newest candle is dropped. It
 * used to replace the open candle with a fresh one for that past minute,
 * which threw away the current minute's data and, at the next flush,
 * re-wrote the stored past candle via ON CONFLICT DO UPDATE (open/close
 * replaced by the late tick's price, its volume added on top). The same
 * goes for a tick for the newest minute after that minute was flushed.
 * Sources:
 * trades replayed after a Coinbase reconnect, and exchange-timestamped
 * trades that land just after Kraken's ticker (stamped with receive time)
 * has already rolled the minute.
 */
export function aggregateTick(pairId: string, tick: Tick): void {
    const minuteKey = minuteFloor(tick.ts);
    const newest = latestMinute.get(pairId);
    const existing = openCandles.get(pairId);
    // Older than the newest minute, or the newest minute itself once its
    // candle has been flushed (flush only removes minutes that are over).
    if (newest !== undefined && (minuteKey < newest || (minuteKey === newest && !existing))) {
        lateTicksDropped.inc();
        return;
    }
    const vol = parseFloat(tick.volume);
    const buyVol = tick.side === "buy" ? vol : 0;
    const sellVol = tick.side === "sell" ? vol : 0;

    if (!existing || existing.minuteKey !== minuteKey) {
        // New candle for this minute
        latestMinute.set(pairId, minuteKey);
        openCandles.set(pairId, {
            pairId,
            minuteKey,
            open: tick.price,
            high: tick.price,
            low: tick.price,
            close: tick.price,
            volume: tick.volume,
            buyVolume: String(buyVol),
            sellVolume: String(sellVol),
            tickCount: 1,
        });
        return;
    }

    // Update existing candle
    const p = parseFloat(tick.price);
    if (p > parseFloat(existing.high)) existing.high = tick.price;
    if (p < parseFloat(existing.low)) existing.low = tick.price;
    existing.close = tick.price;
    existing.volume = String(parseFloat(existing.volume) + vol);
    existing.buyVolume = String(parseFloat(existing.buyVolume) + buyVol);
    existing.sellVolume = String(parseFloat(existing.sellVolume) + sellVol);
    existing.tickCount++;
}

/**
 * Flush all completed 1m candles (where the current minute has moved past them).
 * Called periodically by the Kraken feed interval.
 */
export async function flushDueCandles(): Promise<void> {
    const now = Date.now();
    const currentMinute = minuteFloor(now);

    // MARKET_SYMBOLS allowlist: only these pairs are persisted. Others still
    // publish candle.closed below so their live charts keep updating.
    let storable: Set<string>;
    try {
        storable = await getMarketDataPairIds();
    } catch (err) {
        logger.error({ err }, "candle_flush_allowlist_lookup_failed");
        return; // keep open candles in memory; retry on the next flush
    }

    for (const [pairId, candle] of openCandles) {
        if (candle.minuteKey >= currentMinute) continue; // Still open

        // This candle's minute is complete — flush to DB
        const ts = new Date(candle.minuteKey).toISOString();

        try {
            if (storable.has(pairId)) {
                await pool.query(
                    `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume, buy_volume, sell_volume)
                     VALUES ($1, '1m', $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
                         open = EXCLUDED.open,
                         high = GREATEST(candles.high, EXCLUDED.high),
                         low = LEAST(candles.low, EXCLUDED.low),
                         close = EXCLUDED.close,
                         volume = candles.volume + EXCLUDED.volume,
                         buy_volume = candles.buy_volume + EXCLUDED.buy_volume,
                         sell_volume = candles.sell_volume + EXCLUDED.sell_volume`,
                    [pairId, ts, candle.open, candle.high, candle.low, candle.close, candle.volume, candle.buyVolume, candle.sellVolume],
                );
            }

            // Publish candle.closed event for live chart updates
            publish(createEvent("candle.closed", {
                pairId,
                timeframe: "1m",
                ts: candle.minuteKey,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                buyVolume: candle.buyVolume,
                sellVolume: candle.sellVolume,
            }));

            logger.debug(
                { pairId, ts, close: candle.close, ticks: candle.tickCount },
                "1m_candle_flushed",
            );
        } catch (err) {
            logger.error({ err, pairId, ts }, "candle_flush_db_error");
        }

        // Remove flushed candle (current minute's candle, if any, stays)
        if (candle.minuteKey < currentMinute) {
            openCandles.delete(pairId);
        }
    }
}

/** For testing: get current open candle state */
export function getOpenCandle(pairId: string): OpenCandle | undefined {
    return openCandles.get(pairId);
}

/** TEST-ONLY — forget all open candles and minute history. */
export function __resetCandleAggregatorForTest(): void {
    openCandles.clear();
    latestMinute.clear();
    lateTicksDropped.reset();
}
