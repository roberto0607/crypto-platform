import client from "../client";

export interface MLSignal {
    id: string;
    pairId: string;
    timeframe: string;
    signalType: "BUY" | "SELL";
    confidence: number;
    entryPrice: string;
    tp1Price: string;
    tp2Price: string;
    tp3Price: string;
    stopLossPrice: string;
    tp1Prob: number;
    tp2Prob: number;
    tp3Prob: number;
    modelVersion: string;
    topFeatures: unknown;
    outcome: string;
    createdAt: string;
    expiresAt: string;
}

export interface SignalPerformance {
    totalSignals: number;
    winRate: number;
    tp1HitRate: number;
    tp2HitRate: number;
    tp3HitRate: number;
    avgConfidence: number;
}

export function getSignals(
    pairId: string,
    params?: { timeframe?: string; limit?: number },
) {
    return client.get<{
        ok: true;
        active: MLSignal | null;
        history: MLSignal[];
        performance: SignalPerformance;
    }>(`/v1/pairs/${pairId}/signals`, { params });
}

export function refreshSignal(
    pairId: string,
    params?: { timeframe?: string },
) {
    return client.post<{
        ok: true;
        signal: MLSignal | null;
        message: string;
    }>(`/v1/pairs/${pairId}/signals/refresh`, null, { params });
}

export function getAggregatePerformance() {
    return client.get<{
        ok: true;
        performance: {
            totalSignals: number;
            wins: number;
            losses: number;
            expired: number;
            winRate: number;
            tp1HitRate: number;
            tp2HitRate: number;
            tp3HitRate: number;
            avgConfidence: number;
        };
    }>("/v1/signals/performance");
}
