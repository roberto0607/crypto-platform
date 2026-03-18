/**
 * weightAdjuster.ts — Blends base weights with learned weights from DB.
 *
 * Weight formula (when sample_size >= 20):
 *   finalWeight = baseWeight × 0.4 + learnedWeight × 0.6
 *
 * Applies 5% momentum damping to prevent oscillation:
 *   dampedWeight = prevWeight × 0.95 + newWeight × 0.05
 *
 * Falls back to base weights when insufficient data.
 */

import { pool } from "../db/pool";

export interface WeightConfig {
    basis: number;
    orderBook: number;
    macro: number;
    gamma: number;
    onChain: number;
}

const BASE_WEIGHTS: WeightConfig = {
    basis: 0.25,
    orderBook: 0.25,
    macro: 0.15,
    gamma: 0.15,
    onChain: 0.20,
};

const MIN_SAMPLE_SIZE = 20;

// In-memory cache of last emitted weights for damping
const prevWeights: Record<string, WeightConfig> = {};

function normalize(w: WeightConfig): WeightConfig {
    const sum = w.basis + w.orderBook + w.macro + w.gamma + w.onChain;
    if (sum === 0) return { ...BASE_WEIGHTS };
    return {
        basis: w.basis / sum,
        orderBook: w.orderBook / sum,
        macro: w.macro / sum,
        gamma: w.gamma / sum,
        onChain: w.onChain / sum,
    };
}

export async function getLearnedWeights(regime: string): Promise<{
    weights: WeightConfig;
    source: "learned" | "base";
    sampleSize: number;
}> {
    try {
        const { rows } = await pool.query(
            `SELECT stream_name, learned_weight, sample_size
             FROM stream_performance
             WHERE regime = $1`,
            [regime],
        );

        if (rows.length === 0) {
            return { weights: { ...BASE_WEIGHTS }, source: "base", sampleSize: 0 };
        }

        // Map DB stream names to WeightConfig keys
        const streamMap: Record<string, keyof WeightConfig> = {
            basis: "basis",
            orderbook: "orderBook",
            macro: "macro",
            gamma: "gamma",
            onchain: "onChain",
        };

        let minSample = Infinity;
        const learnedRaw: Partial<WeightConfig> = {};

        for (const row of rows) {
            const key = streamMap[row.stream_name];
            if (!key) continue;
            learnedRaw[key] = parseFloat(row.learned_weight);
            minSample = Math.min(minSample, parseInt(row.sample_size, 10));
        }

        if (minSample < MIN_SAMPLE_SIZE) {
            return {
                weights: { ...BASE_WEIGHTS },
                source: "base",
                sampleSize: minSample === Infinity ? 0 : minSample,
            };
        }

        // Blend: 40% base + 60% learned
        const blended: WeightConfig = {
            basis: BASE_WEIGHTS.basis * 0.4 + (learnedRaw.basis ?? BASE_WEIGHTS.basis) * 0.6,
            orderBook: BASE_WEIGHTS.orderBook * 0.4 + (learnedRaw.orderBook ?? BASE_WEIGHTS.orderBook) * 0.6,
            macro: BASE_WEIGHTS.macro * 0.4 + (learnedRaw.macro ?? BASE_WEIGHTS.macro) * 0.6,
            gamma: BASE_WEIGHTS.gamma * 0.4 + (learnedRaw.gamma ?? BASE_WEIGHTS.gamma) * 0.6,
            onChain: BASE_WEIGHTS.onChain * 0.4 + (learnedRaw.onChain ?? BASE_WEIGHTS.onChain) * 0.6,
        };

        // Apply momentum damping if we have previous weights for this regime
        const prev = prevWeights[regime];
        let final: WeightConfig;
        if (prev) {
            final = {
                basis: prev.basis * 0.95 + blended.basis * 0.05,
                orderBook: prev.orderBook * 0.95 + blended.orderBook * 0.05,
                macro: prev.macro * 0.95 + blended.macro * 0.05,
                gamma: prev.gamma * 0.95 + blended.gamma * 0.05,
                onChain: prev.onChain * 0.95 + blended.onChain * 0.05,
            };
        } else {
            final = blended;
        }

        // Normalize to sum to 1.0
        final = normalize(final);

        // Cache for next damping cycle
        prevWeights[regime] = { ...final };

        return {
            weights: final,
            source: "learned",
            sampleSize: minSample,
        };
    } catch (err) {
        console.warn("[WeightAdjuster] Error:", (err as Error).message);
        return { weights: { ...BASE_WEIGHTS }, source: "base", sampleSize: 0 };
    }
}

export function getBaseWeights(): WeightConfig {
    return { ...BASE_WEIGHTS };
}
