import type { PlaceOrderResult } from "../trading/phase6OrderService";

export interface QueueJob {
  requestId: string;
  userId: string;
  pairId: string;
  payload: {
    pairId: string;
    side: "BUY" | "SELL";
    type: "MARKET" | "LIMIT";
    qty: string;
    limitPrice?: string;
    // Requested leverage (a JSON number, so it survives the Redis queue's
    // JSON round trip as-is). Omitted = 1x / the leverage already in force.
    leverage?: number;
    // Only shrink the position (a JSON boolean: survives the round trip).
    reduceOnly?: boolean;
  };
  idempotencyKey?: string;
  competitionId?: string;
  // Resolved at the HTTP edge (routes/tradingRoutes.ts) from the user's
  // active match at the moment the order was placed: a real match UUID, or
  // null for free-play. The dequeue path trusts this value and never
  // re-resolves — so if the match ends while the job is queued, the fill
  // still attributes to the match that was active when the order was placed.
  matchId: string | null;
  enqueuedAt: number;
  resolve: (result: PlaceOrderResult) => void;
  reject: (err: Error) => void;
}

export interface PairQueue {
  jobs: QueueJob[];
  running: boolean;
}

export interface QueueStats {
  pairId: string;
  depth: number;
  running: boolean;
  oldestAgeMs: number | null;
}
