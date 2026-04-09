/**
 * footprintAggregator.ts — Aggregates Kraken trades into footprint candle buckets.
 *
 * Subscribes to Kraken WS v2 trade channel for BTC/USD.
 * Maintains 3 active candle aggregators (1m, 5m, 15m).
 * Persists completed candles to footprint_candles table.
 * $10 price buckets with buy/sell quantity tracking.
 */

import WebSocket from "ws";
import { pool } from "../db/pool.js";
import { logger } from "../observability/logContext.js";

const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";
const RECONNECT_DELAYS = [2000, 5000, 10000, 30000];

const TF_MS: Record<string, number> = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
};

const TIMEFRAMES = Object.keys(TF_MS);

type BucketMap = Map<number, { buy: number; sell: number }>;

interface CandleAgg {
    openTime: number;
    closeTime: number;
    buckets: BucketMap;
    totalBuy: number;
    totalSell: number;
}

const active: Record<string, CandleAgg | null> = {
    "1m": null,
    "5m": null,
    "15m": null,
};

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getOpenTime(ts: number, tfMs: number): number {
    return Math.floor(ts / tfMs) * tfMs;
}

function newCandleAgg(openTime: number, tfMs: number): CandleAgg {
    return {
        openTime,
        closeTime: openTime + tfMs - 1,
        buckets: new Map(),
        totalBuy: 0,
        totalSell: 0,
    };
}

function bucketsToJson(buckets: BucketMap): Record<string, { b: number; s: number }> {
    const obj: Record<string, { b: number; s: number }> = {};
    for (const [price, data] of buckets) {
        obj[String(price)] = { b: data.buy, s: data.sell };
    }
    return obj;
}

async function persistCandle(tf: string, agg: CandleAgg): Promise<void> {
    try {
        const bucketsJson = JSON.stringify(bucketsToJson(agg.buckets));
        const delta = agg.totalBuy - agg.totalSell;
        await pool.query(
            `INSERT INTO footprint_candles (pair, timeframe, open_time, close_time, buckets, total_buy_qty, total_sell_qty, delta)
             VALUES ('BTC', $1, to_timestamp($2::double precision / 1000), to_timestamp($3::double precision / 1000), $4::jsonb, $5, $6, $7)
             ON CONFLICT (pair, timeframe, open_time) DO UPDATE SET
               buckets = EXCLUDED.buckets,
               total_buy_qty = EXCLUDED.total_buy_qty,
               total_sell_qty = EXCLUDED.total_sell_qty,
               delta = EXCLUDED.delta`,
            [tf, agg.openTime, agg.closeTime, bucketsJson, agg.totalBuy, agg.totalSell, delta],
        );
    } catch (err) {
        logger.error({ err, tf, openTime: agg.openTime }, "footprint_persist_error");
    }
}

function handleTrade(price: number, qty: number, isSell: boolean, timestampMs: number): void {
    const bucket = Math.floor(price / 10) * 10;

    for (const tf of TIMEFRAMES) {
        const tfMs = TF_MS[tf]!;
        const openTime = getOpenTime(timestampMs, tfMs);

        if (active[tf] === null) {
            active[tf] = newCandleAgg(openTime, tfMs);
        }

        if (openTime !== active[tf]!.openTime) {
            // New candle started — persist completed candle
            persistCandle(tf, active[tf]!).catch(() => {});
            active[tf] = newCandleAgg(openTime, tfMs);
        }

        const agg = active[tf]!;
        const entry = agg.buckets.get(bucket) ?? { buy: 0, sell: 0 };
        if (isSell) {
            entry.sell += qty;
            agg.totalSell += qty;
        } else {
            entry.buy += qty;
            agg.totalBuy += qty;
        }
        agg.buckets.set(bucket, entry);
    }
}

function connect(): void {
    if (ws) return;

    ws = new WebSocket(KRAKEN_WS_URL);

    ws.on("open", () => {
        logger.info("[footprint] Kraken WS connected");
        reconnectAttempt = 0;

        // Subscribe to BTC/USD trades
        ws?.send(JSON.stringify({
            method: "subscribe",
            params: { channel: "trade", symbol: ["BTC/USD"] },
        }));
    });

    ws.on("message", (raw: WebSocket.Data) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.channel !== "trade" || !Array.isArray(msg.data)) return;

            for (const trade of msg.data) {
                const price = parseFloat(trade.price);
                const qty = parseFloat(trade.qty);
                const isSell = trade.side === "sell";
                const timestampMs = new Date(trade.timestamp).getTime();

                if (!isFinite(price) || !isFinite(qty) || qty <= 0) continue;
                handleTrade(price, qty, isSell, timestampMs);
            }
        } catch {
            // Ignore parse errors for non-trade messages (heartbeats, status, etc.)
        }
    });

    ws.on("close", () => {
        logger.info("[footprint] Kraken WS closed");
        ws = null;
        scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
        logger.error({ err: err.message }, "[footprint] Kraken WS error");
        ws?.close();
        ws = null;
    });
}

function scheduleReconnect(): void {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
    reconnectAttempt++;
    logger.info({ delay, attempt: reconnectAttempt }, "[footprint] reconnecting...");
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

export function startFootprintAggregator(): void {
    connect();
    logger.info("[footprint] aggregator started");
}

export function stopFootprintAggregator(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.close(); ws = null; }
    // Persist any active candles
    for (const tf of TIMEFRAMES) {
        if (active[tf]) {
            persistCandle(tf, active[tf]!).catch(() => {});
            active[tf] = null;
        }
    }
    logger.info("[footprint] aggregator stopped");
}
