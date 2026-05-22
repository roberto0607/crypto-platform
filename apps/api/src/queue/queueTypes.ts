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
