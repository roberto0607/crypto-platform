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
  // Captured at enqueue time from the user's then-current active match.
  // The dequeue path trusts this value rather than re-resolving via
  // getActiveMatchIdForUser so that if the match ended while the job was
  // queued, the position attributes to the match that was active when
  // the order was placed.
  matchId?: string | null;
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
