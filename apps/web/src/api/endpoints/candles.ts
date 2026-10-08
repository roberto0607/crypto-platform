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
    /** The still-forming bucket — only ever the last row of the latest page. */
    partial?: boolean;
}

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export function getCandles(
    pairId: string,
    params?: { timeframe?: Timeframe; limit?: number; before?: string },
) {
    return client.get<{ ok: true; candles: Candle[] }>(
        `/v1/pairs/${pairId}/candles`,
        { params },
    );
}
