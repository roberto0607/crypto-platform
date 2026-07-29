import client from "../client";

// Post-match trade breakdown — distinct from replay (matchReplay.ts, a P&L
// curve reconstruction). This is a flat, chronological list of each
// participant's match-scoped orders, for full post-match transparency.
// Consumes GET /v1/matches/:id/breakdown.

export interface BreakdownOrder {
    orderId: string;
    pairSymbol: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    qty: string;
    qtyFilled: string;
    avgFillPrice: string | null;
    status: string;
    placedAt: string;
    lastFillAt: string | null;
}

export interface BreakdownPlayer {
    id: string;
    name: string;
}

export interface MatchBreakdown {
    ok: true;
    match: {
        id: string;
        status: string;
        endedAt: string | null;
        challenger: BreakdownPlayer;
        opponent: BreakdownPlayer;
    };
    challengerOrders: BreakdownOrder[];
    opponentOrders: BreakdownOrder[];
}

export function getMatchBreakdown(matchId: string) {
    return client.get<MatchBreakdown>(`/v1/matches/${matchId}/breakdown`);
}
