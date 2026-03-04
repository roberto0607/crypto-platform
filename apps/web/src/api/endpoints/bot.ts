import client from "../client";
import type { StrategyRun, StrategySignal, UUID, BotMode } from "@/types/api";

export function startRun(params: {
  pairId: UUID;
  mode: BotMode;
  paramsJson?: Record<string, unknown>;
}) {
  return client.post<{ ok: true; run: StrategyRun }>("/bot/runs", params);
}

export function pauseRun(runId: UUID) {
  return client.post<{ ok: true; run: StrategyRun }>(`/bot/runs/${runId}/pause`);
}

export function resumeRun(runId: UUID) {
  return client.post<{ ok: true; run: StrategyRun }>(`/bot/runs/${runId}/resume`);
}

export function stopRun(runId: UUID) {
  return client.post<{ ok: true; run: StrategyRun }>(`/bot/runs/${runId}/stop`);
}

export function listRuns(params?: { status?: string; cursor?: string; limit?: number }) {
  return client.get<{ ok: true; runs: StrategyRun[]; nextCursor: string | null }>(
    "/bot/runs",
    { params },
  );
}

export function getRun(runId: UUID) {
  return client.get<{ ok: true; run: StrategyRun }>(`/bot/runs/${runId}`);
}

export function getSignals(
  runId: UUID,
  params?: { cursor?: string; limit?: number },
) {
  return client.get<{ ok: true; signals: StrategySignal[]; nextCursor: string | null }>(
    `/bot/runs/${runId}/signals`,
    { params },
  );
}
