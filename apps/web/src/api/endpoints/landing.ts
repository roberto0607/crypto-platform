import client from "../client";

export type CallDirection = "UP" | "DOWN";
export type CallOutcome = "WIN" | "LOSS" | "PUSH" | "VOID";

export interface OpenQuickCall {
  id: string;
  direction: CallDirection;
  entryPrice: string;
  entryAt: number;
  settleAt: number;
}

export interface SettledQuickCall {
  id: string;
  direction: CallDirection;
  entryPrice: string;
  exitPrice: string | null;
  outcome: CallOutcome;
  settledAt: number;
}

export interface QuickCallState {
  call: OpenQuickCall | null;
  streak: number;
  history: SettledQuickCall[];
}

export interface PublicPlayer {
  handle: string | null;
  returnPct: number | null;
  pnlUsd: number | null;
}

export interface PublicTrade {
  player: "challenger" | "opponent";
  side: "BUY" | "SELL";
  qty: string;
  asset: string;
  at: number;
}

export interface FeaturedMatch {
  matchId: string;
  secondsLeft: number;
  spectatorCount: number;
  challenger: PublicPlayer;
  opponent: PublicPlayer;
  series: Array<{ t: number; challengerPct: number; opponentPct: number }>;
  lastTrades: PublicTrade[];
}

export type HandleCheck =
  | { available: true }
  | { available: false; reason: "invalid" | "taken" };

export function getQuickCallCurrent() {
  return client.get<QuickCallState & { ok: true }>("/v1/quick-call/current");
}

export function placeQuickCall(direction: CallDirection) {
  return client.post<{ ok: true; call: OpenQuickCall; streak: number }>("/v1/quick-call", { direction });
}

export function checkHandle(h: string) {
  return client.get<HandleCheck & { ok: true; handle: string }>("/v1/handles/available", { params: { h } });
}
