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

/** A point at the match start, each candle close, every fill (fee taken) and the match end; both curves share the times. */
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
    /** match_positions: the demo seed's rows; fills: a real match, rebuilt from its trades. */
    source: "match_positions" | "fills";
    match: {
        id: string;
        startedAt: number | null;
        endedAt: number | null;
        startingCapital: number;
        challenger: ReplayPlayer;
        opponent: ReplayPlayer;
    };
    /** Candle size, picked from the match length (1m up to 1h, 5m up to 6h, 1h beyond). */
    candleTimeframe: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
    candles: Record<string, ReplayCandle[]>;
    positions: ReplayPosition[];
    curves: Record<string, ReplayCurvePoint[]>;
}

export function getMatchReplay(matchId: string) {
    return client.get<MatchReplay>(`/v1/matches/${matchId}/replay`);
}
