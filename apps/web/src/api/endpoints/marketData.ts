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
