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
// The most recent finished minute per pair — the previous close for a
// forming candle until that minute's row is readable from the DB.
const lastClosed = new Map<string, { minuteKey: number; close: string }>();

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
        // The previous minute is over the moment a newer one opens: store it
        // NOW. (Waiting for the 5s flush lost it — the new candle replaced it
        // in memory first, so most live minutes were never stored.)
        if (existing) {
            openCandles.delete(pairId);
            void flushCandle(existing);
        }
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
 * Store one finished 1m candle (MARKET_SYMBOLS pairs only) and publish
 * candle.closed. The write REPLACES the row — every candle writer does
 * (live, Kraken REST, Coinbase backfill, rollups), so a minute written twice
 * holds the last writer's values instead of summed volume.
 */
async function flushCandle(candle: OpenCandle, storable?: Set<string>): Promise<void> {
    const { pairId } = candle;
    const ts = new Date(candle.minuteKey).toISOString();
    const prev = lastClosed.get(pairId);
    if (!prev || prev.minuteKey < candle.minuteKey) {
        lastClosed.set(pairId, { minuteKey: candle.minuteKey, close: candle.close });
    }

    try {
        // MARKET_SYMBOLS allowlist: only these pairs are persisted. Others still
        // publish candle.closed below so their live charts keep updating.
        const ids = storable ?? await getMarketDataPairIds();
        if (ids.has(pairId)) {
            await pool.query(
                `INSERT INTO candles (pair_id, timeframe, ts, open, high, low, close, volume, buy_volume, sell_volume)
                 VALUES ($1, '1m', $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (pair_id, timeframe, ts) DO UPDATE SET
                     open = EXCLUDED.open,
                     high = EXCLUDED.high,
                     low = EXCLUDED.low,
                     close = EXCLUDED.close,
                     volume = EXCLUDED.volume,
                     buy_volume = EXCLUDED.buy_volume,
                     sell_volume = EXCLUDED.sell_volume`,
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
}

/**
 * Flush 1m candles whose minute ended without a newer tick to roll them
 * (quiet markets). Called periodically by the Kraken feed interval.
 */
export async function flushDueCandles(): Promise<void> {
    const currentMinute = minuteFloor(Date.now());

    let storable: Set<string>;
    try {
        storable = await getMarketDataPairIds();
    } catch (err) {
        logger.error({ err }, "candle_flush_allowlist_lookup_failed");
        return; // keep open candles in memory; retry on the next flush
    }

    for (const [pairId, candle] of openCandles) {
        if (candle.minuteKey >= currentMinute) continue; // Still open
        openCandles.delete(pairId);
        await flushCandle(candle, storable);
    }
}

/**
 * Seed the pair's in-progress minute from an exchange snapshot (Kraken
 * REST's in-progress OHLC entry at boot), so the minute the server came up
 * in keeps its real open/high/low instead of starting at the first tick.
 * Marks the minute as the pair's newest, so replayed trades for older
 * minutes are dropped. A snapshot for a minute older than the newest one is
 * ignored; for the open minute it merges (snapshot open, combined range,
 * live close, larger volume).
 */
export function seedOpenCandle(
    pairId: string,
    snap: { minuteKey: number; open: string; high: string; low: string; close: string; volume: string },
): void {
    const newest = latestMinute.get(pairId);
    if (newest !== undefined && snap.minuteKey < newest) return;
    const existing = openCandles.get(pairId);
    if (existing && existing.minuteKey === snap.minuteKey) {
        existing.open = snap.open;
        if (parseFloat(snap.high) > parseFloat(existing.high)) existing.high = snap.high;
        if (parseFloat(snap.low) < parseFloat(existing.low)) existing.low = snap.low;
        if (parseFloat(snap.volume) > parseFloat(existing.volume)) existing.volume = snap.volume;
        return;
    }
    if (newest !== undefined && snap.minuteKey === newest) return; // already flushed
    latestMinute.set(pairId, snap.minuteKey);
    openCandles.set(pairId, {
        pairId,
        minuteKey: snap.minuteKey,
        open: snap.open,
        high: snap.high,
        low: snap.low,
        close: snap.close,
        volume: snap.volume,
        buyVolume: "0",
        sellVolume: "0",
        tickCount: 0,
    });
}

/** The most recent finished minute's close for a pair, if one closed since boot. */
export function getLastClosed(pairId: string): { minuteKey: number; close: string } | undefined {
    return lastClosed.get(pairId);
}

/** For testing: get current open candle state */
export function getOpenCandle(pairId: string): OpenCandle | undefined {
    return openCandles.get(pairId);
}

/** TEST-ONLY — forget all open candles and minute history. */
export function __resetCandleAggregatorForTest(): void {
    openCandles.clear();
    latestMinute.clear();
    lastClosed.clear();
    lateTicksDropped.reset();
}
