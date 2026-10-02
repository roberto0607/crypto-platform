// Diagnostic-only recorder for the SSE price path, read by the ?debug=1
// overlay (components/FeedDebugOverlay.tsx). Added for the 2026-10-01
// "PRICE DELAYED" investigation. Plain mutable state — no store, no React
// state — so recording from the SSE hot path costs a few assignments and
// never triggers a render. It observes only; nothing reads it for behavior.

const TICK_RING_SIZE = 256;

export interface FeedDiagnostics {
  /** Client receive time (Date.now()) of the last price.tick, any pair. */
  lastTickAt: number;
  /** Server publish time (envelope `ts`) of the last price.tick. */
  lastTickServerTs: number | null;
  /** Server socket-write time (`sentAt`) of the last price.tick. */
  lastTickSentAt: number | null;
  lastTickPairId: string | null;
  lastTickSource: string | null;
  ticksTotal: number;
  /** Ring of recent tick receive times, for a ticks/10s rate. */
  tickTimes: number[];
  lastPingAt: number;
  lastPingServerTs: number | null;
  /** streamId from the most recent stream.ready frame (a new one on every (re)connect). */
  currentStreamId: string | null;
  streamsOpened: number;
  /** The streamId/pairIds the last successful POST /v1/events/subscribe targeted. */
  subscribedStreamId: string | null;
  subscribedPairIds: string[];
  subscribedAt: number;
}

export const feedDiag: FeedDiagnostics = {
  lastTickAt: 0,
  lastTickServerTs: null,
  lastTickSentAt: null,
  lastTickPairId: null,
  lastTickSource: null,
  ticksTotal: 0,
  tickTimes: [],
  lastPingAt: 0,
  lastPingServerTs: null,
  currentStreamId: null,
  streamsOpened: 0,
  subscribedStreamId: null,
  subscribedPairIds: [],
  subscribedAt: 0,
};

export function recordPriceTick(event: {
  ts: number;
  sentAt?: number;
  data: { pairId: string; source?: string };
}): void {
  const now = Date.now();
  feedDiag.lastTickAt = now;
  feedDiag.lastTickServerTs = event.ts;
  feedDiag.lastTickSentAt = event.sentAt ?? null;
  feedDiag.lastTickPairId = event.data.pairId;
  feedDiag.lastTickSource = event.data.source ?? null;
  feedDiag.ticksTotal++;
  feedDiag.tickTimes.push(now);
  if (feedDiag.tickTimes.length > TICK_RING_SIZE) feedDiag.tickTimes.shift();
}

export function recordPing(serverTs: number): void {
  feedDiag.lastPingAt = Date.now();
  feedDiag.lastPingServerTs = serverTs;
}

export function recordStreamReady(streamId: string): void {
  feedDiag.currentStreamId = streamId;
  feedDiag.streamsOpened++;
}

export function recordSubscribe(streamId: string, pairIds: string[]): void {
  feedDiag.subscribedStreamId = streamId;
  feedDiag.subscribedPairIds = pairIds;
  feedDiag.subscribedAt = Date.now();
}

/** Ticks received in the trailing window (ring-limited to the last 256). */
export function ticksInLast(ms: number, now: number = Date.now()): number {
  let n = 0;
  for (let i = feedDiag.tickTimes.length - 1; i >= 0; i--) {
    if (now - feedDiag.tickTimes[i]! > ms) break;
    n++;
  }
  return n;
}
