import client from "../client";

export interface SignalExplanation {
    summary: string;
    reasons: { icon: string; text: string; weight: string }[];
    caution: string | null;
    model_votes: Record<string, string> | null;
    attention_highlight: string | null;
}

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
    explanation: SignalExplanation | null;
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

export interface EquityCurvePoint {
    ts: string;
    cumPnlPct: number;
    signalId: string;
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

export function getEquityCurve() {
    return client.get<{
        ok: true;
        curve: EquityCurvePoint[];
        totalReturn: number;
        maxDrawdown: number;
        sharpe: number;
        totalSignals: number;
        winRate: number;
    }>("/v1/signals/equity-curve");
}

export interface OrderFlowFeatures {
    bidAskImbalance: number;
    weightedImbalance: number;
    topLevelImbalance: number;
    bidDepthUsd: number;
    askDepthUsd: number;
    depthRatio: number;
    spreadBps: number;
    largeOrderBid: boolean;
    largeOrderAsk: boolean;
    maxBidSize: number;
    maxAskSize: number;
    bidWallPrice: number | null;
    askWallPrice: number | null;
    bidWallDistance: number;
    askWallDistance: number;
    ts: number;
}

export function getOrderFlow(pairId: string) {
    return client.get<{
        ok: true;
        features: OrderFlowFeatures | null;
    }>(`/v1/pairs/${pairId}/order-flow`);
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
