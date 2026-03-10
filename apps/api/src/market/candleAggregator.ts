import { pool } from "../db/pool.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { logger } from "../observability/logContext.js";

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

function minuteFloor(tsMs: number): number {
    return Math.floor(tsMs / 60_000) * 60_000;
}

/**
 * Ingest a single price tick. Updates the open 1m candle in memory.
 * If the tick belongs to a new minute, the previous candle is marked for flushing.
 */
export function aggregateTick(pairId: string, tick: Tick): void {
    const minuteKey = minuteFloor(tick.ts);
    const existing = openCandles.get(pairId);
    const vol = parseFloat(tick.volume);
    const buyVol = tick.side === "buy" ? vol : 0;
    const sellVol = tick.side === "sell" ? vol : 0;

    if (!existing || existing.minuteKey !== minuteKey) {
        // New candle for this minute
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

    for (const [pairId, candle] of openCandles) {
        if (candle.minuteKey >= currentMinute) continue; // Still open

        // This candle's minute is complete — flush to DB
        const ts = new Date(candle.minuteKey).toISOString();

        try {
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
