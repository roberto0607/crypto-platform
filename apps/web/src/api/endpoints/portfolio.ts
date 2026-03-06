import client from "../client";
import type {
  PortfolioSummary,
  PortfolioSnapshot,
  PerformanceSummary,
} from "@/types/api";

export function getSummary(competitionId?: string | null) {
  return client.get<{ ok: true; summary: PortfolioSummary }>(
    "/portfolio/summary",
    { params: competitionId ? { competitionId } : undefined },
  );
}

export function getEquityCurve(params?: { from?: string; to?: string; competitionId?: string }) {
  return client.get<{ ok: true; snapshots: PortfolioSnapshot[] }>(
    "/portfolio/equity",
    { params },
  );
}

export function getPerformance(params?: { from?: string; to?: string; competitionId?: string }) {
  return client.get<{ ok: true; performance: PerformanceSummary }>(
    "/portfolio/performance",
    { params },
  );
}
