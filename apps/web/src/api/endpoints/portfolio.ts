import client from "../client";
import type {
  PortfolioSummary,
  PortfolioSnapshot,
  PerformanceSummary,
} from "@/types/api";

export function getSummary(competitionId?: string | null) {
  return client.get<{ ok: true; summary: PortfolioSummary }>(
    "/v1/portfolio/summary",
    { params: competitionId ? { competitionId } : undefined },
  );
}

export function getEquityCurve(params?: { from?: number; to?: number; competitionId?: string }) {
  return client.get<{ ok: true; snapshots: PortfolioSnapshot[] }>(
    "/v1/portfolio/equity",
    { params },
  );
}

export function getPerformance(params?: { from?: string; to?: string; competitionId?: string }) {
  return client.get<{ ok: true; performance: PerformanceSummary }>(
    "/v1/portfolio/performance",
    { params },
  );
}
