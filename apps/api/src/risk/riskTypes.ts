export interface RiskLimitRow {
  id: string;
  user_id: string | null;
  pair_id: string | null;
  max_order_notional_quote: string | null;
  max_position_base_qty: string | null;
  max_open_orders_per_pair: number | null;
  max_price_deviation_bps: number | null;
  created_at: string;
  updated_at: string;
}

export interface EffectiveRiskLimits {
  max_order_notional_quote: string;
  max_position_base_qty: string;
  max_open_orders_per_pair: number;
  max_price_deviation_bps: number;
}

export interface RiskDecision {
  ok: boolean;
  code: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface RiskCheckInput {
  userId: string;
  pairId: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  qty: string;
  limitPrice?: string;
  snapshot: {
    bid: string | null;
    ask: string | null;
    last: string;
    ts: string;
    source: string;
  };
}

export type BreakerStatus = "OPEN" | "CLOSED";

export interface CircuitBreakerRow {
  id: string;
  breaker_key: string;
  status: BreakerStatus;
  opened_at: string | null;
  closes_at: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const RISK_CODES = {
  PASS: "PASS",
  MAX_NOTIONAL_EXCEEDED: "MAX_NOTIONAL_EXCEEDED",
  PRICE_DEVIATION_EXCEEDED: "PRICE_DEVIATION_EXCEEDED",
  MAX_OPEN_ORDERS_EXCEEDED: "MAX_OPEN_ORDERS_EXCEEDED",
  MAX_POSITION_EXCEEDED: "MAX_POSITION_EXCEEDED",
  BREAKER_OPEN: "BREAKER_OPEN",
  INVALID_QTY: "INVALID_QTY",
} as const;
