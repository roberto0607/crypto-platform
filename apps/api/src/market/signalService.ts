/**
 * ML Signal Service — fetches predictions from the Python ML service,
 * stores signals in the database, and publishes SSE events.
 */
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { publish } from "../events/eventBus.js";
import { createEvent } from "../events/eventTypes.js";
import { logger as rootLogger } from "../observability/logContext.js";
import { z } from "zod";

const logger = rootLogger.child({ module: "signalService" });

// Runtime validation for the ML service response. Only fields that flow into
// the DB or are used downstream are strictly validated; peripheral metadata
// (attention, model_contributions) is passthrough to avoid over-fitting the
// schema to the ML service's internal shape.
const MLSignalShape = z.object({
    signal_type: z.enum(["BUY", "SELL"]),
    confidence: z.number(),
    entry_price: z.number(),
    tp1: z.number(),
    tp2: z.number(),
    tp3: z.number(),
    stop_loss: z.number(),
    tp1_prob: z.number(),
    tp2_prob: z.number(),
    tp3_prob: z.number(),
    top_features: z.array(z.unknown()),
    model_version: z.string(),
});

const MLPredictionResponseSchema = z.object({
    signal: MLSignalShape.nullable(),
    regime: z.object({
        regime: z.string(),
        confidence: z.number().optional(),
        config: z
            .object({ strategy: z.string().optional() })
            .passthrough()
            .optional(),
    }).passthrough().optional(),
    forecast: z.record(z.string(), z.unknown()).optional(),
    explanation: z.unknown().optional(),
}).passthrough();

// Cooldown tracking: pairId → last signal timestamp
const cooldowns = new Map<string, number>();

export interface SignalExplanation {
    summary: string;
    reasons: { icon: string; text: string; weight: string }[];
    caution: string | null;
    model_votes: Record<string, string> | null;
    attention_highlight: string | null;
}

export interface MLSignal {
    id: string;
    pairId: string;
    timeframe: string;
    signalType: "BUY" | "SELL";
    confidence: number;
    entryPrice: string;
    tp1Price: string;
    tp2Price: string;
    tp3Price: string;
    stopLossPrice: string;
    tp1Prob: number;
    tp2Prob: number;
    tp3Prob: number;
    modelVersion: string;
    topFeatures: unknown;
    explanation: SignalExplanation | null;
    regimeConfidence?: number;
    regimeStrategy?: string;
    forecast?: Record<string, { p10: number; p50: number; p90: number }>;
    outcome: string;
    createdAt: string;
    expiresAt: string;
}

interface MLPredictionResponse {
    pair: string;
    timeframe: string;
    signal: {
        signal_type: "BUY" | "SELL";
        confidence: number;
        entry_price: number;
        tp1: number;
        tp2: number;
        tp3: number;
        stop_loss: number;
        tp1_prob: number;
        tp2_prob: number;
        tp3_prob: number;
        top_features: unknown[];
        model_version: string;
    } | null;
    prediction: {
        direction: string;
        confidence: number;
        probabilities: Record<string, number>;
    };
    current_price: number;
    atr_14: number;
    model_version: string;
    regime?: {
        regime: string;
        confidence?: number;
        evidence: Record<string, unknown>;
        config: { min_confidence: number; tp_multiplier: number; sl_multiplier: number; strategy?: string };
    };
    forecast?: Record<string, { p10: number; p50: number; p90: number }>;
    model_contributions?: Record<string, { weight: number; direction: string; confidence: number }>;
    attention?: { temporal_attention: unknown[]; feature_importance: unknown[] };
    explanation?: {
        summary: string;
        reasons: { icon: string; text: string; weight: string }[];
        caution: string | null;
        model_votes: Record<string, string> | null;
        attention_highlight: string | null;
    };
}

/**
 * Fetch a prediction from the Python ML service and store if signal generated.
 */
export async function fetchAndStoreSignal(
    pairId: string,
    pairSymbol: string,
    timeframe: string = "1h",
): Promise<MLSignal | null> {
    if (!config.mlPredictionEnabled) return null;

    // Check cooldown
    const lastSignal = cooldowns.get(pairId) ?? 0;
    if (Date.now() - lastSignal < config.mlSignalCooldownMs) {
        return null;
    }

    const urlSymbol = pairSymbol.replace("/", "-");
    const url = `${config.mlServiceUrl}/predict/${urlSymbol}?timeframe=${timeframe}`;

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
        logger.warn({ err: (err as Error).message, url }, "ml_service_unreachable");
        return null;
    }

    if (!response.ok) {
        logger.warn({ status: response.status, url }, "ml_service_error");
        return null;
    }

    const rawJson = await response.json();
    const parsed = MLPredictionResponseSchema.safeParse(rawJson);
    if (!parsed.success) {
        logger.error({ url, issues: parsed.error.issues }, "ml_service_response_invalid");
        return null;
    }
    // Zod passthrough preserves unknown fields at runtime; cast through unknown
    // because the Zod output type only names the fields we explicitly validated.
    const data = parsed.data as unknown as MLPredictionResponse;

    if (!data.signal) {
        return null; // No signal (below confidence or NEUTRAL)
    }

    const sig = data.signal;

    // Check against our own confidence threshold
    if (sig.confidence < config.mlMinConfidence) {
        return null;
    }

    // Check cooldown again (race condition guard)
    const existingRecent = await pool.query<{ id: string }>(
        `SELECT id FROM ml_signals
         WHERE pair_id = $1 AND timeframe = $2 AND outcome = 'pending'
         AND created_at > now() - interval '1 hour'
         ORDER BY created_at DESC LIMIT 1`,
        [pairId, timeframe],
    );
    if (existingRecent.rows.length > 0) {
        return null; // Already have a recent pending signal
    }

    const expiresAt = new Date(Date.now() + config.mlSignalExpiryHours * 3600_000).toISOString();

    const regime = data.regime?.regime ?? null;
    const regimeConfidence = data.regime?.confidence ?? null;
    const regimeStrategy = data.regime?.config?.strategy ?? null;
    const forecast = data.forecast ?? null;
    const explanation = data.explanation ?? null;

    // Store features + explanation together in JSONB
    const topFeaturesJson = JSON.stringify({
        features: sig.top_features,
        explanation,
    });

    const { rows } = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO ml_signals (
            pair_id, timeframe, signal_type, confidence,
            entry_price, tp1_price, tp2_price, tp3_price, stop_loss_price,
            tp1_prob, tp2_prob, tp3_prob,
            model_version, top_features, outcome, expires_at, regime,
            regime_confidence, regime_strategy, forecast
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,$18,$19)
        RETURNING id, created_at`,
        [
            pairId, timeframe, sig.signal_type, sig.confidence,
            String(sig.entry_price), String(sig.tp1), String(sig.tp2), String(sig.tp3), String(sig.stop_loss),
            sig.tp1_prob, sig.tp2_prob, sig.tp3_prob,
            sig.model_version, topFeaturesJson, expiresAt, regime,
            regimeConfidence, regimeStrategy, forecast ? JSON.stringify(forecast) : null,
        ],
    );

    if (!rows || rows.length === 0) {
        logger.error({ pairId, timeframe }, "ml_signal_insert_no_row");
        return null;
    }
    const inserted = rows[0];
    cooldowns.set(pairId, Date.now());

    // Publish SSE event
    try {
        publish(createEvent("signal.new", {
            signalId: inserted.id,
            pairId,
            timeframe,
            signalType: sig.signal_type,
            confidence: sig.confidence,
            entryPrice: String(sig.entry_price),
            tp1: String(sig.tp1),
            tp2: String(sig.tp2),
            tp3: String(sig.tp3),
            stopLoss: String(sig.stop_loss),
            modelVersion: sig.model_version,
        }));
    } catch {
        // Events must never break the flow
    }

    logger.info(
        { signalId: inserted.id, pair: pairSymbol, type: sig.signal_type, confidence: sig.confidence },
        "ml_signal_stored",
    );

    return {
        id: inserted.id,
        pairId,
        timeframe,
        signalType: sig.signal_type,
        confidence: sig.confidence,
        entryPrice: String(sig.entry_price),
        tp1Price: String(sig.tp1),
        tp2Price: String(sig.tp2),
        tp3Price: String(sig.tp3),
        stopLossPrice: String(sig.stop_loss),
        tp1Prob: sig.tp1_prob,
        tp2Prob: sig.tp2_prob,
        tp3Prob: sig.tp3_prob,
        modelVersion: sig.model_version,
        topFeatures: sig.top_features,
        explanation,
        ...(regimeConfidence != null && { regimeConfidence }),
        ...(regimeStrategy != null && { regimeStrategy }),
        ...(forecast != null && { forecast }),
        outcome: "pending",
        createdAt: inserted.created_at,
        expiresAt,
    };
}

/**
 * Extract explanation from stored top_features JSONB.
 * top_features is either: {features: [...], explanation: {...}} (new format)
 * or a plain array (old format, no explanation).
 */
function parseStoredFeatures(raw: unknown): { topFeatures: unknown; explanation: SignalExplanation | null } {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if ("explanation" in obj) {
            return {
                topFeatures: obj.features ?? [],
                explanation: (obj.explanation as SignalExplanation) ?? null,
            };
        }
    }
    return { topFeatures: raw, explanation: null };
}

/**
 * Get active (pending) signal for a pair.
 */
export async function getActiveSignal(
    pairId: string,
    timeframe: string,
): Promise<MLSignal | null> {
    const { rows } = await pool.query<{
        id: string; pair_id: string; timeframe: string; signal_type: string;
        confidence: string; entry_price: string; tp1_price: string; tp2_price: string;
        tp3_price: string; stop_loss_price: string; tp1_prob: string; tp2_prob: string;
        tp3_prob: string; model_version: string; top_features: unknown;
        outcome: string; created_at: string; expires_at: string;
        tp1_hit_at: string | null; tp2_hit_at: string | null; tp3_hit_at: string | null;
        sl_hit_at: string | null;
    }>(
        `SELECT * FROM ml_signals
         WHERE pair_id = $1 AND timeframe = $2 AND outcome = 'pending'
         AND expires_at > now()
         ORDER BY created_at DESC LIMIT 1`,
        [pairId, timeframe],
    );

    if (rows.length === 0) return null;

    const r = rows[0]! as typeof rows[0] & {
        regime_confidence?: string | null;
        regime_strategy?: string | null;
        forecast?: Record<string, { p10: number; p50: number; p90: number }> | null;
    };
    const { topFeatures, explanation } = parseStoredFeatures(r.top_features);
    return {
        id: r.id,
        pairId: r.pair_id,
        timeframe: r.timeframe,
        signalType: r.signal_type as "BUY" | "SELL",
        confidence: Number(r.confidence),
        entryPrice: r.entry_price,
        tp1Price: r.tp1_price,
        tp2Price: r.tp2_price,
        tp3Price: r.tp3_price,
        stopLossPrice: r.stop_loss_price,
        tp1Prob: Number(r.tp1_prob),
        tp2Prob: Number(r.tp2_prob),
        tp3Prob: Number(r.tp3_prob),
        modelVersion: r.model_version,
        topFeatures,
        explanation,
        ...(r.regime_confidence != null && { regimeConfidence: Number(r.regime_confidence) }),
        ...(r.regime_strategy != null && { regimeStrategy: r.regime_strategy }),
        ...(r.forecast != null && { forecast: r.forecast }),
        outcome: r.outcome,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
    };
}

/**
 * Get recent signal history for a pair.
 */
export async function getSignalHistory(
    pairId: string,
    timeframe: string,
    limit: number = 20,
): Promise<MLSignal[]> {
    const { rows } = await pool.query(
        `SELECT * FROM ml_signals
         WHERE pair_id = $1 AND timeframe = $2
         ORDER BY created_at DESC LIMIT $3`,
        [pairId, timeframe, limit],
    );

    return rows.map((r: any) => {
        const { topFeatures, explanation } = parseStoredFeatures(r.top_features);
        return {
            id: r.id,
            pairId: r.pair_id,
            timeframe: r.timeframe,
            signalType: r.signal_type,
            confidence: Number(r.confidence),
            entryPrice: r.entry_price,
            tp1Price: r.tp1_price,
            tp2Price: r.tp2_price,
            tp3Price: r.tp3_price,
            stopLossPrice: r.stop_loss_price,
            tp1Prob: Number(r.tp1_prob),
            tp2Prob: Number(r.tp2_prob),
            tp3Prob: Number(r.tp3_prob),
            modelVersion: r.model_version,
            topFeatures,
            explanation,
            ...(r.regime_confidence != null && { regimeConfidence: Number(r.regime_confidence) }),
            ...(r.regime_strategy != null && { regimeStrategy: r.regime_strategy }),
            ...(r.forecast != null && { forecast: r.forecast }),
            outcome: r.outcome,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
        };
    });
}

/**
 * Compute equity curve from signal history — cumulative P&L over time.
 */
export async function getEquityCurve(): Promise<{
    curve: { ts: string; cumPnlPct: number; signalId: string }[];
    totalReturn: number;
    maxDrawdown: number;
    sharpe: number;
    totalSignals: number;
    winRate: number;
}> {
    const { rows } = await pool.query<{
        id: string;
        signal_type: string;
        entry_price: string;
        tp1_price: string;
        tp2_price: string;
        tp3_price: string;
        stop_loss_price: string;
        outcome: string;
        closed_at: string;
    }>(
        `SELECT id, signal_type, entry_price, tp1_price, tp2_price, tp3_price,
                stop_loss_price, outcome, closed_at
         FROM ml_signals
         WHERE outcome != 'pending'
         ORDER BY COALESCE(closed_at, created_at) ASC`,
    );

    const curve: { ts: string; cumPnlPct: number; signalId: string }[] = [];
    let cumPnl = 0;
    let peak = 0;
    let maxDrawdown = 0;
    let wins = 0;
    const returns: number[] = [];

    for (const r of rows) {
        const entry = parseFloat(r.entry_price);
        if (!entry) continue;

        let pnl = 0;
        const isBuy = r.signal_type === "BUY";

        switch (r.outcome) {
            case "tp1":
                pnl = (parseFloat(r.tp1_price) - entry) / entry;
                break;
            case "tp2":
                pnl = (parseFloat(r.tp2_price) - entry) / entry;
                break;
            case "tp3":
                pnl = (parseFloat(r.tp3_price) - entry) / entry;
                break;
            case "sl":
                pnl = (parseFloat(r.stop_loss_price) - entry) / entry;
                break;
            case "expired":
                pnl = 0;
                break;
            default:
                continue;
        }

        // Flip sign for SELL signals
        if (!isBuy) pnl = -pnl;

        if (r.outcome === "tp1" || r.outcome === "tp2" || r.outcome === "tp3") {
            wins++;
        }

        cumPnl += pnl * 100; // Convert to percentage
        returns.push(pnl);

        // Track drawdown
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak - cumPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;

        curve.push({
            ts: r.closed_at,
            cumPnlPct: Math.round(cumPnl * 100) / 100,
            signalId: r.id,
        });
    }

    // Compute Sharpe ratio (annualized, assuming 1h signals)
    let sharpe = 0;
    if (returns.length > 1) {
        const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
        const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
        const std = Math.sqrt(variance);
        if (std > 0) {
            // Annualize: sqrt(8760) for hourly signals
            sharpe = (mean / std) * Math.sqrt(8760);
        }
    }

    const decided = rows.filter((r) => ["tp1", "tp2", "tp3", "sl"].includes(r.outcome)).length;

    return {
        curve,
        totalReturn: Math.round(cumPnl * 100) / 100,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        sharpe: Math.round(sharpe * 100) / 100,
        totalSignals: rows.length,
        winRate: decided > 0 ? Math.round((wins / decided) * 1000) / 1000 : 0,
    };
}

/**
 * Get aggregate performance metrics.
 */
export async function getSignalPerformance(pairId: string, timeframe: string): Promise<{
    totalSignals: number;
    winRate: number;
    tp1HitRate: number;
    tp2HitRate: number;
    tp3HitRate: number;
    avgConfidence: number;
}> {
    const { rows } = await pool.query<{
        total: string;
        tp1_hits: string;
        tp2_hits: string;
        tp3_hits: string;
        sl_hits: string;
        avg_confidence: string;
    }>(
        `SELECT
            COUNT(*) as total,
            COUNT(tp1_hit_at) as tp1_hits,
            COUNT(tp2_hit_at) as tp2_hits,
            COUNT(tp3_hit_at) as tp3_hits,
            COUNT(sl_hit_at) as sl_hits,
            COALESCE(AVG(confidence), 0) as avg_confidence
         FROM ml_signals
         WHERE pair_id = $1 AND timeframe = $2 AND outcome != 'pending'`,
        [pairId, timeframe],
    );

    const r = rows[0]!;
    const total = Number(r.total);
    const tp1Hits = Number(r.tp1_hits);
    const slHits = Number(r.sl_hits);
    const decided = tp1Hits + slHits;

    return {
        totalSignals: total,
        winRate: decided > 0 ? Math.round((tp1Hits / decided) * 100) / 100 : 0,
        tp1HitRate: total > 0 ? Math.round((tp1Hits / total) * 100) / 100 : 0,
        tp2HitRate: total > 0 ? Math.round((Number(r.tp2_hits) / total) * 100) / 100 : 0,
        tp3HitRate: total > 0 ? Math.round((Number(r.tp3_hits) / total) * 100) / 100 : 0,
        avgConfidence: Math.round(Number(r.avg_confidence) * 10) / 10,
    };
}
