import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Uses the REAL @microsoft/fetch-event-source (no vi.mock) with a stubbed
// fetch: the bug this guards (audit H-01) lives in the library's semantics —
// a normal return from onclose ends its loop for good; only a throw retries.
import { connectSSE, __resetSseForTest } from "@/api/sse";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";

const enc = new TextEncoder();
const frame = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const tick = (last: string) => frame("price.tick", {
  type: "price.tick", ts: 1,
  data: { pairId: "p1", symbol: "BTC/USD", bid: null, ask: null, last },
});

/** A stream that sends `chunks` and then either ends (server close) or stays open. */
function sseResponse(chunks: Uint8Array[], end: boolean): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      if (end) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("sse reconnect after the server ends the stream (real fetch-event-source)", () => {
  beforeEach(() => {
    __resetSseForTest();
    useAuthStore.setState({ isAuthenticated: true, accessToken: "tok" });
  });
  afterEach(() => {
    __resetSseForTest();
    vi.unstubAllGlobals();
  });

  it("reconnects with backoff and keeps delivering prices — no reload", async () => {
    const fetchMock = vi.fn()
      // 1st stream: handshake + one tick, then the server closes it (deploy/restart).
      .mockResolvedValueOnce(sseResponse([frame("stream.ready", { streamId: "s1" }), tick("76612.08")], true))
      // 2nd stream: the restarted server; stays open.
      .mockResolvedValueOnce(sseResponse([frame("stream.ready", { streamId: "s2" }), tick("76705.10")], false));
    vi.stubGlobal("fetch", fetchMock);

    const prices: string[] = [];
    const states: string[] = [];
    const unsub = useAppStore.subscribe((s) => {
      if (states.at(-1) !== s.sseConnectionState) states.push(s.sseConnectionState);
    });
    const onReconnected = vi.fn();
    connectSSE("tok", { onPriceTick: (e) => prices.push(e.data.last), onReconnected });

    // The close must flip straight to "reconnecting" — never "connected"/"LIVE" over a dead stream.
    await vi.waitFor(() => expect(prices).toEqual(["76612.08"]));
    await vi.waitFor(() => expect(states).toContain("reconnecting"));
    expect(states.slice(states.indexOf("connected") + 1)[0]).toBe("reconnecting");

    // Backoff (1 s) → second fetch → new stream's price arrives.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await vi.waitFor(() => expect(prices).toEqual(["76612.08", "76705.10"]), { timeout: 3000 });
    expect(useAppStore.getState().sseConnectionState).toBe("connected");
    expect(onReconnected).toHaveBeenCalledTimes(1);
    unsub();
  });
});
