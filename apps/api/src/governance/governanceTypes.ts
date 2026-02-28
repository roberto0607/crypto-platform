export interface AccountLimitRow {
  user_id: string;
  max_daily_notional_quote: string | null;
  max_daily_realized_loss_quote: string | null;
  max_open_positions: number | null;
  max_open_orders: number | null;
  account_status: string;
  created_at: string;
  updated_at: string;
}

export interface GovernanceCheckInput {
  userId: string;
  pairId: string;
  side: "BUY" | "SELL";
  qty: string;
  estimatedNotional: string;
  snapshotTs: string;
}

export interface GovernanceDecision {
  ok: boolean;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export const GOVERNANCE_CODES = {
  PASS: "PASS",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  DAILY_NOTIONAL_LIMIT_EXCEEDED: "DAILY_NOTIONAL_LIMIT_EXCEEDED",
  DAILY_LOSS_LIMIT_EXCEEDED: "DAILY_LOSS_LIMIT_EXCEEDED",
  MAX_OPEN_POSITIONS_EXCEEDED: "MAX_OPEN_POSITIONS_EXCEEDED",
  MAX_OPEN_ORDERS_EXCEEDED: "MAX_OPEN_ORDERS_EXCEEDED",
} as const;
