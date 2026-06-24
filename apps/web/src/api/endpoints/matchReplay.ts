import client from "../client";

// Stage 6 Post-Match Replay — distinct from the solo-practice /replay subsystem
// (see replay.ts). Consumes GET /v1/matches/:id/replay.

export interface ReplayCandle {
    ts: number; // epoch ms
    o: number;
    h: number;
    l: number;
    c: number;
}

export interface ReplayPosition {
    userId: string;
    pairSymbol: string;
    side: "LONG" | "SHORT";
    entryPrice: number;
    qty: number;
    exitPrice: number | null;
    openedAt: number;
    closedAt: number | null;
    pnl: number;
}

export interface ReplayCurvePoint {
    ts: number;
    equity: number;
    pnlPct: number;
    realizedPnl: number;
    unrealizedPnl: number;
}

export interface ReplayPlayer {
    id: string;
    name: string;
    finalPnlPct: number | null;
}

export interface MatchReplay {
    ok: true;
    source: "match_positions";
    match: {
        id: string;
        startedAt: number | null;
        endedAt: number | null;
        startingCapital: number;
        challenger: ReplayPlayer;
        opponent: ReplayPlayer;
    };
    candles: Record<string, ReplayCandle[]>;
    positions: ReplayPosition[];
    curves: Record<string, ReplayCurvePoint[]>;
}

export function getMatchReplay(matchId: string) {
    return client.get<MatchReplay>(`/v1/matches/${matchId}/replay`);
}
