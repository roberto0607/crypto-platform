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

function toNum(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v === "string") return parseFloat(v);
    return Number(v) || 0;
}

function parseRawCandle(c: RawCandle): FootprintCandle {
    return {
        openTimeMs: toNum(c.open_time_ms),
        closeTimeMs: toNum(c.close_time_ms),
        buckets: c.buckets ?? {},
        totalBuy: toNum(c.total_buy_qty),
        totalSell: toNum(c.total_sell_qty),
        delta: toNum(c.delta),
    };
}

export function useFootprint(
    enabled: boolean,
    timeframe: string,
    pair: string,
): Map<number, FootprintCandle> {
    const [data, setData] = useState<Map<number, FootprintCandle>>(new Map());
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
                // Floor to integer ms — SQL ::double precision preserves microsecond
                // fractions, but live candle openTime is a clean int. Without floor,
                // history and live slots never collide in the Map.
                map.set(Math.floor(parsed.openTimeMs), parsed);
            }
            console.log("[useFootprint] loaded", map.size, "candles, first key:", [...map.keys()][0], "last key:", [...map.keys()][map.size - 1]);
            console.log(
                "[useFootprint] key type:",
                typeof [...map.keys()][0],
                "value:",
                [...map.keys()][0],
            );
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
                openTimeMs: Number(live.openTime) || 0,
                closeTimeMs: Number(live.closeTime) || 0,
                buckets: live.buckets ?? {},
                totalBuy: Number(live.totalBuy) || 0,
                totalSell: Number(live.totalSell) || 0,
                delta: Number(live.delta) || 0,
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
                if (live) mapRef.current.set(Math.floor(live.openTimeMs), live);
                setData(new Map(mapRef.current));
            });
        });

        // Fast poll: live forming candle (every 2s)
        const liveInterval = setInterval(async () => {
            const live = await fetchLive();
            if (live) {
                mapRef.current.set(Math.floor(live.openTimeMs), live);
                setData(new Map(mapRef.current));
            }
        }, 2000);

        // Slow poll: recently completed candles (every 30s)
        const historyInterval = setInterval(async () => {
            const n = Date.now();
            const recent = await fetchHistory(n - 5 * 60_000, n);
            for (const [k, v] of recent) mapRef.current.set(k, v);
            setData(new Map(mapRef.current));
        }, 30_000);

        return () => {
            clearInterval(liveInterval);
            clearInterval(historyInterval);
        };
    }, [enabled, timeframe, pair, fetchHistory, fetchLive]);

    return data;
}
