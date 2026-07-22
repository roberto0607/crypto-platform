import client from "../client";
import type { UUID } from "@/types/api";

/** Replaces (not merges) an SSE stream's price.tick/candle.closed interest
 *  set. streamId comes from the stream.ready frame (see api/sse.ts's
 *  getStreamId/waitForStreamId). Used by lib/datafeedAdapter.ts. */
export function subscribeStream(streamId: string, pairIds: UUID[]) {
  return client.post<{ ok: true }>("/v1/events/subscribe", { streamId, pairIds });
}
