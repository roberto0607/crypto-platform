import client from "../client";

export interface SignalExplanation {
    summary: string;
    reasons: { icon: string; text: string; weight: string }[];
    caution: string | null;
    model_votes: Record<string, string> | null;
    attention_highlight: string | null;
}

export interface ForecastHorizon {
    p10: number;
    p50: number;
    p90: number;
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
    regime?: string;
    regimeConfidence?: number;
    strategy?: string;
    forecast?: Record<string, ForecastHorizon>;
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

export interface DerivativesSnapshot {
    fundingRate: number;
    fundingTime: number;
    markPrice: number;
    openInterest: number;
    openInterestUsd: number;
    oiChangePct: number;
    globalLsRatio: number;
    globalLongPct: number;
    globalShortPct: number;
    topLsRatio: number;
    topLongPct: number;
    topShortPct: number;
    liqPressure: number;
    liqIntensity: number;
    ts: number;
}

export function getDerivatives(pairId: string) {
    return client.get<{
        ok: true;
        derivatives: DerivativesSnapshot | null;
    }>(`/v1/pairs/${pairId}/derivatives`);
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

export interface ConfidenceBar {
    ts: number;
    direction: "BUY" | "SELL" | "NEUTRAL";
    confidence: number;
}

export function getConfidenceHeatmap(
    pairId: string,
    params?: { timeframe?: string; limit?: number },
) {
    return client.get<{
        ok: true;
        bars: ConfidenceBar[];
    }>(`/v1/pairs/${pairId}/confidence-heatmap`, { params });
}

export interface LiquidityZone {
    price: number;
    width: number;
    strength: number;
    type: "support" | "resistance";
    sources: string[];
    estimatedLiquidity: string;
}

export function getLiquidityZones(
    pairId: string,
    params?: { timeframe?: string },
) {
    return client.get<{
        ok: true;
        zones: LiquidityZone[];
        currentPrice: number;
    }>(`/v1/pairs/${pairId}/liquidity-zones`, { params });
}

export interface ChartPattern {
    type: string;
    status: "forming" | "confirmed";
    completionPct: number;
    completionProb: number;
    impliedDirection: "BUY" | "SELL";
    entryZone: number;
    targetPrice: number;
    invalidationPrice: number;
    keyPoints: { time: number; price: number; label: string }[];
    projection: { time: number; price: number }[];
}

export interface GhostCandle {
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    confidence: number;
}

export interface PriceScenario {
    name: "bull" | "base" | "bear";
    probability: number;
    finalPrice: number;
    totalReturnPct: number;
    candles: GhostCandle[];
}

export function getScenarios(
    pairId: string,
    params?: { timeframe?: string },
) {
    return client.get<{
        ok: true;
        scenarios: PriceScenario[];
        currentPrice: number;
        generatedAt: string;
    }>(`/v1/pairs/${pairId}/scenarios`, { params });
}

export function getPatterns(
    pairId: string,
    params?: { timeframe?: string },
) {
    return client.get<{
        ok: true;
        patterns: ChartPattern[];
    }>(`/v1/pairs/${pairId}/patterns`, { params });
}

export interface CopilotAnalysis {
    conviction: number;
    convictionLabel: string;
    marketRead: string;
    tradeIdea: string;
    tradeLevels: {
        entry: number;
        tp1: number | null;
        tp2: number | null;
        tp3: number | null;
        sl: number | null;
        rrRatio: number;
        tp1Prob: number;
        tp2Prob: number;
        tp3Prob: number;
    } | null;
    riskFlags: { severity: string; text: string; icon: string }[];
    positionAdvice: string;
    keyDatapoints: { label: string; value: string; sentiment: string }[];
    changesSinceLast: string[];
}

export function postCopilotAnalysis(
    pairId: string,
    context: unknown,
) {
    return client.post<{
        ok: true;
        analysis: CopilotAnalysis;
    }>(`/v1/pairs/${pairId}/copilot`, context);
}
