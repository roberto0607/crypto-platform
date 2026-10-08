/**
 * datafeedAdapter — SSE interest-set resubscribe (2026-10-01 "PRICE DELAYED"
 * investigation; the `it.fails` reproduction is now a plain `it`).
 *
 * Every SSE (re)connect gets a NEW server-side streamId whose price.tick
 * interest set starts EMPTY (v1Events.ts). The adapter must re-send the open
 * chart's pair on every new stream.ready — a library retry, a forced
 * reconnect (heartbeat timeout / tab resume) or a token-refresh reconnect —
 * not only on mount / pair switch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const sse = vi.hoisted(() => ({
  streamId: "stream-1" as string | null,
  listeners: new Set<(id: string) => void>(),
  waiters: [] as Array<(id: string) => void>,
}));
const subscribeStreamMock = vi.fn((..._args: unknown[]) => Promise.resolve({ data: { ok: true } }));

vi.mock("@/api/sse", () => ({
  waitForStreamId: () =>
    sse.streamId ? Promise.resolve(sse.streamId) : new Promise<string>((r) => sse.waiters.push(r)),
  onStreamReady: (l: (id: string) => void) => {
    sse.listeners.add(l);
    return () => sse.listeners.delete(l);
  },
}));
vi.mock("@/api/endpoints/events", () => ({
  subscribeStream: (...args: unknown[]) => subscribeStreamMock(...args),
}));

import { createDatafeedAdapter, __interestSetSettled } from "@/lib/datafeedAdapter";

const PAIR = "11111111-1111-1111-1111-111111111111";
const PAIR_B = "22222222-2222-2222-2222-222222222222";

/** What api/sse.ts does on a new stream.ready frame. */
function streamReady(id: string) {
  sse.streamId = id;
  const waiters = sse.waiters;
  sse.waiters = [];
  waiters.forEach((r) => r(id));
  sse.listeners.forEach((l) => l(id));
}

async function settle() {
  for (let i = 0; i < 3; i++) await __interestSetSettled();
}

describe("datafeedAdapter — interest set across SSE reconnects", () => {
  beforeEach(async () => {
    await settle();
    sse.streamId = "stream-1";
    sse.listeners.clear();
    sse.waiters = [];
    subscribeStreamMock.mockClear();
  });

  it("control: subscribes the current stream when a chart subscribes", async () => {
    const adapter = createDatafeedAdapter();
    adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await settle();
    expect(subscribeStreamMock).toHaveBeenCalledWith("stream-1", [PAIR]);
  });

  it("re-subscribes the NEW stream after an SSE reconnect", async () => {
    const adapter = createDatafeedAdapter();
    adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await settle();

    // Connection drops (streamId cleared), then a new stream.ready arrives.
    sse.streamId = null;
    streamReady("stream-2");
    await settle();

    expect(subscribeStreamMock).toHaveBeenLastCalledWith("stream-2", [PAIR]);
  });

  it("keeps re-subscribing across repeated reconnects, and stops once the chart unsubscribes", async () => {
    const adapter = createDatafeedAdapter();
    const handle = adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await settle();
    streamReady("stream-2");
    await settle();
    streamReady("stream-3");
    await settle();
    expect(subscribeStreamMock).toHaveBeenLastCalledWith("stream-3", [PAIR]);

    adapter.unsubscribeBars(handle);
    await settle();
    expect(subscribeStreamMock).toHaveBeenLastCalledWith("stream-3", []);
    subscribeStreamMock.mockClear();
    streamReady("stream-4");
    await settle();
    expect(subscribeStreamMock).not.toHaveBeenCalled();
  });

  it("pair switch A→B always ends subscribed to [B], even if the stream isn't ready yet", async () => {
    sse.streamId = null; // mid-reconnect
    const chartA = createDatafeedAdapter();
    const a = chartA.subscribeBars(PAIR, "1m", () => {}, () => {});
    chartA.unsubscribeBars(a);
    const chartB = createDatafeedAdapter();
    chartB.subscribeBars(PAIR_B, "1m", () => {}, () => {});

    streamReady("stream-9");
    await settle();
    expect(subscribeStreamMock).toHaveBeenLastCalledWith("stream-9", [PAIR_B]);
    // Superseded sends are skipped, never sent after B.
    expect(subscribeStreamMock.mock.calls.every((c) => (c[1] as string[])[0] !== PAIR)).toBe(true);
  });

  it("sends in order: a slow unsubscribe can't land after the next pair's subscribe", async () => {
    let releaseFirst!: () => void;
    subscribeStreamMock.mockImplementationOnce(
      () => new Promise((r) => { releaseFirst = () => r({ data: { ok: true } }); }),
    );
    const adapter = createDatafeedAdapter();
    const a = adapter.subscribeBars(PAIR, "1m", () => {}, () => {});
    await Promise.resolve();
    await Promise.resolve();
    adapter.unsubscribeBars(a);
    adapter.subscribeBars(PAIR_B, "1m", () => {}, () => {});
    await Promise.resolve();
    expect(subscribeStreamMock).toHaveBeenCalledTimes(1); // [A] in flight; the rest queue behind it
    releaseFirst();
    await settle();
    expect(subscribeStreamMock).toHaveBeenLastCalledWith("stream-1", [PAIR_B]);
  });
});
