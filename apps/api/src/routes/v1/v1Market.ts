/**
 * v1Market.ts — Funding Rate and Open Interest via CoinGecko (US-accessible).
 *
 * Binance fapi and Bybit are geo-blocked from US servers (Railway).
 * CoinGecko derivatives API provides funding rate and OI without restrictions.
 *
 * GET /v1/market/funding-rate — current funding rates for BTC, ETH, SOL
 * GET /v1/market/open-interest — current OI for BTC, ETH, SOL
 */

import type { FastifyPluginAsync } from "fastify";
import { logger } from "../../observability/logContext";

const FETCH_TIMEOUT = 5000;

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

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ── CoinGecko derivatives — returns all perpetual contracts ──
interface CoinGeckoDerivative {
    symbol: string;
    base: string;
    funding_rate: number;
    open_interest: number;
    index: string; // exchange name
}

async function fetchCoinGeckoDerivatives(): Promise<CoinGeckoDerivative[]> {
    try {
        const res = await fetchWithTimeout("https://api.coingecko.com/api/v3/derivatives?order=h24_volume_desc");
        if (!res.ok) {
            logger.error({ status: res.status }, "coingecko_derivatives_fetch_error");
            return [];
        }
        return await res.json() as CoinGeckoDerivative[];
    } catch (err) {
        logger.error({ err }, "coingecko_derivatives_fetch_exception");
        return [];
    }
}

function findBestContract(derivatives: CoinGeckoDerivative[], base: string): CoinGeckoDerivative | null {
    // Prefer Binance, then largest OI
    const matches = derivatives.filter((d) =>
        d.base?.toUpperCase() === base.toUpperCase() &&
        d.symbol?.includes("USDT"),
    );
    const binance = matches.find((d) => d.index?.toLowerCase().includes("binance"));
    if (binance) return binance;
    return matches.sort((a, b) => (b.open_interest ?? 0) - (a.open_interest ?? 0))[0] ?? null;
}

// ── Routes ──
const v1Market: FastifyPluginAsync = async (app) => {

    // GET /v1/market/funding-rate
    app.get("/market/funding-rate", {
        schema: {
            tags: ["Market"],
            summary: "Current perpetual funding rates (CoinGecko)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("funding-rate");
        if (cached) return reply.send({ ok: true, ...cached });

        const derivatives = await fetchCoinGeckoDerivatives();
        const result: Record<string, unknown> = {};

        for (const base of ["BTC", "ETH", "SOL"]) {
            const key = base.toLowerCase();
            const contract = findBestContract(derivatives, base);
            result[key] = {
                rate: contract?.funding_rate ?? 0,
                nextFundingTime: 0, // CoinGecko doesn't provide next funding time
            };
        }

        setCache("funding-rate", result, 60_000);
        return reply.send({ ok: true, ...result });
    });

    // GET /v1/market/open-interest
    app.get("/market/open-interest", {
        schema: {
            tags: ["Market"],
            summary: "Current open interest (CoinGecko)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("open-interest");
        if (cached) return reply.send({ ok: true, ...cached });

        const derivatives = await fetchCoinGeckoDerivatives();
        const result: Record<string, unknown> = {};

        for (const base of ["BTC", "ETH", "SOL"]) {
            const key = base.toLowerCase();
            const contract = findBestContract(derivatives, base);
            result[key] = {
                current: contract?.open_interest ?? 0,
                history: [], // CoinGecko free tier doesn't provide historical OI
            };
        }

        setCache("open-interest", result, 300_000);
        return reply.send({ ok: true, ...result });
    });
};

export default v1Market;
