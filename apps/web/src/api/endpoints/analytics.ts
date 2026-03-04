import client from "../client";
import type { Position, PnlSummary, UUID } from "@/types/api";

export function getPositions(params?: { pairId?: UUID }) {
  return client.get<{ ok: true; positions: Position[] }>("/positions", { params });
}

export function getPnlSummary() {
  return client.get<{ ok: true; summary: PnlSummary }>("/positions/pnl");
}

export function getEquity() {
  return client.get<{ ok: true; equity: string }>("/positions/equity");
}

export function getStats() {
  return client.get<{ ok: true; stats: Record<string, unknown> }>("/positions/stats");
}
