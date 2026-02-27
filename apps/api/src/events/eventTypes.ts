/**
 * eventTypes.ts — Typed event envelope for the SSE backbone.
 *
 * All events share a common envelope shape. The `type` field
 * is a discriminated union key so consumers can narrow on it.
 */

// ── Event envelope ──

export interface EventEnvelope<T extends string = string, D = unknown> {
  type: T;
  ts: number;
  requestId?: string;
  userId?: string;
  data: D;
}

// ── Specific event data types ──

export interface OrderUpdatedData {
  orderId: string;
  pairId: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  status: string;
  qty: string;
  filledQty: string;
  limitPrice?: string | null;
}

export interface TradeCreatedData {
  tradeId: string;
  orderId: string;
  pairId: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  quoteAmount: string;
}

export interface WalletUpdatedData {
  walletId: string;
  assetId: string;
  balance: string;
  reserved: string;
  entryType: string;
}

export interface ReplayTickData {
  pairId: string;
  bid: string;
  ask: string;
  last: string;
  sessionTs: number;
}

export interface PriceTickData {
  pairId: string;
  symbol: string;
  bid: string | null;
  ask: string | null;
  last: string;
}

export interface TriggerFiredData {
  triggerId: string;
  pairId: string;
  kind: string;
  side: "BUY" | "SELL";
  derivedOrderId: string | null;
}

export interface TriggerCanceledData {
  triggerId: string;
  pairId: string;
  reason: string;
}

// ── Discriminated union ──

export type AppEvent =
  | EventEnvelope<"order.updated", OrderUpdatedData>
  | EventEnvelope<"trade.created", TradeCreatedData>
  | EventEnvelope<"wallet.updated", WalletUpdatedData>
  | EventEnvelope<"replay.tick", ReplayTickData>
  | EventEnvelope<"price.tick", PriceTickData>
  | EventEnvelope<"trigger.fired", TriggerFiredData>
  | EventEnvelope<"trigger.canceled", TriggerCanceledData>;

// ── Helper to create events ──

export function createEvent<T extends AppEvent["type"]>(
  type: T,
  data: Extract<AppEvent, { type: T }>["data"],
  opts?: { requestId?: string; userId?: string }
): Extract<AppEvent, { type: T }> {
  return {
    type,
    ts: Date.now(),
    requestId: opts?.requestId,
    userId: opts?.userId,
    data,
  } as Extract<AppEvent, { type: T }>;
}
