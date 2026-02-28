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
