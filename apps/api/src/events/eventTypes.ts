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

export interface CompetitionStartedData {
  competitionId: string;
  name: string;
}

export interface CompetitionEndedData {
  competitionId: string;
  name: string;
}

export interface CandleClosedData {
  pairId: string;
  timeframe: string;
  ts: number; // epoch ms of candle start
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  buyVolume: string;
  sellVolume: string;
}

export interface NotificationCreatedData {
  notificationId: string;
  kind: string;
  title: string;
  body: string | null;
}

export interface ChallengeReceivedData {
  matchId: string;
  challengerId: string;
  challengerName: string;
  duration: number;
  createdAt: string;
}

export interface MatchStartedData {
  matchId: string;
  challengerId: string;
  opponentId: string;
  duration: number;
  startedAt: string;
}

/**
 * Terminal match event — published to BOTH participants the instant a match
 * ends, so the opponent's WON/LOST/FORFEITED screen renders without waiting
 * for a poll tick. Carries the match-level verdict (winner, pnls, elo deltas)
 * so the client needs no re-fetch for the primary result; the overlay's
 * existing GET /v1/matches/:id/result call enriches the ELO display after.
 *
 * `reason` discriminates the three terminal transitions. The event is named
 * generically (match.ended, not forfeit-specific) so the same per-user channel
 * can later carry other match-lifecycle pushes.
 */
export interface MatchEndedData {
  matchId: string;
  winnerUserId: string | null;
  loserUserId: string | null;
  forfeitUserId: string | null;
  reason: "forfeit" | "timeout" | "mutual_forfeit";
  challengerPnlPct: string | null;
  opponentPnlPct: string | null;
  eloDeltas: { winner: number; loser: number } | null;
}

export interface SignalNewData {
  signalId: string;
  pairId: string;
  timeframe: string;
  signalType: "BUY" | "SELL";
  confidence: number;
  entryPrice: string;
  tp1: string;
  tp2: string;
  tp3: string;
  stopLoss: string;
  modelVersion: string;
}

// ── Discriminated union ──

export type AppEvent =
  | EventEnvelope<"order.updated", OrderUpdatedData>
  | EventEnvelope<"trade.created", TradeCreatedData>
  | EventEnvelope<"wallet.updated", WalletUpdatedData>
  | EventEnvelope<"replay.tick", ReplayTickData>
  | EventEnvelope<"price.tick", PriceTickData>
  | EventEnvelope<"trigger.fired", TriggerFiredData>
  | EventEnvelope<"trigger.canceled", TriggerCanceledData>
  | EventEnvelope<"competition.started", CompetitionStartedData>
  | EventEnvelope<"competition.ended", CompetitionEndedData>
  | EventEnvelope<"candle.closed", CandleClosedData>
  | EventEnvelope<"notification.created", NotificationCreatedData>
  | EventEnvelope<"signal.new", SignalNewData>
  | EventEnvelope<"match.started", MatchStartedData>
  | EventEnvelope<"match.ended", MatchEndedData>
  | EventEnvelope<"challenge.received", ChallengeReceivedData>;

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
