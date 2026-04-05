import client from "../client";

export interface FundingRateData {
    btc: { rate: number; nextFundingTime: number };
    eth: { rate: number; nextFundingTime: number };
    sol: { rate: number; nextFundingTime: number };
}

export interface OIHistoryPoint {
    time: number;
    value: number;
}

export interface OpenInterestData {
    btc: { current: number; history: OIHistoryPoint[] };
    eth: { current: number; history: OIHistoryPoint[] };
    sol: { current: number; history: OIHistoryPoint[] };
}

export function fetchFundingRate() {
    return client.get<{ ok: true } & FundingRateData>("/v1/market/funding-rate");
}

export function fetchOpenInterest() {
    return client.get<{ ok: true } & OpenInterestData>("/v1/market/open-interest");
}
