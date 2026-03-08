import client from "../client";

// Types
export interface Competition {
    id: string;
    name: string;
    description: string | null;
    start_at: string;
    end_at: string;
    starting_balance_usd: string;
    status: "UPCOMING" | "ACTIVE" | "ENDED" | "CANCELLED";
    max_participants: number | null;
    pairs_allowed: "all" | string[];
    created_by: string | null;
    created_at: string;
    competition_type?: "CUSTOM" | "WEEKLY";
    tier?: string | null;
    week_id?: string | null;
}

export interface LeaderboardEntry {
    competition_id: string;
    user_id: string;
    rank: number;
    equity: string;
    return_pct: string;
    max_drawdown_pct: string;
    current_drawdown_pct: string;
    trades_count: number;
    display_name: string;
    updated_at: string;
    user_tier?: string;
    qualified?: boolean;
    has_champion_badge?: boolean;
}

export interface Badge {
    id: string;
    badge_type: string;
    tier: string;
    week_id: string;
    competition_id: string;
    earned_at: string;
}

export interface TierHistoryEntry {
    old_tier: string;
    new_tier: string;
    reason: string;
    week_id: string | null;
    created_at: string;
}

export interface UserCompetition {
    id: string;
    competition_id: string;
    user_id: string;
    status: string;
    competition_name: string;
    competition_status: string;
    start_at: string;
    end_at: string;
    starting_equity: string;
    final_rank: number | null;
    final_return_pct: string | null;
}

export function listCompetitions(params?: { status?: string; competition_type?: string; tier?: string; limit?: number; offset?: number }) {
    return client.get<{ ok: true; competitions: Competition[]; total: number }>(
        "/v1/competitions",
        { params },
    );
}

export function getCompetition(id: string) {
    return client.get<{ ok: true; competition: Competition }>(`/v1/competitions/${id}`);
}

export function getLeaderboard(id: string, params?: { limit?: number; offset?: number }) {
    return client.get<{ ok: true; leaderboard: LeaderboardEntry[] }>(
        `/v1/competitions/${id}/leaderboard`,
        { params },
    );
}

export function joinCompetition(id: string) {
    return client.post<{ ok: true }>(`/v1/competitions/${id}/join`);
}

export function withdrawFromCompetition(id: string) {
    return client.post<{ ok: true }>(`/v1/competitions/${id}/withdraw`);
}

export function listMyCompetitions() {
    return client.get<{ ok: true; competitions: UserCompetition[] }>(
        "/v1/competitions/me",
    );
}

export interface EquitySnapshot {
    ts: number;
    equity_quote: string;
    cash_quote?: string;
    holdings_quote?: string;
}

export interface ComparisonParticipant {
    label: string;
    rank: number | null;
    displayName?: string;
    snapshots: Array<{ ts: number; equity: string }>;
}

export function getCompetitionEquityCurve(competitionId: string, limit?: number) {
    return client.get<{ ok: true; snapshots: EquitySnapshot[] }>(
        `/v1/competitions/${competitionId}/equity-curve`,
        { params: { limit } },
    );
}

export function getCompetitionComparison(competitionId: string, topN?: number) {
    return client.get<{ ok: true; participants: ComparisonParticipant[] }>(
        `/v1/competitions/${competitionId}/comparison`,
        { params: { topN } },
    );
}

// Admin
export function createCompetition(body: {
    name: string;
    description?: string;
    startAt: string;
    endAt: string;
    startingBalanceUsd?: string;
    maxParticipants?: number;
    pairsAllowed?: "all" | string[];
}) {
    return client.post<{ ok: true; competition: Competition }>(
        "/v1/admin/competitions",
        body,
    );
}

export function cancelCompetition(id: string) {
    return client.patch<{ ok: true }>(`/v1/admin/competitions/${id}/cancel`);
}

// Weekly competitions
export function getCurrentWeeklyCompetition() {
    return client.get<{ ok: true; competition: Competition | null; joined: boolean; tier: string }>(
        "/v1/competitions/weekly/current",
    );
}

// Tier & badges
export function getUserTier() {
    return client.get<{ ok: true; tier: string; history: TierHistoryEntry[] }>(
        "/v1/profile/tier",
    );
}

export function getUserBadges() {
    return client.get<{ ok: true; badges: Badge[] }>(
        "/v1/profile/badges",
    );
}
