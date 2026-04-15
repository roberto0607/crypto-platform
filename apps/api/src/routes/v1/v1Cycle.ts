/**
 * v1Cycle.ts — Cycle Intelligence endpoints (Stage 6).
 *
 *   GET  /v1/cycle/analysis   — proxy to cycle-engine FastAPI (5-min cache)
 *   POST /v1/cycle/narrative  — Anthropic Claude 2-3 sentence summary
 *                               (1-hour cache)
 *
 * The Python cycle-engine microservice at CYCLE_ENGINE_URL owns the heavy
 * lifting (CoinGecko fetch, DTW analog matching, Power Law fit, on-chain
 * metric calcs). This router is a thin proxy + LLM narrative wrapper.
 */

import type { FastifyPluginAsync } from "fastify";
import Anthropic from "@anthropic-ai/sdk";

import { config } from "../../config";
import { logger } from "../../observability/logContext";

const ANALYSIS_CACHE_TTL_MS = 5 * 60 * 1000;      // 5 min
const NARRATIVE_CACHE_TTL_MS = 60 * 60 * 1000;    // 1 hour
const CYCLE_ENGINE_TIMEOUT_MS = 30_000;

interface CacheEntry<T> { data: T; expiresAt: number }

let analysisCache: CacheEntry<unknown> | null = null;
let forecastCache: CacheEntry<unknown> | null = null;
let narrativeCache: CacheEntry<{ narrative: string }> | null = null;

async function fetchWithTimeout(url: string, timeoutMs = CYCLE_ENGINE_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

const v1Cycle: FastifyPluginAsync = async (app) => {

    // ── GET /v1/cycle/analysis — proxy to the Python cycle-engine ──
    app.get("/cycle/analysis", {
        schema: {
            tags: ["Cycle"],
            summary: "Bitcoin cycle analysis — phase, Power Law, on-chain metrics, top-3 historical analogs",
            response: {
                200: { type: "object", additionalProperties: true },
                503: { type: "object", additionalProperties: true },
            },
        },
    }, async (_req, reply) => {
        // Serve from cache when fresh
        if (analysisCache && Date.now() < analysisCache.expiresAt) {
            return reply.send(analysisCache.data);
        }

        try {
            const upstream = await fetchWithTimeout(`${config.cycleEngineUrl}/cycle/analysis`);

            // Pass through cycle-engine's 503 "data still loading" so the
            // frontend can show a loading state rather than an error toast.
            if (upstream.status === 503) {
                const body = await upstream.json().catch(() => ({ error: "data loading" }));
                return reply.code(503).send(body);
            }

            if (!upstream.ok) {
                logger.error({ status: upstream.status }, "cycle_engine_non_ok");
                return reply.code(503).send({ error: "cycle engine unavailable" });
            }

            const data = await upstream.json();
            analysisCache = { data, expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS };
            return reply.send(data);
        } catch (err) {
            logger.error({ err }, "cycle_engine_fetch_error");
            return reply.code(503).send({ error: "cycle engine unavailable" });
        }
    });

    // ── GET /v1/cycle/forecast — proxy to cycle-engine forecast ──
    app.get("/cycle/forecast", {
        schema: {
            tags: ["Cycle"],
            summary: "Forward-looking cycle roadmap: estimated bottom, next top, inflection points",
            response: {
                200: { type: "object", additionalProperties: true },
                503: { type: "object", additionalProperties: true },
            },
        },
    }, async (_req, reply) => {
        if (forecastCache && Date.now() < forecastCache.expiresAt) {
            return reply.send(forecastCache.data);
        }

        try {
            const upstream = await fetchWithTimeout(`${config.cycleEngineUrl}/cycle/forecast`);

            if (upstream.status === 503) {
                const body = await upstream.json().catch(() => ({ error: "data loading" }));
                return reply.code(503).send(body);
            }

            if (!upstream.ok) {
                logger.error({ status: upstream.status }, "cycle_engine_forecast_non_ok");
                return reply.code(503).send({ error: "cycle engine unavailable" });
            }

            const data = await upstream.json();
            forecastCache = { data, expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS };
            return reply.send(data);
        } catch (err) {
            logger.error({ err }, "cycle_engine_forecast_fetch_error");
            return reply.code(503).send({ error: "cycle engine unavailable" });
        }
    });

    // ── POST /v1/cycle/narrative — Claude 2-3 sentence summary ──
    app.post("/cycle/narrative", {
        schema: {
            tags: ["Cycle"],
            summary: "AI-generated narrative summarizing the cycle analysis",
            body: {
                type: "object",
                required: ["cycleData"],
                properties: {
                    cycleData: { type: "object", additionalProperties: true },
                },
            },
            response: {
                200: { type: "object", additionalProperties: true },
                400: { type: "object", additionalProperties: true },
                502: { type: "object", additionalProperties: true },
            },
        },
    }, async (req, reply) => {
        // Serve cached narrative (same data → same prompt → same answer)
        if (narrativeCache && Date.now() < narrativeCache.expiresAt) {
            return reply.send(narrativeCache.data);
        }

        if (!config.anthropicApiKey) {
            // Soft-fail — frontend shows the analysis without the AI blurb
            return reply.send({ narrative: null, error: "not configured" });
        }

        const { cycleData } = req.body as { cycleData: unknown };
        if (!cycleData || typeof cycleData !== "object") {
            return reply.code(400).send({ error: "cycleData required" });
        }

        try {
            const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

            const prompt =
                `You are a Bitcoin market analyst. Based on this cycle analysis data, ` +
                `write exactly 2-3 sentences summarizing what the historical analogs suggest ` +
                `about Bitcoin's likely near-term trajectory. Be specific about the analog dates ` +
                `and outcomes. Be factual and measured — avoid hype. End with one sentence about ` +
                `key risk.\n\nData: ${JSON.stringify(cycleData, null, 2)}\n\n` +
                `Write only the narrative, no preamble.`;

            const msg = await anthropic.messages.create({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 400,
                messages: [{ role: "user", content: prompt }],
            });

            // Extract text from the response
            const narrative = msg.content
                .filter((block): block is Anthropic.TextBlock => block.type === "text")
                .map((block) => block.text)
                .join("\n")
                .trim();

            if (!narrative) {
                return reply.code(502).send({ narrative: null, error: "empty response" });
            }

            const result = { narrative };
            narrativeCache = { data: result, expiresAt: Date.now() + NARRATIVE_CACHE_TTL_MS };
            return reply.send(result);
        } catch (err) {
            logger.error({ err }, "anthropic_narrative_error");
            return reply.code(502).send({ narrative: null, error: "llm request failed" });
        }
    });
};

export default v1Cycle;
