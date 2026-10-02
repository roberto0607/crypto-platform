/**
 * datafeedAdapter — SSE interest-set resubscribe reproduction (2026-10-01
 * "PRICE DELAYED" investigation).
 *
 * Every SSE (re)connect gets a NEW server-side streamId whose price.tick
 * interest set starts EMPTY (v1Events.ts). The adapter only POSTs
 * /v1/events/subscribe when a chart subscribes (mount / pair switch), so
 * after any reconnect — heartbeat timeout, Safari tab resume, Railway
 * redeploy — the stream carries no price.tick at all until the user switches
 * pairs. PriceTicker/OrderBook keep polling REST every 2s, so the page still
 * looks live while the banner (fed only by ticks + 15s pings) says delayed.
 *
 * `it.fails` = correct behavior, currently failing because of the bug.
 * Flip to `it` when the follow-up fix lands.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let streamId = "stream-1";
const subscribeStreamMock = vi.fn(() => Promise.resolve({ data: { ok: true } }));

vi.mock("@/api/sse", () => ({
  waitForStreamId: () => Promise.resolve(streamId),
}));
vi.mock("@/api/endpoints/events", () => ({
  subscribeStream: (...args: unknown[]) => subscribeStreamMock(...(args as [])),
}));

import { createDatafeedAdapter } from "@/lib/datafeedAdapter";

const PAIR = "11111111-1111-1111-1111-111111111111";

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("datafeedAdapter — interest set across SSE reconnects", () => {
  beforeEach(() => {
    streamId = "stream-1";
    subscribeStreamMock.mockClear();
  });

  it("control: subscribes the current stream when a chart subscribes", async () => {
    const adapter = createDatafeedAdapter();
    adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await flush();
    expect(subscribeStreamMock).toHaveBeenCalledWith("stream-1", [PAIR]);
  });

  it.fails("REPRO: re-subscribes the NEW stream after an SSE reconnect", async () => {
    const adapter = createDatafeedAdapter();
    adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await flush();

    // Reconnect: new stream.ready → new streamId; useSSE/sse.ts dispatch this.
    streamId = "stream-2";
    window.dispatchEvent(new CustomEvent("sse:reconnected"));
    await flush();

    expect(subscribeStreamMock).toHaveBeenCalledWith("stream-2", [PAIR]);
  });
});
