// ── Primitives ──────────────────────────────────────────────
export type DecimalString = string;
export type UUID = string;
export type ISODateString = string;
export type EpochMs = number;

// ── Auth ────────────────────────────────────────────────────
export interface User {
  id: UUID;
  email: string;
  role: "USER" | "ADMIN";
}

export interface LoginResponse {
  ok: true;
  accessToken: string;
  user: User;
}

export interface RegisterResponse {
  ok: true;
  user: User;
}

export interface RefreshResponse {
  ok: true;
  accessToken: string;
}

export interface MeResponse {
  ok: true;
  user: { id: UUID; role: string };
}

// ── Assets & Wallets ────────────────────────────────────────
export interface Asset {
  id: UUID;
  symbol: string;
  name: string;
  decimals: number;
  is_active: boolean;
  created_at: ISODateString;
}

export interface Wallet {
  id: UUID;
  user_id: UUID;
  asset_id: UUID;
  balance: DecimalString;
  reserved: DecimalString;
  symbol?: string;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface LedgerEntry {
  id: UUID;
  wallet_id: UUID;
  entry_type:
    | "CREDIT"
    | "DEBIT"
    | "RESERVE"
    | "RELEASE"
    | "TRADE_DEBIT"
    | "TRADE_CREDIT"
    | "FEE";
  amount: DecimalString;
  balance_after: DecimalString;
  reference_id: UUID | null;
  reference_type: string | null;
  metadata: Record<string, unknown>;
  created_at: ISODateString;
}

// ── Trading ─────────────────────────────────────────────────
export interface TradingPair {
  id: UUID;
  symbol: string;
  base_asset_id: UUID;
  quote_asset_id: UUID;
  is_active: boolean;
  last_price: DecimalString | null;
  fee_bps: number;
  maker_fee_bps: number;
  taker_fee_bps: number;
  trading_enabled: boolean;
  created_at: ISODateString;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type OrderStatus = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";

export interface Order {
  id: UUID;
  user_id: UUID;
  pair_id: UUID;
  side: OrderSide;
  type: OrderType;
  qty: DecimalString;
  qty_filled: DecimalString;
  limit_price: DecimalString | null;
  status: OrderStatus;
  reserved_amount: DecimalString;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface Trade {
  id: UUID;
  pair_id: UUID;
  buy_order_id: UUID;
  sell_order_id: UUID;
  price: DecimalString;
  qty: DecimalString;
  quote_amount: DecimalString;
  fee_amount: DecimalString;
  executed_at: ISODateString;
}

export interface Fill {
  id: UUID;
  price: DecimalString;
  qty: DecimalString;
  quote_amount: DecimalString;
}

export interface OrderBookLevel {
  price: DecimalString;
  qty: DecimalString;
  count: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

// ── Market ──────────────────────────────────────────────────
export interface Snapshot {
  bid: string | null;
  ask: string | null;
  last: string;
  ts: string;
  source: "live" | "replay" | "fallback";
}

// ── Positions & PnL ────────────────────────────────────────
export interface Position {
  user_id: UUID;
  pair_id: UUID;
  base_qty: DecimalString;
  avg_entry_price: DecimalString;
  realized_pnl_quote: DecimalString;
  fees_paid_quote: DecimalString;
  unrealized_pnl_quote: DecimalString;
  current_price: DecimalString;
  updated_at: ISODateString;
}

export interface PnlSummary {
  total_realized_pnl: DecimalString;
  total_unrealized_pnl: DecimalString;
  total_fees_paid: DecimalString;
  net_pnl: DecimalString;
}

// ── Portfolio ───────────────────────────────────────────────
export interface PortfolioSummary {
  cash_quote: DecimalString;
  holdings_quote: DecimalString;
  equity_quote: DecimalString;
  realized_pnl_quote: DecimalString;
  unrealized_pnl_quote: DecimalString;
  fees_paid_quote: DecimalString;
  net_pnl_quote: DecimalString;
}

export interface PortfolioSnapshot {
  ts: string;
  equity_quote: DecimalString;
  cash_quote: DecimalString | null;
  holdings_quote: DecimalString | null;
  unrealized_pnl_quote: DecimalString | null;
  realized_pnl_quote: DecimalString | null;
  fees_paid_quote: DecimalString | null;
}

export interface DrawdownPoint {
  ts: string;
  drawdown_pct: DecimalString;
  equity_quote: DecimalString;
  peak_quote: DecimalString;
}

export interface PerformanceSummary {
  total_return_pct: DecimalString;
  max_drawdown_pct: DecimalString;
  current_drawdown_pct: DecimalString;
  equity_start: DecimalString;
  equity_end: DecimalString;
  data_points: number;
  drawdown_series: DrawdownPoint[];
}

// ── Triggers ────────────────────────────────────────────────
export type TriggerKind =
  | "STOP_MARKET"
  | "STOP_LIMIT"
  | "TAKE_PROFIT_MARKET"
  | "TAKE_PROFIT_LIMIT";

export type TriggerStatus =
  | "ACTIVE"
  | "TRIGGERED"
  | "CANCELED"
  | "EXPIRED"
  | "FAILED";

export interface TriggerOrder {
  id: UUID;
  user_id: UUID;
  pair_id: UUID;
  kind: TriggerKind;
  side: OrderSide;
  trigger_price: DecimalString;
  limit_price: DecimalString | null;
  qty: DecimalString;
  status: TriggerStatus;
  oco_group_id: UUID | null;
  derived_order_id: UUID | null;
  fail_reason: string | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// ── Bot ─────────────────────────────────────────────────────
export type BotMode = "REPLAY" | "LIVE";
export type BotStatus =
  | "RUNNING"
  | "PAUSED"
  | "STOPPED"
  | "COMPLETED"
  | "FAILED";

export interface StrategyRun {
  id: UUID;
  user_id: UUID;
  pair_id: UUID;
  mode: BotMode;
  status: BotStatus;
  started_at: ISODateString;
  stopped_at: ISODateString | null;
  last_tick_ts: number | null;
  params_json: Record<string, unknown>;
  error_message: string | null;
  created_at: ISODateString;
  updated_at: ISODateString;
}

export interface StrategySignal {
  id: UUID;
  run_id: UUID;
  ts: number;
  kind:
    | "ENTRY"
    | "EXIT"
    | "REGIME_CHANGE"
    | "SETUP_DETECTED"
    | "SETUP_INVALIDATED";
  side: OrderSide | null;
  confidence: string | null;
  payload_json: Record<string, unknown>;
  created_at: ISODateString;
}

// ── Replay ──────────────────────────────────────────────────
export interface ReplaySession {
  user_id: UUID;
  pair_id: UUID;
  current_ts: string;
  speed: string;
  is_active: boolean;
  is_paused: boolean;
  timeframe: string;
  created_at: ISODateString;
  updated_at: ISODateString;
}

// ── Simulation ──────────────────────────────────────────────
export interface SimulationConfig {
  base_spread_bps: number;
  base_slippage_bps: number;
  impact_bps_per_10k_quote: number;
  liquidity_quote_per_tick: number;
  volatility_widening_k: number;
}

export interface SimQuote {
  executable: boolean;
  estimatedPrice: DecimalString;
  slippage_bps: DecimalString;
  requestedNotional: DecimalString;
  availableLiquidity: DecimalString;
}

// ── API Keys ────────────────────────────────────────────────
export interface ApiKey {
  id: UUID;
  label: string;
  scopes: ("read" | "trade" | "admin")[];
  lastUsedAt: ISODateString | null;
  revoked: boolean;
  expiresAt: ISODateString | null;
  createdAt: ISODateString;
}

// ── Risk ────────────────────────────────────────────────────
export interface RiskStatus {
  trading_allowed: boolean;
  breakers: Array<{
    breaker_key: string;
    reason: string | null;
    closes_at: string | null;
  }>;
}

// ── System Status ───────────────────────────────────────────
export interface SystemStatus {
  tradingEnabledGlobal: boolean;
  readOnlyMode: boolean;
  betaMode: boolean;
  degraded: boolean;
  message?: string;
}

export interface UserStatus {
  tradingEnabled: boolean;
  quotas: {
    maxOrdersPerMin: number;
    maxOpenOrders: number;
    maxDailyOrders: number;
  };
}

// ── Pagination ──────────────────────────────────────────────
export interface PaginatedResponse<T> {
  data: T[];
  nextCursor: string | null;
}

// ── Errors ──────────────────────────────────────────────────
export interface LegacyApiError {
  ok: false;
  error: string;
  details?: Record<string, unknown>;
}

export interface V1ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
}
