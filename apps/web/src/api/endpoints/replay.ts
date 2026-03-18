import client from "../client";
import type { ReplaySession, UUID } from "@/types/api";

export function start(params: {
  pairId: UUID;
  startTs: string;
  endTs?: string;
  timeframe: string;
  speed?: number;
}) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/start", params);
}

export function pause(pairId: UUID) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/pause", { pairId });
}

export function resume(pairId: UUID) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/resume", { pairId });
}

export function seek(pairId: UUID, ts: string) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/seek", { pairId, ts });
}

export function stop(pairId: UUID) {
  return client.post<{ ok: true }>("/replay/stop", { pairId });
}

export function getState(pairId: UUID) {
  return client.get<{ ok: true; session: ReplaySession }>("/replay/state", {
    params: { pairId },
  });
}

export function getActive() {
  return client.get<{ ok: true; session: ReplaySession | null }>("/replay/active");
}
