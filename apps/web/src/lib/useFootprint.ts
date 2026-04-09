import { useState, useEffect, useRef } from "react";
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

const SUPPORTED_TF = new Set(["1m", "5m", "15m"]);

export function useFootprint(
    enabled: boolean,
    timeframe: string,
    pair: string,
): Map<number, FootprintCandle> {
    const [data, setData] = useState<Map<number, FootprintCandle>>(new Map());
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (!enabled || !SUPPORTED_TF.has(timeframe)) {
            setData(new Map());
            return;
        }

        const fetchData = async (from: number, to: number, merge: boolean) => {
            try {
                const res = await client.get<{ ok: true; candles: Array<{
                    open_time_ms: number | string;
                    close_time_ms: number | string;
                    buckets: Record<string, FootprintBucket>;
                    total_buy_qty: number | string;
                    total_sell_qty: number | string;
                    delta: number | string;
                }> }>("/v1/market/footprint", { params: { pair, timeframe, from, to } });

                const newMap = merge ? new Map(data) : new Map<number, FootprintCandle>();
                for (const c of res.data.candles) {
                    const openTimeMs = typeof c.open_time_ms === "string" ? parseFloat(c.open_time_ms) : c.open_time_ms;
                    newMap.set(openTimeMs, {
                        openTimeMs,
                        closeTimeMs: typeof c.close_time_ms === "string" ? parseFloat(c.close_time_ms) : c.close_time_ms,
                        buckets: c.buckets,
                        totalBuy: typeof c.total_buy_qty === "string" ? parseFloat(c.total_buy_qty) : c.total_buy_qty,
                        totalSell: typeof c.total_sell_qty === "string" ? parseFloat(c.total_sell_qty) : c.total_sell_qty,
                        delta: typeof c.delta === "string" ? parseFloat(c.delta) : c.delta,
                    });
                }
                setData(newMap);
            } catch { /* non-fatal */ }
        };

        // Initial load: last 24h
        const now = Date.now();
        fetchData(now - 86_400_000, now, false);

        // Poll every 5s for latest 2 candles
        intervalRef.current = setInterval(() => {
            const n = Date.now();
            const tfMs = timeframe === "1m" ? 60_000 : timeframe === "5m" ? 300_000 : 900_000;
            fetchData(n - tfMs * 2, n, true);
        }, 5000);

        return () => {
            if (intervalRef.current) clearInterval(intervalRef.current);
        };
    }, [enabled, timeframe, pair]); // eslint-disable-line react-hooks/exhaustive-deps

    return data;
}
