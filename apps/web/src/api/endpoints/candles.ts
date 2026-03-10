import client from "../client";

export interface Candle {
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    buy_volume?: string;
    sell_volume?: string;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export function getCandles(
    pairId: string,
    params?: { timeframe?: Timeframe; limit?: number; before?: string },
) {
    return client.get<{ ok: true; candles: Candle[] }>(
        `/v1/pairs/${pairId}/candles`,
        { params },
    );
}
