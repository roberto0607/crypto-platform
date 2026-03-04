import client from "../client";
import type { ReplaySession, UUID } from "@/types/api";

export function start(params: {
  pairId: UUID;
  timeframe: string;
  speed?: string;
}) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/start", params);
}

export function pause() {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/pause");
}

export function resume() {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/resume");
}

export function seek(ts: string) {
  return client.post<{ ok: true; session: ReplaySession }>("/replay/seek", { ts });
}

export function stop() {
  return client.post<{ ok: true }>("/replay/stop");
}

export function getState() {
  return client.get<{ ok: true; session: ReplaySession }>("/replay/state");
}
