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
