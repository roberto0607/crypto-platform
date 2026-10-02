import client from "../client";
import type { UUID } from "@/types/api";
import { recordSubscribe } from "@/lib/feedDiagnostics";

/** Replaces (not merges) an SSE stream's price.tick/candle.closed interest
 *  set. streamId comes from the stream.ready frame (see api/sse.ts's
 *  getStreamId/waitForStreamId). Used by lib/datafeedAdapter.ts. */
export function subscribeStream(streamId: string, pairIds: UUID[]) {
  return client.post<{ ok: true }>("/v1/events/subscribe", { streamId, pairIds }).then((res) => {
    recordSubscribe(streamId, pairIds);
    return res;
  });
}

/** Diagnostic feed/fill-source health (GET /v1/market/feed-health). Backs the ?debug=1 overlay. */
export function getFeedHealth(pairId: UUID | null) {
  return client.get<FeedHealthResponse>("/v1/market/feed-health", { params: pairId ? { pairId } : {} });
}

interface FeedSymbolHealth { ageMs: number; exchangeLagMs: number | null; count: number }

export interface FeedHealthResponse {
  ok: true;
  serverNow: number;
  feeds: Record<string, { symbols: number; newestAgeMs: number | null; staleSymbols: Array<{ symbol: string; ageMs: number }> }>;
  reconnects: Record<string, {
    total: number;
    recent: Array<{ at: number; cause: string; closeCode: number | null; closeReason: string | null; detail: string | null }>;
  }>;
  eventLoop: {
    monitoring: boolean;
    lastWindow: { p50Ms: number; p99Ms: number; maxMs: number; windowEndedAt: number } | null;
    maxSinceBootMs: number;
  };
  kraken: { connected: boolean; secondsSinceLastTick: number; status: string };
  coinbase: { lastTradeAgeMs: number | null; krakenFallbackActive: boolean };
  pair: null | {
    pairId: UUID;
    symbol: string;
    feeds: Record<string, FeedSymbolHealth | null>;
    fillPriceSource: { source: "live" | "replay" | "fallback"; last: string; bid: string | null; ask: string | null };
    krakenSnapshot: { last: string; bid: string | null; ask: string | null; ageMs: number } | null;
    dbLastPrice: string | null;
    displayedBook: { bestBid: number | null; bestAsk: number | null; ageMs: number } | null;
  };
}
