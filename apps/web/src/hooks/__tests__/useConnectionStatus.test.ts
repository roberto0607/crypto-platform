/**
 * useConnectionStatus — "PRICE DELAYED..." banner.
 *
 * Started as reproductions for the 2026-10-01 investigation (`it.fails` for
 * the latch and the 15s-ping duty cycle); flipped to plain `it` with the fix.
 * The banner now means: connected, and either no SSE message for 12s or the
 * server's own price for the watched pair (ping.priceAgeMs) is over 15s old.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConnectionStatus, computePriceStale } from "@/hooks/useConnectionStatus";
import { useAppStore } from "@/stores/appStore";

/** A price.tick for the subscribed pair (what useSSE's onPriceTick records). */
function tick() {
  act(() => {
    const now = Date.now();
    useAppStore.getState().setLastPriceTickAt(now);
    useAppStore.getState().setPriceFreshAt(now);
  });
}

/** A server ping (what useSSE's onPing records). */
function ping(priceAgeMs: number | null) {
  act(() => {
    const now = Date.now();
    useAppStore.getState().setLastPriceTickAt(now);
    useAppStore.getState().setPriceFreshAt(priceAgeMs === null ? null : now - priceAgeMs);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useConnectionStatus — priceStale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    useAppStore.setState({ sseConnected: true, sseConnectionState: "connected", lastPriceTickAt: 0, priceFreshAt: null });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("control: goes stale after >12s with no tick or ping", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(11_000);
    expect(result.current.priceStale).toBe(false);
    advance(2_000);
    expect(result.current.priceStale).toBe(true);
  });

  it("clears on the very next message after a gap, without waiting for the check interval", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(20_000);
    expect(result.current.priceStale).toBe(true);
    tick();
    expect(result.current.priceStale).toBe(false);
  });

  // Was ROOT CAUSE #1 — the latch: the check restarted on every tick, so a
  // busy feed (ticks faster than the old 3s check) kept a stale flag on forever.
  it("latch: clears once ticks resume at a normal (sub-3s) rate", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(13_000);
    expect(result.current.priceStale).toBe(true);

    for (let i = 0; i < 60; i++) {
      advance(1_000);
      tick();
    }
    expect(result.current.priceStale).toBe(false);
  });

  it("latch, busy feed: ticks every 200ms after a gap clear it immediately and it stays clear", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(30_000);
    expect(result.current.priceStale).toBe(true);
    let everStale = false;
    for (let i = 0; i < 300; i++) {
      tick();
      advance(200);
      everStale ||= result.current.priceStale;
    }
    expect(everStale).toBe(false);
  });

  // Was ROOT CAUSE #2 — the server pinged every 15s but the client called >10s
  // stale. Pings are now every 5s and carry the server's price age.
  it("ping cadence: never stale on a healthy stream that only carries 5s pings", () => {
    const { result } = renderHook(() => useConnectionStatus());
    ping(300);
    let everStale = false;
    for (let s = 1; s <= 120; s++) {
      advance(1_000);
      if (s % 5 === 0) ping(300);
      everStale ||= result.current.priceStale;
    }
    expect(everStale).toBe(false);
  });

  it("quiet symbol: 60s with no ticks but a live book (fresh ping price age) is never stale", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    let everStale = false;
    for (let s = 1; s <= 60; s++) {
      advance(1_000);
      if (s % 5 === 0) ping(400 + (s % 3) * 200);
      everStale ||= result.current.priceStale;
    }
    expect(everStale).toBe(false);
  });

  it("connection alive but server price >15s old → stale; clears when the price is fresh again", () => {
    const { result } = renderHook(() => useConnectionStatus());
    ping(16_000);
    expect(result.current.priceStale).toBe(true);
    advance(5_000);
    ping(21_000);
    expect(result.current.priceStale).toBe(true);
    advance(5_000);
    ping(500);
    expect(result.current.priceStale).toBe(false);
  });

  it("server price age keeps growing between pings: a 9s age goes stale before the next ping", () => {
    const { result } = renderHook(() => useConnectionStatus());
    ping(9_000);
    advance(4_000);
    expect(result.current.priceStale).toBe(false);
    advance(3_000); // 9s + 7s = 16s, no newer ping or tick yet
    expect(result.current.priceStale).toBe(true);
  });

  it("unknown price age (nothing subscribed) only uses connection liveness", () => {
    const { result } = renderHook(() => useConnectionStatus());
    for (let s = 1; s <= 60; s++) {
      advance(1_000);
      if (s % 5 === 0) ping(null);
    }
    expect(result.current.priceStale).toBe(false);
  });

  it("re-evaluates immediately when a backgrounded tab becomes visible again", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    // Background tab: timers throttled, so time passes without the interval running.
    vi.setSystemTime(Date.now() + 120_000);
    expect(result.current.priceStale).toBe(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.priceStale).toBe(true);
  });

  it("never stale while not connected (the badge shows connection state instead)", () => {
    useAppStore.setState({ sseConnected: false, sseConnectionState: "reconnecting" });
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(60_000);
    expect(result.current.priceStale).toBe(false);
  });
});

describe("computePriceStale", () => {
  const now = 100_000;
  it.each([
    ["fresh tick", { sseConnected: true, lastPriceTickAt: now - 500, priceFreshAt: now - 500 }, false],
    ["silent connection", { sseConnected: true, lastPriceTickAt: now - 12_001, priceFreshAt: now - 500 }, true],
    ["old server price", { sseConnected: true, lastPriceTickAt: now - 1_000, priceFreshAt: now - 15_001 }, true],
    ["unknown price age", { sseConnected: true, lastPriceTickAt: now - 1_000, priceFreshAt: null }, false],
    ["nothing received yet", { sseConnected: true, lastPriceTickAt: 0, priceFreshAt: null }, false],
    ["disconnected", { sseConnected: false, lastPriceTickAt: now - 60_000, priceFreshAt: now - 60_000 }, false],
  ] as const)("%s", (_, s, expected) => {
    expect(computePriceStale(s, now)).toBe(expected);
  });
});
