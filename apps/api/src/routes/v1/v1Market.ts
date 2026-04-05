/**
 * v1Market.ts — Funding Rate and Open Interest from Binance (Bybit fallback).
 *
 * GET /v1/market/funding-rate — current funding rates for BTC, ETH, SOL
 * GET /v1/market/open-interest — current + historical OI for BTC, ETH, SOL
 *
 * Both endpoints are public (no auth), cached server-side.
 */

import type { FastifyPluginAsync } from "fastify";
import { logger } from "../../observability/logContext";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
const SYMBOL_KEY: Record<string, string> = { BTCUSDT: "btc", ETHUSDT: "eth", SOLUSDT: "sol" };
const FETCH_TIMEOUT = 3000;

// ── Cache ──
interface CacheEntry<T> { data: T; expiresAt: number }
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
    const entry = cache.get(key) as CacheEntry<T> | undefined;
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Fetch with timeout ──
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ── Binance funding rate ──
async function fetchBinanceFunding(symbol: string): Promise<{ rate: number; nextFundingTime: number } | null> {
    try {
        const res = await fetchWithTimeout(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
        if (!res.ok) return null;
        const data = await res.json() as { lastFundingRate: string; nextFundingTime: number };
        return { rate: parseFloat(data.lastFundingRate), nextFundingTime: data.nextFundingTime };
    } catch { return null; }
}

// ── Bybit funding rate fallback ──
async function fetchBybitFunding(symbol: string): Promise<{ rate: number; nextFundingTime: number } | null> {
    try {
        const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
        if (!res.ok) return null;
        const data = await res.json() as { result: { list: Array<{ fundingRate: string; nextFundingTime: string }> } };
        const item = data.result?.list?.[0];
        if (!item) return null;
        return { rate: parseFloat(item.fundingRate), nextFundingTime: parseInt(item.nextFundingTime, 10) };
    } catch { return null; }
}

// ── Binance open interest (current) ──
async function fetchBinanceOI(symbol: string): Promise<number | null> {
    try {
        const res = await fetchWithTimeout(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`);
        if (!res.ok) return null;
        const data = await res.json() as { openInterest: string };
        return parseFloat(data.openInterest);
    } catch { return null; }
}

// ── Binance OI history ──
async function fetchBinanceOIHistory(symbol: string): Promise<Array<{ time: number; value: number }> | null> {
    try {
        const res = await fetchWithTimeout(
            `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=200`,
            5000,
        );
        if (!res.ok) return null;
        const data = await res.json() as Array<{ timestamp: number; sumOpenInterestValue: string }>;
        return data.map((d) => ({ time: Math.floor(d.timestamp / 1000), value: parseFloat(d.sumOpenInterestValue) }));
    } catch { return null; }
}

// ── Bybit OI fallback ──
async function fetchBybitOI(symbol: string): Promise<number | null> {
    try {
        const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
        if (!res.ok) return null;
        const data = await res.json() as { result: { list: Array<{ openInterest: string }> } };
        return parseFloat(data.result?.list?.[0]?.openInterest ?? "0");
    } catch { return null; }
}

async function fetchBybitOIHistory(symbol: string): Promise<Array<{ time: number; value: number }> | null> {
    try {
        const res = await fetchWithTimeout(
            `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=200`,
            5000,
        );
        if (!res.ok) return null;
        const data = await res.json() as { result: { list: Array<{ timestamp: string; openInterest: string }> } };
        return data.result?.list?.map((d: { timestamp: string; openInterest: string }) => ({
            time: Math.floor(parseInt(d.timestamp, 10) / 1000),
            value: parseFloat(d.openInterest),
        })).reverse() ?? null;
    } catch { return null; }
}

// ── Routes ──
const v1Market: FastifyPluginAsync = async (app) => {

    // GET /v1/market/funding-rate
    app.get("/market/funding-rate", {
        schema: {
            tags: ["Market"],
            summary: "Current perpetual funding rates (Binance/Bybit)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("funding-rate");
        if (cached) return reply.send({ ok: true, ...cached });

        const result: Record<string, unknown> = {};
        await Promise.all(SYMBOLS.map(async (sym) => {
            const key = SYMBOL_KEY[sym]!;
            let data = await fetchBinanceFunding(sym);
            if (!data) {
                data = await fetchBybitFunding(sym);
                if (data) logger.info({ sym }, "funding_rate_bybit_fallback");
            }
            result[key] = data ?? { rate: 0, nextFundingTime: 0 };
        }));

        setCache("funding-rate", result, 60_000);
        return reply.send({ ok: true, ...result });
    });

    // GET /v1/market/open-interest
    app.get("/market/open-interest", {
        schema: {
            tags: ["Market"],
            summary: "Current + historical open interest (Binance/Bybit)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("open-interest");
        if (cached) return reply.send({ ok: true, ...cached });

        const result: Record<string, unknown> = {};
        await Promise.all(SYMBOLS.map(async (sym) => {
            const key = SYMBOL_KEY[sym]!;
            let current = await fetchBinanceOI(sym);
            let history = await fetchBinanceOIHistory(sym);
            if (current === null) {
                current = await fetchBybitOI(sym);
                if (current !== null) logger.info({ sym }, "oi_current_bybit_fallback");
            }
            if (!history) {
                history = await fetchBybitOIHistory(sym);
                if (history) logger.info({ sym }, "oi_history_bybit_fallback");
            }
            result[key] = { current: current ?? 0, history: history ?? [] };
        }));

        setCache("open-interest", result, 300_000);
        return reply.send({ ok: true, ...result });
    });
};

export default v1Market;
