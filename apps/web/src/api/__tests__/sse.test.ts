import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Capture the options passed to fetchEventSource so we can drive its lifecycle
// callbacks (onopen/onerror/onclose) by hand — the real network loop never runs.
const fetchEventSourceMock = vi.fn();
vi.mock("@microsoft/fetch-event-source", () => ({
  fetchEventSource: (...args: unknown[]) => fetchEventSourceMock(...args),
  EventStreamContentType: "text/event-stream",
}));

import { connectSSE, disconnectSSE, forceReconnectSSE, getStreamId, waitForStreamId, onStreamReady, __resetSseForTest } from "@/api/sse";
import { useAppStore } from "@/stores/appStore";
import { useAuthStore } from "@/stores/authStore";

const GRACE_MS = 500;
const CONNECT_TIMEOUT_MS = 5_000;

function capturedOpts(): any {
  return fetchEventSourceMock.mock.calls.at(-1)?.[1];
}
function okResponse() {
  return { ok: true, status: 200, headers: { get: () => "text/event-stream" } };
}
function state() {
  return useAppStore.getState().sseConnectionState;
}

describe("sse connection lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchEventSourceMock.mockReset();
    useAuthStore.setState({ isAuthenticated: true, accessToken: "tok" });
    // NB: we deliberately do NOT preset sseConnectionState here — the first test
    // asserts the genuine appStore.ts default. Every other test calls connectSSE,
    // which sets "initializing" itself, so none rely on a beforeEach preset.
  });

  afterEach(() => {
    disconnectSSE();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("defaults to 'initializing'", () => {
    // Relies on the pristine appStore.ts default — runs first, before any
    // connectSSE/disconnectSSE in this file has mutated the store.
    expect(state()).toBe("initializing");
  });

  it("holds 'initializing' during the grace window, then shows 'connecting'", () => {
    connectSSE("tok", {});
    expect(state()).toBe("initializing");
    vi.advanceTimersByTime(GRACE_MS);
    expect(state()).toBe("connecting");
  });

  it("transitions to 'connected' on a successful open", async () => {
    connectSSE("tok", {});
    await capturedOpts().onopen(okResponse());
    expect(state()).toBe("connected");
    expect(useAppStore.getState().sseConnected).toBe(true);
  });

  it("stays 'connecting' through first-connect errors, then 'disconnected' after the 5s window", () => {
    connectSSE("tok", {});
    vi.advanceTimersByTime(GRACE_MS);
    expect(state()).toBe("connecting");

    // A failing first connect must NOT flash red — it keeps retrying as "connecting".
    const delay = capturedOpts().onerror(new Error("network"));
    expect(typeof delay).toBe("number");
    expect(state()).toBe("connecting");

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(state()).toBe("disconnected");
  });

  it("shows 'reconnecting' (not red) after a drop from a connected session", async () => {
    connectSSE("tok", {});
    await capturedOpts().onopen(okResponse());
    expect(state()).toBe("connected");

    capturedOpts().onerror(new Error("network"));
    expect(state()).toBe("reconnecting");
  });

  it("a forced reconnect shows 'reconnecting', skipping the cold-load states", async () => {
    connectSSE("tok", {});
    await capturedOpts().onopen(okResponse());

    forceReconnectSSE();
    expect(state()).toBe("reconnecting");
    // No grace→connecting sequence on a re-established session.
    vi.advanceTimersByTime(GRACE_MS);
    expect(state()).toBe("reconnecting");
  });
});

describe("sse stream identity across reconnects", () => {
  const streamReady = (id: string) => capturedOpts().onmessage({ event: "stream.ready", data: JSON.stringify({ streamId: id }) });

  beforeEach(() => {
    vi.useFakeTimers();
    fetchEventSourceMock.mockReset();
    __resetSseForTest();
    useAuthStore.setState({ isAuthenticated: true, accessToken: "tok" });
  });

  afterEach(() => {
    __resetSseForTest();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("forgets the streamId the moment the connection drops, so a dead stream is never addressed", async () => {
    connectSSE("tok", {});
    await capturedOpts().onopen(okResponse());
    streamReady("s1");
    expect(getStreamId()).toBe("s1");

    capturedOpts().onerror(new Error("network"));
    expect(getStreamId()).toBeNull();

    let resolved: string | null = null;
    void waitForStreamId().then((id) => { resolved = id; });
    await Promise.resolve();
    expect(resolved).toBeNull(); // waits for the NEW stream instead of returning s1

    await capturedOpts().onopen(okResponse());
    streamReady("s2");
    await Promise.resolve();
    expect(resolved).toBe("s2");
  });

  it("notifies stream-ready listeners on every new stream, including forced reconnects", async () => {
    const seen: string[] = [];
    onStreamReady((id) => seen.push(id));
    connectSSE("tok", {});
    await capturedOpts().onopen(okResponse());
    streamReady("s1");

    capturedOpts().onerror(new Error("network")); // library-internal retry
    await capturedOpts().onopen(okResponse());
    streamReady("s2");

    forceReconnectSSE(); // heartbeat timeout / tab resume path: a fresh connectSSE loop
    await capturedOpts().onopen(okResponse());
    streamReady("s3");

    expect(seen).toEqual(["s1", "s2", "s3"]);
  });

  it("fires onReconnected exactly once per later stream (library retry AND forced reconnect), never on the first", async () => {
    const onReconnected = vi.fn();
    connectSSE("tok", { onReconnected });
    await capturedOpts().onopen(okResponse());
    streamReady("s1");
    expect(onReconnected).not.toHaveBeenCalled();

    capturedOpts().onerror(new Error("network"));
    await capturedOpts().onopen(okResponse());
    expect(onReconnected).not.toHaveBeenCalled(); // waits for the new stream to be addressable
    streamReady("s2");
    expect(onReconnected).toHaveBeenCalledTimes(1);

    forceReconnectSSE();
    await capturedOpts().onopen(okResponse());
    streamReady("s3");
    expect(onReconnected).toHaveBeenCalledTimes(2);
  });

  it("a logout (disconnectSSE) ends the session: the next login's first stream is not a reconnect", async () => {
    const onReconnected = vi.fn();
    connectSSE("tok", { onReconnected });
    await capturedOpts().onopen(okResponse());
    streamReady("s1");
    disconnectSSE();

    connectSSE("tok", { onReconnected });
    await capturedOpts().onopen(okResponse());
    streamReady("s2");
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it("passes the ping's priceAgeMs through (null when absent)", () => {
    const onPing = vi.fn();
    connectSSE("tok", { onPing });
    capturedOpts().onmessage({ event: "ping", data: JSON.stringify({ ts: 5, priceAgeMs: 420 }) });
    capturedOpts().onmessage({ event: "ping", data: JSON.stringify({ ts: 6, priceAgeMs: null }) });
    capturedOpts().onmessage({ event: "ping", data: JSON.stringify({ ts: 7 }) });
    expect(onPing.mock.calls.map((c) => c[0])).toEqual([
      { ts: 5, priceAgeMs: 420 },
      { ts: 6, priceAgeMs: null },
      { ts: 7, priceAgeMs: null },
    ]);
  });
});
