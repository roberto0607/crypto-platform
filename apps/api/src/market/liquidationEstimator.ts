/**
 * liquidationEstimator.ts — estimated liquidation clusters.
 *
 * DISCLAIMER: these values are mathematical estimates, not real exchange data.
 * Method: sample last 24h of hourly candle opens as proxy entry prices for
 * leveraged positions; for each entry compute long/short liq prices at
 * 10x/25x/50x/100x; bucket into $10 price slots; sum estimated USD exposure
 * per bucket; normalize intensity 0–1; return top 20 clusters (10 above
 * current price, 10 below).
 */

import { pool } from "../db/pool.js";
import { logger } from "../observability/logContext.js";

export interface LiquidationCluster {
    price: number;
    side: "long" | "short";
    estimatedUSD: number;
    leverage: number;
    intensity: number; // 0..1 normalized across returned clusters
}

export interface LiquidationLevelsResponse {
    disclaimer: "estimated";
    currentPrice: number;
    calculatedAt: string;
    clusters: LiquidationCluster[];
    sources: string[];
}

const LEVERAGE_TIERS = [10, 25, 50, 100];
// Usage-weight distribution — mirrors common crypto exchange patterns.
// Sum to 1.0 so total estimated exposure = inputOpenInterestUsd.
const LEVERAGE_WEIGHTS: Record<number, number> = {
    10: 0.30,
    25: 0.35,
    50: 0.25,
    100: 0.10,
};
const BUCKET_SIZE = 10; // $10 buckets, matches footprint
const TOP_PER_SIDE = 10;

interface EntryCandle {
    open: number;
    openTime: number; // ms
}

async function fetchLast24hHourlyOpens(pairSymbol: string): Promise<EntryCandle[]> {
    try {
        const { rows } = await pool.query<{ open: string; open_time: string }>(
            `SELECT open, open_time
             FROM candles c
             JOIN trading_pairs p ON p.id = c.pair_id
             WHERE p.symbol = $1
               AND c.timeframe = '1h'
               AND c.open_time >= NOW() - INTERVAL '24 hours'
             ORDER BY c.open_time ASC`,
            [pairSymbol],
        );
        return rows.map((r) => ({
            open: parseFloat(r.open),
            openTime: new Date(r.open_time).getTime(),
        }));
    } catch (err) {
        logger.error({ err, pairSymbol }, "liq_estimator_candles_fetch_error");
        return [];
    }
}

export async function estimateLiquidationClusters(
    pairSymbol: string,
    currentPrice: number,
    openInterestUsd: number,
): Promise<LiquidationLevelsResponse> {
    const calculatedAt = new Date().toISOString();
    if (currentPrice <= 0 || openInterestUsd <= 0) {
        return { disclaimer: "estimated", currentPrice, calculatedAt, clusters: [], sources: [] };
    }

    const entries = await fetchLast24hHourlyOpens(pairSymbol);
    if (entries.length === 0) {
        return { disclaimer: "estimated", currentPrice, calculatedAt, clusters: [], sources: [] };
    }

    // Per-entry USD exposure: split total OI equally across the sample set,
    // then split each entry's share across leverage tiers by weight, then
    // split half/half between long and short side.
    const perEntryUsd = openInterestUsd / entries.length;

    type BucketKey = string; // `${side}|${leverage}|${priceBucket}`
    const buckets = new Map<BucketKey, { price: number; side: "long" | "short"; leverage: number; usd: number }>();

    for (const entry of entries) {
        for (const leverage of LEVERAGE_TIERS) {
            const weight = LEVERAGE_WEIGHTS[leverage] ?? 0;
            if (weight <= 0) continue;
            const usdAtTier = perEntryUsd * weight * 0.5; // half longs / half shorts

            const longLiq = entry.open * (1 - 1 / leverage);
            const shortLiq = entry.open * (1 + 1 / leverage);

            for (const { price, side } of [
                { price: longLiq, side: "long" as const },
                { price: shortLiq, side: "short" as const },
            ]) {
                const bucketPrice = Math.floor(price / BUCKET_SIZE) * BUCKET_SIZE;
                const key = `${side}|${leverage}|${bucketPrice}`;
                const existing = buckets.get(key);
                if (existing) {
                    existing.usd += usdAtTier;
                } else {
                    buckets.set(key, { price: bucketPrice, side, leverage, usd: usdAtTier });
                }
            }
        }
    }

    const all = Array.from(buckets.values());
    if (all.length === 0) {
        return { disclaimer: "estimated", currentPrice, calculatedAt, clusters: [], sources: [] };
    }

    // Filter to the correct side of current price only.
    // Long liqs should sit BELOW current; short liqs ABOVE. Drop outliers.
    const relevant = all.filter((c) =>
        (c.side === "long" && c.price < currentPrice) ||
        (c.side === "short" && c.price > currentPrice),
    );

    // Normalize intensity 0..1 using max USD in the relevant set.
    const maxUsd = relevant.reduce((m, c) => (c.usd > m ? c.usd : m), 0);

    const longs = relevant
        .filter((c) => c.side === "long")
        .sort((a, b) => b.price - a.price) // closest to current price first
        .slice(0, TOP_PER_SIDE);
    const shorts = relevant
        .filter((c) => c.side === "short")
        .sort((a, b) => a.price - b.price) // closest to current price first
        .slice(0, TOP_PER_SIDE);

    const clusters: LiquidationCluster[] = [...longs, ...shorts].map((c) => ({
        price: c.price,
        side: c.side,
        estimatedUSD: Math.round(c.usd),
        leverage: c.leverage,
        intensity: maxUsd > 0 ? Math.min(1, c.usd / maxUsd) : 0,
    }));

    return { disclaimer: "estimated", currentPrice, calculatedAt, clusters, sources: [] };
}
