/**
 * v1Market.ts — Funding Rate and Open Interest via Gate.io (US-accessible).
 *
 * Binance fapi and Bybit are geo-blocked from US servers (Railway).
 * Gate.io futures API works from all regions and provides historical data.
 *
 * GET /v1/market/funding-rate — funding rate history for BTC, ETH, SOL
 * GET /v1/market/open-interest — OI history for BTC, ETH, SOL
 */

import type { FastifyPluginAsync } from "fastify";
import { logger } from "../../observability/logContext";
import { pool } from "../../db/pool";
import { getLiveFootprintCandles } from "../../services/footprintAggregator";

const SYMBOLS: Record<string, string> = { btc: "BTC_USDT", eth: "ETH_USDT", sol: "SOL_USDT" };
const FETCH_TIMEOUT = 5000;
const HISTORY_LIMIT = 200;

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

// ── Gate.io: Funding rate history ──
async function fetchFundingHistory(contract: string): Promise<{ rate: number; nextFundingTime: number; history: Array<{ time: number; value: number }> }> {
    try {
        // Fetch history (200 most recent 8h periods)
        const histRes = await fetchWithTimeout(
            `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${contract}&limit=${HISTORY_LIMIT}`,
        );
        if (!histRes.ok) throw new Error(`Gate.io funding history ${histRes.status}`);
        const histData = await histRes.json() as Array<{ r: string; t: number }>;

        const history = histData
            .map((d) => ({ time: d.t, value: parseFloat(d.r) * 100 }))
            .reverse(); // oldest first for charting

        // Fetch current contract info for next funding time
        const infoRes = await fetchWithTimeout(
            `https://api.gateio.ws/api/v4/futures/usdt/contracts/${contract}`,
        );
        let nextFundingTime = 0;
        let currentRate = 0;
        if (infoRes.ok) {
            const info = await infoRes.json() as { funding_rate: string; funding_next_apply: number };
            currentRate = parseFloat(info.funding_rate);
            nextFundingTime = info.funding_next_apply * 1000; // convert to ms
        }

        return {
            rate: currentRate,
            nextFundingTime,
            history,
        };
    } catch (err) {
        logger.error({ err, contract }, "gateio_funding_fetch_error");
        return { rate: 0, nextFundingTime: 0, history: [] };
    }
}

// ── Gate.io: OI history ──
async function fetchOIHistory(contract: string): Promise<{ current: number; history: Array<{ time: number; value: number }> }> {
    try {
        const from = Math.floor(Date.now() / 1000) - HISTORY_LIMIT * 3600; // ~200 hours back
        const res = await fetchWithTimeout(
            `https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${contract}&limit=${HISTORY_LIMIT}&from=${from}`,
        );
        if (!res.ok) throw new Error(`Gate.io OI history ${res.status}`);
        const data = await res.json() as Array<{ time: number; open_interest_usd: number }>;

        const history = data.map((d) => ({
            time: d.time,
            value: d.open_interest_usd,
        }));

        const current = history.length > 0 ? history[history.length - 1]!.value : 0;

        return { current, history };
    } catch (err) {
        logger.error({ err, contract }, "gateio_oi_fetch_error");
        return { current: 0, history: [] };
    }
}

// ── Routes ──
const v1Market: FastifyPluginAsync = async (app) => {

    // GET /v1/market/funding-rate
    app.get("/market/funding-rate", {
        schema: {
            tags: ["Market"],
            summary: "Funding rate history (Gate.io)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("funding-rate");
        if (cached) return reply.send({ ok: true, ...cached });

        const result: Record<string, unknown> = {};
        await Promise.all(Object.entries(SYMBOLS).map(async ([key, contract]) => {
            result[key] = await fetchFundingHistory(contract);
        }));

        setCache("funding-rate", result, 60_000);
        return reply.send({ ok: true, ...result });
    });

    // GET /v1/market/open-interest
    app.get("/market/open-interest", {
        schema: {
            tags: ["Market"],
            summary: "Open interest history (Gate.io)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("open-interest");
        if (cached) return reply.send({ ok: true, ...cached });

        const result: Record<string, unknown> = {};
        await Promise.all(Object.entries(SYMBOLS).map(async ([key, contract]) => {
            result[key] = await fetchOIHistory(contract);
        }));

        setCache("open-interest", result, 300_000);
        return reply.send({ ok: true, ...result });
    });
    // GET /v1/market/footprint
    app.get("/market/footprint", {
        schema: {
            tags: ["Market"],
            summary: "Footprint candle data (aggregated trade buckets)",
            querystring: {
                type: "object",
                properties: {
                    pair: { type: "string", default: "BTC" },
                    timeframe: { type: "string", default: "1m" },
                    from: { type: "string" },
                    to: { type: "string" },
                },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (req, reply) => {
        const q = req.query as { pair?: string; timeframe?: string; from?: string; to?: string };
        const pair = q.pair ?? "BTC";
        const timeframe = q.timeframe ?? "1m";
        const from = q.from ? parseInt(q.from, 10) : Date.now() - 86_400_000;
        const to = q.to ? parseInt(q.to, 10) : Date.now();

        const cacheKey = `footprint:${pair}:${timeframe}:${Math.floor(from / 1000)}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) return reply.send({ ok: true, candles: cached });

        try {
            const { rows } = await pool.query(
                `SELECT pair, timeframe,
                    EXTRACT(EPOCH FROM open_time) * 1000 AS open_time_ms,
                    EXTRACT(EPOCH FROM close_time) * 1000 AS close_time_ms,
                    buckets, total_buy_qty, total_sell_qty, delta
                 FROM footprint_candles
                 WHERE pair = $1
                   AND timeframe = $2
                   AND open_time >= to_timestamp($3::double precision / 1000)
                   AND open_time <= to_timestamp($4::double precision / 1000)
                 ORDER BY open_time ASC
                 LIMIT 500`,
                [pair, timeframe, from, to],
            );
            setCache(cacheKey, rows, 1000);
            return reply.send({ ok: true, candles: rows });
        } catch (err) {
            logger.error({ err }, "footprint_query_error");
            return reply.send({ ok: true, candles: [] });
        }
    });

    // GET /v1/market/footprint/live — current forming candles (in memory)
    app.get("/market/footprint/live", {
        schema: {
            tags: ["Market"],
            summary: "Live forming footprint candles (1m, 5m, 15m)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<unknown>("footprint-live");
        if (cached) return reply.send({ ok: true, candles: cached });

        const live = getLiveFootprintCandles();
        setCache("footprint-live", live, 1000);
        return reply.send({ ok: true, candles: live });
    });
};

export default v1Market;
