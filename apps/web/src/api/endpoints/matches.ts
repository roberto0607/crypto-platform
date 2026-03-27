import client from "../client";

export interface Match {
    id: string;
    season_id: string | null;
    challenger_id: string;
    opponent_id: string;
    status: "PENDING" | "ACTIVE" | "COMPLETED" | "FORFEITED" | "EXPIRED" | "CANCELLED";
    duration_hours: number;
    starting_capital: string;
    challenger_pnl_pct: string | null;
    opponent_pnl_pct: string | null;
    challenger_trades_count: number;
    opponent_trades_count: number;
    challenger_win_rate: string | null;
    opponent_win_rate: string | null;
    challenger_score: string | null;
    opponent_score: string | null;
    winner_id: string | null;
    forfeit_user_id: string | null;
    elo_delta: number | null;
    started_at: string | null;
    ends_at: string | null;
    completed_at: string | null;
    created_at: string;
    challenger_name: string | null;
    challenger_elo: number;
    opponent_name: string | null;
    opponent_elo: number;
    winner_elo_delta: number | null;
    loser_elo_delta: number | null;
}

export function challengeUser(body: {
    opponentId: string;
    durationHours: number;
    allowedPairIds: string[];
}) {
    return client.post<{ ok: true; match: Match }>("/v1/matches/challenge", body);
}

export function acceptMatch(matchId: string) {
    return client.post<{ ok: true; match: Match }>(`/v1/matches/${matchId}/accept`);
}

export function forfeitMatch(matchId: string) {
    return client.post<{ ok: true; match: Match }>(`/v1/matches/${matchId}/forfeit`);
}

export function getActiveMatch() {
    return client.get<{ ok: true; match: Match | null }>("/v1/matches/active");
}

export function cancelActiveMatch() {
    return client.post<{ ok: true; match: Match }>("/v1/matches/active/cancel");
}

export function getMatch(matchId: string) {
    return client.get<{ ok: true; match: Match }>(`/v1/matches/${matchId}`);
}

export function getMatchHistory(params?: { limit?: number; offset?: number }) {
    return client.get<{ ok: true; matches: Match[]; total: number }>(
        "/v1/matches/history",
        { params },
    );
}
