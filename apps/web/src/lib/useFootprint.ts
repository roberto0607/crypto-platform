import { useState, useEffect, useRef, useCallback } from "react";
import client from "@/api/client";

export interface FootprintBucket { b: number; s: number }
export interface FootprintCandle {
    openTimeMs: number;
    closeTimeMs: number;
    buckets: Record<string, FootprintBucket>;
    totalBuy: number;
    totalSell: number;
    delta: number;
}

interface RawCandle {
    open_time_ms: number | string;
    close_time_ms: number | string;
    buckets: Record<string, FootprintBucket>;
    total_buy_qty: number | string;
    total_sell_qty: number | string;
    delta: number | string;
}

interface LiveCandle {
    openTime: number;
    closeTime: number;
    buckets: Record<string, FootprintBucket>;
    totalBuy: number;
    totalSell: number;
    delta: number;
}

const SUPPORTED_TF = new Set(["1m", "5m", "15m"]);

function parseNum(v: number | string): number {
    return typeof v === "string" ? parseFloat(v) : v;
}

function parseRawCandle(c: RawCandle): FootprintCandle {
    return {
        openTimeMs: parseNum(c.open_time_ms),
        closeTimeMs: parseNum(c.close_time_ms),
        buckets: c.buckets,
        totalBuy: parseNum(c.total_buy_qty),
        totalSell: parseNum(c.total_sell_qty),
        delta: parseNum(c.delta),
    };
}

export function useFootprint(
    enabled: boolean,
    timeframe: string,
    pair: string,
): Map<number, FootprintCandle> {
    const [data, setData] = useState<Map<number, FootprintCandle>>(new Map());
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const mapRef = useRef<Map<number, FootprintCandle>>(new Map());

    const fetchHistory = useCallback(async (from: number, to: number): Promise<Map<number, FootprintCandle>> => {
        try {
            const res = await client.get<RawCandle[]>(
                "/v1/market/footprint",
                { params: { pair, timeframe, from, to } },
            );
            const rows = Array.isArray(res.data) ? res.data : [];
            const map = new Map<number, FootprintCandle>();
            for (const c of rows) {
                const parsed = parseRawCandle(c);
                map.set(parsed.openTimeMs, parsed);
            }
            return map;
        } catch {
            return new Map();
        }
    }, [pair, timeframe]);

    const fetchLive = useCallback(async (): Promise<FootprintCandle | null> => {
        try {
            const res = await client.get<Record<string, LiveCandle | null>>(
                "/v1/market/footprint/live",
            );
            const live = res.data[timeframe];
            if (!live) return null;
            return {
                openTimeMs: live.openTime,
                closeTimeMs: live.closeTime,
                buckets: live.buckets,
                totalBuy: live.totalBuy,
                totalSell: live.totalSell,
                delta: live.delta,
            };
        } catch {
            return null;
        }
    }, [timeframe]);

    useEffect(() => {
        if (!enabled || !SUPPORTED_TF.has(timeframe)) {
            mapRef.current = new Map();
            setData(new Map());
            return;
        }

        // Initial load: last 24h
        const now = Date.now();
        fetchHistory(now - 86_400_000, now).then((histMap) => {
            mapRef.current = histMap;
            // Also fetch live candle immediately
            fetchLive().then((live) => {
                if (live) mapRef.current.set(live.openTimeMs, live);
                setData(new Map(mapRef.current));
            });
        });

        // Poll every 2s: fetch latest 2 completed candles + live forming candle
        intervalRef.current = setInterval(async () => {
            const n = Date.now();
            const tfMs = timeframe === "1m" ? 60_000 : timeframe === "5m" ? 300_000 : 900_000;

            // Fetch recent completed candles
            const recent = await fetchHistory(n - tfMs * 2, n);
            for (const [k, v] of recent) mapRef.current.set(k, v);

            // Fetch live forming candle
            const live = await fetchLive();
            if (live) mapRef.current.set(live.openTimeMs, live);

            setData(new Map(mapRef.current));
        }, 2000);

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [enabled, timeframe, pair, fetchHistory, fetchLive]);

    return data;
}
