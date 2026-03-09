/**
 * Binance Futures REST client — fetches funding rates, open interest,
 * and long/short ratios from public (no auth) endpoints.
 */

const BINANCE_FUTURES_BASE = "https://fapi.binance.com";

/** Map our pair symbols to Binance Futures symbols */
export const BINANCE_PAIR_MAP: Record<string, string> = {
    "BTC/USD": "BTCUSDT",
    "ETH/USD": "ETHUSDT",
    "SOL/USD": "SOLUSDT",
};

// ── Response types ──

export interface BinanceFundingRate {
    symbol: string;
    fundingRate: string;
    fundingTime: number;
    markPrice: string;
}

export interface BinanceOpenInterest {
    openInterest: string;
    symbol: string;
    time: number;
}

export interface BinanceLSRatio {
    symbol: string;
    longShortRatio: string;
    longAccount: string;
    shortAccount: string;
    timestamp: string;
}

// ── Fetchers ──

export async function fetchFundingRate(
    binanceSymbol: string,
): Promise<BinanceFundingRate | null> {
    try {
        const url = `${BINANCE_FUTURES_BASE}/fapi/v1/fundingRate?symbol=${binanceSymbol}&limit=1`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as BinanceFundingRate[];
        return data.length > 0 ? data[0]! : null;
    } catch {
        return null;
    }
}

export async function fetchOpenInterest(
    binanceSymbol: string,
): Promise<BinanceOpenInterest | null> {
    try {
        const url = `${BINANCE_FUTURES_BASE}/fapi/v1/openInterest?symbol=${binanceSymbol}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return (await res.json()) as BinanceOpenInterest;
    } catch {
        return null;
    }
}

export async function fetchGlobalLSRatio(
    binanceSymbol: string,
): Promise<BinanceLSRatio | null> {
    try {
        const url = `${BINANCE_FUTURES_BASE}/futures/data/globalLongShortAccountRatio?symbol=${binanceSymbol}&period=5m&limit=1`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as BinanceLSRatio[];
        return data.length > 0 ? data[0]! : null;
    } catch {
        return null;
    }
}

export async function fetchTopTraderLSRatio(
    binanceSymbol: string,
): Promise<BinanceLSRatio | null> {
    try {
        const url = `${BINANCE_FUTURES_BASE}/futures/data/topLongShortPositionRatio?symbol=${binanceSymbol}&period=5m&limit=1`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = (await res.json()) as BinanceLSRatio[];
        return data.length > 0 ? data[0]! : null;
    } catch {
        return null;
    }
}
