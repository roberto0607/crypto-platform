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
  /**
   * Match-room target — an independent, additive delivery dimension
   * alongside `userId` (see eventBus.ts's deliverLocally). Set on
   * match-scoped events so spectators registered for this matchId receive
   * them, in addition to whichever userId(s) the event is also targeted at.
   */
  matchId?: string;
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

export interface AlertUpdatedData {
  alertId: string;
  pairId: string;
  action: "created" | "fired" | "cancelled" | "expired";
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

export interface FriendRequestReceivedData {
  friendshipId: string;
  requesterId: string;
  requesterName: string;
  createdAt: string;
}

export interface FriendRequestAcceptedData {
  friendshipId: string;
  accepterId: string;
  accepterName: string;
}

export interface MessageReceivedData {
  conversationId: string;
  conversationType: "dm" | "match";
  messageId: string;
  senderId: string;
  senderName: string;
  body: string | null;
  imageUrl: string | null;
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

/**
 * Live in-match PnL push — published to BOTH participants whenever either
 * side's unrealized P&L moves meaningfully (see matchPnlEngine.ts's publish
 * gate). Carries only the two PnL numbers; both consumers already know
 * which side is "you" vs. "opponent" from the match row's challenger_id/
 * opponent_id they already hold.
 */
export interface MatchPnlUpdateData {
  matchId: string;
  challengerPnlPct: string;
  opponentPnlPct: string;
}

/**
 * Live spectator-count push — published whenever a match's spectator room
 * gains or loses a watcher, to BOTH participants (so players can see "N
 * watching") and to everyone currently in the match's spectator room.
 */
export interface MatchSpectatorCountData {
  matchId: string;
  count: number;
}

/**
 * Scanner Agent output (Gate 1b Task 5) — published once per completed run
 * that produced a validated result (see scannerAgentJob.ts). Broadcast (no
 * userId/matchId) since a scan is a platform-wide market read, not tied to
 * one user's account -- same targeting as signal.new/candle.closed. No
 * frontend consumer exists yet; this is backend-only, delivered via the
 * same Redis-mirrored eventBus every other event type uses
 * (see eventBus.ts's publish()).
 */
export interface ScannerCandidateData {
  pairId: string;
  symbol: string;
  rank: number;
  reasoning: string;
  regime?: string | null;
  supportingDataPoints: string[];
}

export interface ScannerResultData {
  candidates: ScannerCandidateData[];
}

/**
 * Chart Analysis Agent output (Gate 1c) -- published once per successful
 * insertTradeProposal, alongside (not replacing) runChartAnalysisAgent's
 * own return value. Triggers the Risk Agent (Gate 1d), same event-driven
 * pattern as scanner.result -> Chart Analysis. Deliberately minimal --
 * the Risk Agent re-fetches the full trade_proposals row itself inside
 * its evaluation transaction rather than trusting this payload, since a
 * money-adjacent decision (position sizing) should read the current row
 * state, not a snapshot taken at publish time.
 */
export interface ChartAnalysisProposalCreatedData {
  proposalId: string;
  pairId: string;
}

/**
 * Risk Agent output (Gate 1d) -- published once per successful
 * outcome='approved' commit in evaluateTradeProposal, alongside (not
 * replacing) that function's own return value. Triggers the Execution
 * Agent (Gate 1e), same event-driven pattern as
 * chart_analysis.proposal_created -> Risk Agent. Deliberately minimal --
 * the Execution Agent re-fetches the full trade_proposals row itself
 * inside its own execution transaction rather than trusting this
 * payload, since a money-adjacent decision (placing a real order) should
 * read the current row state, not a snapshot taken at publish time.
 */
export interface RiskAgentProposalApprovedData {
  proposalId: string;
  pairId: string;
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
  // Explainability fields (Gate 1a) — optional, additive. Populated by
  // agent-produced signals (see agents/schemas/tradeProposal.ts); absent
  // on signals from the pre-existing ML pipeline shape above.
  tradeType?: "scalp" | "swing";
  riskRewardRatio?: number;
  entryReason?: string;
  stopReason?: string;
  targetReason?: string;
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
  | EventEnvelope<"alert.updated", AlertUpdatedData>
  | EventEnvelope<"competition.started", CompetitionStartedData>
  | EventEnvelope<"competition.ended", CompetitionEndedData>
  | EventEnvelope<"candle.closed", CandleClosedData>
  | EventEnvelope<"notification.created", NotificationCreatedData>
  | EventEnvelope<"signal.new", SignalNewData>
  | EventEnvelope<"scanner.result", ScannerResultData>
  | EventEnvelope<"chart_analysis.proposal_created", ChartAnalysisProposalCreatedData>
  | EventEnvelope<"risk_agent.proposal_approved", RiskAgentProposalApprovedData>
  | EventEnvelope<"match.started", MatchStartedData>
  | EventEnvelope<"match.ended", MatchEndedData>
  | EventEnvelope<"match.pnl.update", MatchPnlUpdateData>
  | EventEnvelope<"match.spectator_count", MatchSpectatorCountData>
  | EventEnvelope<"challenge.received", ChallengeReceivedData>
  | EventEnvelope<"friend_request.received", FriendRequestReceivedData>
  | EventEnvelope<"friend_request.accepted", FriendRequestAcceptedData>
  | EventEnvelope<"message.received", MessageReceivedData>;

// ── Helper to create events ──

export function createEvent<T extends AppEvent["type"]>(
  type: T,
  data: Extract<AppEvent, { type: T }>["data"],
  opts?: { requestId?: string; userId?: string; matchId?: string }
): Extract<AppEvent, { type: T }> {
  return {
    type,
    ts: Date.now(),
    requestId: opts?.requestId,
    userId: opts?.userId,
    matchId: opts?.matchId,
    data,
  } as Extract<AppEvent, { type: T }>;
}
