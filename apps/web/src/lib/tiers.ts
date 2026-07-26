/**
 * Trade Wars 1v1 ELO tier ladder — canonical frontend mirror of
 * apps/api/src/competitions/eloService.ts's TW_TIERS/PROMOTION_THRESHOLDS.
 * Keep these two in sync if the ELO ladder ever changes.
 */

export const TW_TIERS = ["ROOKIE", "PRO", "ELITE", "LEGEND"] as const;
export type TWTier = (typeof TW_TIERS)[number];

export function isTWTier(s: string): s is TWTier {
    return (TW_TIERS as readonly string[]).includes(s);
}

const TIER_THRESHOLDS: { tier: TWTier; min: number }[] = [
    { tier: "ROOKIE", min: 0 },
    { tier: "PRO", min: 1200 },
    { tier: "ELITE", min: 1500 },
    { tier: "LEGEND", min: 1800 },
];

export interface TierProgress {
    tier: TWTier;
    min: number;
    nextTier: TWTier | null;
    nextMin: number | null;
    progress: number; // 0-100, always 100 at LEGEND
    pointsToNext: number | null; // null at LEGEND
}

/**
 * Progress bar is ELO-only -- promotion also gates on a win-count minimum
 * (eloService.ts's PROMOTION_THRESHOLDS), which this ignores by design
 * (matches ProfilePage.tsx's prior behavior; see Gate 1 tier-badge design
 * doc open question #2).
 */
export function getTierForElo(elo: number): TierProgress {
    const idx = [...TIER_THRESHOLDS].reverse().findIndex((t) => elo >= t.min);
    const current = TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1 - idx]!;
    const next = TIER_THRESHOLDS[TIER_THRESHOLDS.length - idx];
    if (!next) {
        return { tier: current.tier, min: current.min, nextTier: null, nextMin: null, progress: 100, pointsToNext: null };
    }
    const progress = ((elo - current.min) / (next.min - current.min)) * 100;
    return {
        tier: current.tier,
        min: current.min,
        nextTier: next.tier,
        nextMin: next.min,
        progress: Math.max(0, Math.min(100, progress)),
        pointsToNext: next.min - elo,
    };
}

export const TIER_COLORS: Record<TWTier, string> = {
    ROOKIE: "#00ff41",
    PRO: "#3b82f6",
    ELITE: "#a855f7",
    LEGEND: "#FFD700",
};
