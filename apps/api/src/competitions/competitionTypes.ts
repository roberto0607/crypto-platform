// ── Tier system ──

export const TIERS = ["ROOKIE", "TRADER", "SPECIALIST", "EXPERT", "MASTER", "LEGEND"] as const;
export type TierName = (typeof TIERS)[number];

export const TIER_ORDER: Record<TierName, number> = {
    ROOKIE: 0,
    TRADER: 1,
    SPECIALIST: 2,
    EXPERT: 3,
    MASTER: 4,
    LEGEND: 5,
};

export const WEEKLY_MIN_TRADES = 5;

// ── Competition ──

export interface CompetitionRow {
    id: string;
    name: string;
    description: string | null;
    start_at: string;
    end_at: string;
    starting_balance_usd: string;
    status: "UPCOMING" | "ACTIVE" | "ENDED" | "CANCELLED";
    max_participants: number | null;
    pairs_allowed: "all" | string[];  // JSONB
    created_by: string | null;
    created_at: string;
    updated_at: string;
    competition_type: "CUSTOM" | "WEEKLY";
    tier: TierName | null;
    week_id: string | null;
    tier_adjustments_processed: boolean;
}

export interface ParticipantRow {
    id: string;
    competition_id: string;
    user_id: string;
    joined_at: string;
    starting_equity: string;
    final_equity: string | null;
    final_return_pct: string | null;
    final_max_drawdown_pct: string | null;
    final_rank: number | null;
    status: "ACTIVE" | "DISQUALIFIED" | "WITHDRAWN";
    qualified: boolean;
}

export interface LeaderboardRow {
    competition_id: string;
    user_id: string;
    rank: number;
    equity: string;
    return_pct: string;
    max_drawdown_pct: string;
    current_drawdown_pct: string;
    trades_count: number;
    updated_at: string;
    display_name?: string | null;  // from JOIN
    user_tier?: TierName;          // from JOIN
    qualified?: boolean;           // from JOIN
    has_champion_badge?: boolean;  // from JOIN
}

// ── Tiers ──

export interface TierRow {
    user_id: string;
    tier: TierName;
    updated_at: string;
}

export interface TierHistoryRow {
    id: string;
    user_id: string;
    old_tier: string;
    new_tier: string;
    reason: string;
    competition_id: string | null;
    week_id: string | null;
    created_at: string;
}

// ── Badges ──

export interface BadgeRow {
    id: string;
    user_id: string;
    badge_type: string;
    tier: string;
    week_id: string;
    competition_id: string;
    metadata: Record<string, unknown>;
    earned_at: string;
}
