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
    created_by: string;
    created_at: string;
    updated_at: string;
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
}
