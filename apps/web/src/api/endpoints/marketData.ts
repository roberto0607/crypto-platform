import client from "../client";

export interface FundingHistoryPoint {
    time: number;
    value: number;
}

export interface FundingRateEntry {
    rate: number;
    nextFundingTime: number;
    history: FundingHistoryPoint[];
}

export interface FundingRateData {
    btc: FundingRateEntry;
    eth: FundingRateEntry;
    sol: FundingRateEntry;
}

export interface OIHistoryPoint {
    time: number;
    value: number;
}

export interface OIEntry {
    current: number;
    history: OIHistoryPoint[];
}

export interface OpenInterestData {
    btc: OIEntry;
    eth: OIEntry;
    sol: OIEntry;
}

export function fetchFundingRate() {
    return client.get<{ ok: true } & FundingRateData>("/v1/market/funding-rate");
}

export function fetchOpenInterest() {
    return client.get<{ ok: true } & OpenInterestData>("/v1/market/open-interest");
}

export interface LiquidationCluster {
    price: number;
    side: "long" | "short";
    estimatedUSD: number;
    leverage: number;
    intensity: number;
}

export interface LiquidationLevelsResponse {
    disclaimer: "estimated";
    currentPrice: number;
    calculatedAt: string;
    clusters: LiquidationCluster[];
    sources: string[];
}

export function fetchLiquidationLevels(ccy: string) {
    return client.get<LiquidationLevelsResponse>(`/v1/market/liquidation-levels/${ccy}`);
}

export interface COTWeek {
    date: string;
    nonCommercialLong: number;
    nonCommercialShort: number;
    netPosition: number;
    commercialLong: number;
    commercialShort: number;
}

export interface COTResponse {
    weeks: COTWeek[];
}

export function fetchCOT(ccy: string) {
    return client.get<COTResponse>(`/v1/market/cot/${ccy}`);
}

// ── Cycle Intelligence ──
export interface CyclePosition {
    daysSinceHalving: number;
    daysToNextHalving: number;
    cycleNumber: number;
    cyclePercent: number;
    phase: string;
    phaseColor: string;
    lastHalvingDate: string;
    nextHalvingDate: string;
}

export interface PowerLaw {
    fairValue: number;
    floorValue: number;
    ceilingValue: number;
    corridorPercent: number;
    interpretation: string;
}

export interface OnChainMetric {
    value: number;
    percentile: number;
    signal: string;
    history: number[];
    thresholds: Record<string, number>;
    description: string;
}

export interface CycleAnalog {
    date: string;
    startDate: string;
    similarityScore: number;
    priceAtTime: number;
    cycleDay: number;
    priceChange: {
        "30d": { pct: number; price: number };
        "90d": { pct: number; price: number };
        "180d": { pct: number; price: number };
    };
    historicalPrices: number[];
    forwardPrices: number[];
    breakdown: { score: number; price: number; cycle: number; onchain: number; volatility: number };
}

export interface CycleConsensusHorizon {
    median: number;
    min: number;
    max: number;
    bullish: number;
    bearish: number;
}

export interface CycleAnalysis {
    lastUpdated: string;
    currentPrice: number;
    cyclePosition: CyclePosition;
    powerLaw: PowerLaw;
    onChain: {
        mvrv: OnChainMetric;
        nupl: OnChainMetric;
        puellMultiple: OnChainMetric;
        reserveRisk: OnChainMetric;
    };
    currentWindow: { prices: number[]; cycleDay: number };
    analogs: CycleAnalog[];
    consensus: { "30d": CycleConsensusHorizon; "90d": CycleConsensusHorizon; "180d": CycleConsensusHorizon };
    disclaimer: string;
}

export function fetchCycleAnalysis() {
    return client.get<CycleAnalysis>("/v1/cycle/analysis");
}

export interface CycleNarrativeResponse {
    narrative: string | null;
    error?: string;
}

export function fetchCycleNarrative(cycleData: CycleAnalysis) {
    return client.post<CycleNarrativeResponse>("/v1/cycle/narrative", { cycleData });
}
