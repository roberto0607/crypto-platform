import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setVisibleInterval } from "@/lib/visibleInterval";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("setVisibleInterval", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("ticks normally while visible", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("makes no calls while hidden, then catches up once on return", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("doesn't double up when the tab comes back before a tick was due", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    setVisibility("hidden");
    vi.advanceTimersByTime(500);
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();
    stop();
  });

  it("stops ticking and listening after cleanup", () => {
    const fn = vi.fn();
    const stop = setVisibleInterval(fn, 1000);
    stop();
    vi.advanceTimersByTime(5000);
    setVisibility("hidden");
    setVisibility("visible");
    expect(fn).not.toHaveBeenCalled();
  });
});
