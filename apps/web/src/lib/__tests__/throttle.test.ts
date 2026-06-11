import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createThrottle } from "@/lib/throttle";

// Fake timers also mock Date.now() in vitest, so advancing the clock advances
// the throttle's internal `lastFire` comparisons deterministically.
describe("createThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires immediately on the leading edge", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);
    t();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses N rapid calls within the window into 1 leading + 1 trailing", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);

    // 5 calls in quick succession, all inside the same 500ms window.
    t(); // leading fire
    t();
    t();
    t();
    t(); // these 4 coalesce into a single pending trailing call
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance past the window boundary — exactly one trailing fire.
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);

    // No further fires without new calls.
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not schedule a trailing call for a lone leading call", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);
    t();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    // Still 1 — a single call has no trailing edge to fire.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires once per call when calls are spaced further than the window", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);

    t();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);

    t();
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(600);

    t();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("trailing call carries the latest burst, then a later call leads again", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);

    t(); // leading (t=0)
    t(); // schedules trailing at t=500
    vi.advanceTimersByTime(500); // trailing fires
    expect(fn).toHaveBeenCalledTimes(2);

    // Now >500ms since last fire — next call leads immediately.
    vi.advanceTimersByTime(600);
    t();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("cancel() clears a pending trailing call", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);

    t(); // leading
    t(); // schedules trailing
    expect(fn).toHaveBeenCalledTimes(1);

    t.cancel(); // drop the pending trailing fetch
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() resets the clock so the next call leads immediately", () => {
    const fn = vi.fn();
    const t = createThrottle(fn, 500);

    t(); // leading at t=0
    t.cancel(); // reset lastFire
    // Without cancel this call would be inside the window and only schedule a
    // trailing call; after cancel it fires immediately.
    t();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
