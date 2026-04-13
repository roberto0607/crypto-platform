/**
 * v1Market.ts — Funding Rate and Open Interest via Gate.io (US-accessible).
 *
 * Binance fapi and Bybit are geo-blocked from US servers (Railway).
 * Gate.io futures API works from all regions and provides historical data.
 * OKX public API is also US-accessible and used to augment BTC OI.
 *
 * GET /v1/market/funding-rate — funding rate history for BTC, ETH, SOL
 * GET /v1/market/open-interest — aggregated OI (Gate.io + OKX for BTC)
 * GET /v1/market/liquidation-levels/:ccy — estimated liquidation clusters
 * GET /v1/market/cot/:ccy — CFTC weekly COT report for CME BTC futures
 */

import type { FastifyPluginAsync } from "fastify";
import { logger } from "../../observability/logContext";
import { pool } from "../../db/pool";
import { getLiveFootprintCandles } from "../../services/footprintAggregator";
import { estimateLiquidationClusters } from "../../market/liquidationEstimator";

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
async function fetchGateIoOI(contract: string): Promise<{ current: number; history: Array<{ time: number; value: number }> } | null> {
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
        return null;
    }
}

// ── OKX: spot mark price for USD conversion ──
async function fetchOKXPrice(ccy: string): Promise<number> {
    try {
        const res = await fetchWithTimeout(
            `https://www.okx.com/api/v5/market/ticker?instId=${ccy}-USDT`,
        );
        if (!res.ok) return 0;
        const json = await res.json() as { data?: Array<{ last?: string }> };
        return parseFloat(json.data?.[0]?.last ?? "0") || 0;
    } catch {
        return 0;
    }
}

// ── OKX: current OI in USD ──
// Rubik returns open-interest-volume as array-of-arrays [ts, oi, oiCcy] historically.
// Defensive: also handle object form if OKX changes shape.
async function fetchOKXOI(ccy: string): Promise<number | null> {
    try {
        const [oiRes, price] = await Promise.all([
            fetchWithTimeout(
                `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=5m&limit=1`,
            ),
            fetchOKXPrice(ccy),
        ]);
        if (!oiRes.ok) throw new Error(`OKX OI ${oiRes.status}`);
        const json = await oiRes.json() as { data?: Array<unknown> };
        const first = json.data?.[0];
        let oiCcy = 0;
        if (Array.isArray(first)) {
            // [ts, oi, oiCcy] — take oiCcy if present, else oi (older shape)
            oiCcy = parseFloat(String(first[2] ?? first[1] ?? "0")) || 0;
        } else if (first && typeof first === "object") {
            const obj = first as { oiCcy?: string; oi?: string };
            oiCcy = parseFloat(obj.oiCcy ?? obj.oi ?? "0") || 0;
        }
        if (oiCcy <= 0 || price <= 0) return null;
        return oiCcy * price;
    } catch (err) {
        logger.error({ err, ccy }, "okx_oi_fetch_error");
        return null;
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

    // GET /v1/market/open-interest — aggregated across Gate.io (+ OKX for BTC)
    app.get("/market/open-interest", {
        schema: {
            tags: ["Market"],
            summary: "Open interest history (Gate.io + OKX aggregated for BTC)",
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (_req, reply) => {
        const cached = getCached<Record<string, unknown>>("open-interest");
        if (cached) return reply.send({ ok: true, ...cached });

        const result: Record<string, unknown> = {};
        await Promise.all(Object.entries(SYMBOLS).map(async ([key, contract]) => {
            // OKX only aggregated for BTC per Stage 5 spec
            const ccy = key.toUpperCase();
            const [gate, okxCurrent] = await Promise.all([
                fetchGateIoOI(contract),
                key === "btc" ? fetchOKXOI(ccy) : Promise.resolve(null),
            ]);

            const sources: string[] = [];
            if (gate) sources.push("gateio");
            if (okxCurrent !== null) sources.push("okx");

            const gateCurrent = gate?.current ?? 0;
            const history = gate?.history ?? [];
            // Sum current values across exchanges. History stays Gate.io-only
            // because OKX doesn't expose the equivalent historical shape.
            const current = gateCurrent + (okxCurrent ?? 0);

            result[key] = { current, history, sources };
        }));

        setCache("open-interest", result, 300_000);
        return reply.send({ ok: true, ...result });
    });
    // GET /v1/market/cot/:ccy — CFTC COT report for CME BTC futures (weekly)
    app.get("/market/cot/:ccy", {
        schema: {
            tags: ["Market"],
            summary: "CFTC Commitments of Traders report (CME BTC futures)",
            params: {
                type: "object",
                required: ["ccy"],
                properties: { ccy: { type: "string" } },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (req, reply) => {
        const { ccy } = req.params as { ccy: string };
        const ccyUpper = ccy.toUpperCase();
        const cacheKey = `cot:${ccyUpper}`;
        const lastGoodKey = `cot-lastgood:${ccyUpper}`;

        const cached = getCached<unknown>(cacheKey);
        if (cached) return reply.send(cached);

        // Only BTC supported — CFTC publishes CME Bitcoin futures COT
        if (ccyUpper !== "BTC") {
            return reply.send({ weeks: [] });
        }

        try {
            const filter = encodeURIComponent(
                "Market_and_Exchange_Names eq 'BITCOIN - CHICAGO MERCANTILE EXCHANGE'",
            );
            const url = `https://publicreporting.cftc.gov/api/odata/v1/TriCombined?$filter=${filter}&$orderby=Report_Date_as_MM_DD_YYYY desc&$top=52`;
            const res = await fetchWithTimeout(url, 10_000);
            if (!res.ok) throw new Error(`CFTC ${res.status}`);
            const body = await res.json() as { value?: Array<Record<string, unknown>> };
            const rows = Array.isArray(body.value) ? body.value : [];

            const weeks = rows
                .map((r) => {
                    const dateRaw = String(r["Report_Date_as_MM_DD_YYYY"] ?? "");
                    // CFTC date format is "MM/DD/YYYY" — normalize to ISO YYYY-MM-DD
                    const [mm, dd, yyyy] = dateRaw.split("/");
                    const date = (yyyy && mm && dd)
                        ? `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`
                        : dateRaw;
                    const nonCommercialLong = Number(r["NonComm_Positions_Long_All"] ?? 0);
                    const nonCommercialShort = Number(r["NonComm_Positions_Short_All"] ?? 0);
                    const commercialLong = Number(r["Comm_Positions_Long_All"] ?? 0);
                    const commercialShort = Number(r["Comm_Positions_Short_All"] ?? 0);
                    return {
                        date,
                        nonCommercialLong,
                        nonCommercialShort,
                        netPosition: nonCommercialLong - nonCommercialShort,
                        commercialLong,
                        commercialShort,
                    };
                })
                // oldest first for charting
                .reverse();

            const result = { weeks };
            setCache(cacheKey, result, 6 * 60 * 60 * 1000); // 6h
            setCache(lastGoodKey, result, 7 * 24 * 60 * 60 * 1000); // 7d safety net
            return reply.send(result);
        } catch (err) {
            logger.error({ err }, "cftc_cot_fetch_error");
            // Never fail the frontend — fall back to last-good snapshot if we have it
            const lastGood = getCached<unknown>(lastGoodKey);
            if (lastGood) return reply.send(lastGood);
            return reply.send({ weeks: [] });
        }
    });

    // GET /v1/market/liquidation-levels/:ccy — estimated liquidation clusters
    app.get("/market/liquidation-levels/:ccy", {
        schema: {
            tags: ["Market"],
            summary: "Estimated liquidation clusters (mathematical estimate)",
            params: {
                type: "object",
                required: ["ccy"],
                properties: { ccy: { type: "string" } },
            },
            response: { 200: { type: "object", additionalProperties: true } },
        },
    }, async (req, reply) => {
        const { ccy } = req.params as { ccy: string };
        const ccyUpper = ccy.toUpperCase();
        const cacheKey = `liq-levels:${ccyUpper}`;
        const cached = getCached<unknown>(cacheKey);
        if (cached) return reply.send(cached);

        // Only BTC supported per Stage 5 spec
        if (ccyUpper !== "BTC") {
            return reply.send({
                disclaimer: "estimated",
                currentPrice: 0,
                calculatedAt: new Date().toISOString(),
                clusters: [],
                sources: [],
            });
        }

        const contract = "BTC_USDT";
        const pairSymbol = "BTC/USD";

        const [gate, okxCurrent, price] = await Promise.all([
            fetchGateIoOI(contract),
            fetchOKXOI(ccyUpper),
            fetchOKXPrice(ccyUpper),
        ]);

        const sources: string[] = [];
        if (gate) sources.push("gateio");
        if (okxCurrent !== null) sources.push("okx");

        const totalOiUsd = (gate?.current ?? 0) + (okxCurrent ?? 0);

        const result = await estimateLiquidationClusters(pairSymbol, price, totalOiUsd);
        result.sources = sources;

        setCache(cacheKey, result, 30_000);
        return reply.send(result);
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
            response: {
                200: {
                    type: "array",
                    items: { type: "object", additionalProperties: true },
                },
            },
        },
    }, async (req, reply) => {
        const q = req.query as { pair?: string; timeframe?: string; from?: string; to?: string };
        const pair = q.pair ?? "BTC";
        const timeframe = q.timeframe ?? "1m";
        const from = q.from ? parseInt(q.from, 10) : Date.now() - 86_400_000;
        const to = q.to ? parseInt(q.to, 10) : Date.now();

        const cacheKey = `footprint:${pair}:${timeframe}:${Math.floor(from / 1000)}`;
        const cached = getCached<unknown[]>(cacheKey);
        if (cached) return reply.send(cached);

        try {
            const { rows } = await pool.query(
                `SELECT pair, timeframe,
                    (EXTRACT(EPOCH FROM open_time) * 1000)::double precision AS open_time_ms,
                    (EXTRACT(EPOCH FROM close_time) * 1000)::double precision AS close_time_ms,
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
            return reply.send(rows);
        } catch (err) {
            logger.error({ err }, "footprint_query_error");
            return reply.send([]);
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
        if (cached) return reply.send(cached);

        const live = getLiveFootprintCandles();
        setCache("footprint-live", live, 1000);
        return reply.send(live);
    });
};

export default v1Market;
