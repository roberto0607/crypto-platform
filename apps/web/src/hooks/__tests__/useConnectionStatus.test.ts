/**
 * useConnectionStatus — staleness ("PRICE DELAYED...") reproductions for the
 * 2026-10-01 investigation.
 *
 * Tests marked `it.fails` encode the CORRECT behavior and currently fail
 * because of the bug they reproduce (so the suite stays green). When the
 * follow-up fix lands they will start passing, which makes `it.fails`
 * report them as failures — flip them to plain `it` at that point.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConnectionStatus } from "@/hooks/useConnectionStatus";
import { useAppStore } from "@/stores/appStore";

function tick() {
  act(() => {
    useAppStore.getState().setLastPriceTickAt(Date.now());
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
    useAppStore.setState({ sseConnected: true, sseConnectionState: "connected", lastPriceTickAt: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("control: goes stale after >10s with no tick or ping", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(13_000);
    expect(result.current.priceStale).toBe(true);
  });

  it("control: a tick slower than the 3s check cadence clears a stale flag", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    advance(13_000);
    expect(result.current.priceStale).toBe(true);
    tick();
    advance(3_000);
    expect(result.current.priceStale).toBe(false);
  });

  // ROOT CAUSE #1 — the latch. lastPriceTickAt is an effect dependency, so
  // every tick tears down and recreates the 3s check interval. While ticks
  // arrive faster than every 3s (normal for BTC on Coinbase), the check never
  // runs, and priceStale — only ever written inside that check — stays at
  // whatever it was. One >10s gap (Safari background tab, brief feed gap)
  // therefore latches "PRICE DELAYED" on for as long as the feed stays busy.
  it.fails("REPRO latch: clears once ticks resume at a normal (sub-3s) rate", () => {
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

  // ROOT CAUSE #2 — ping cadence vs threshold. With no price.tick frames on
  // the stream (see the datafeedAdapter resubscribe repro), liveness comes
  // only from the server's `ping`, sent every 15s (v1Events.ts
  // PING_INTERVAL_MS) — but the client calls >10s stale. A perfectly healthy
  // connection therefore shows PRICE DELAYED for part of every 15s cycle.
  it.fails("REPRO ping cadence: never stale on a healthy stream that only carries 15s pings", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    let everStale = false;
    for (let s = 1; s <= 60; s++) {
      advance(1_000);
      if (s % 15 === 0) tick();
      everStale ||= result.current.priceStale;
    }
    expect(everStale).toBe(false);
  });

  it("documents the ping-only duty cycle: stale for several seconds of every 15s window", () => {
    const { result } = renderHook(() => useConnectionStatus());
    tick();
    let staleSeconds = 0;
    for (let s = 1; s <= 60; s++) {
      advance(1_000);
      if (s % 15 === 0) tick();
      if (result.current.priceStale) staleSeconds++;
    }
    // ~6 of every 15s on these timings (stale at +12s, cleared 3s after the next ping).
    expect(staleSeconds).toBeGreaterThanOrEqual(15);
  });
});
