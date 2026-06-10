import { describe, it, expect } from "vitest";

import { isAtLiveEdge } from "@/components/trading/CandlestickChart";

// `range.to` is a fractional bar index; the latest bar sits at index
// barCount - 1. The helper reports "at live edge" when the latest bar is near
// the right boundary, tolerating the #45 recent-window right padding and the
// transient off-by-one while a live candle forms.
describe("isAtLiveEdge", () => {
  const barCount = 750;
  const lastBar = barCount - 1; // 749

  it("treats a null range as at-edge (nothing to scroll back to yet)", () => {
    expect(isAtLiveEdge(null, barCount)).toBe(true);
  });

  it("treats an empty series as at-edge", () => {
    expect(isAtLiveEdge({ from: 0, to: 0 }, 0)).toBe(true);
  });

  it("is at-edge when the last bar sits at the right boundary", () => {
    expect(isAtLiveEdge({ from: lastBar - 120, to: lastBar }, barCount)).toBe(true);
  });

  it("is at-edge with the #45 right padding (to ≈ barCount + 2)", () => {
    expect(isAtLiveEdge({ from: barCount - 118, to: barCount + 2 }, barCount)).toBe(true);
  });

  it("is at-edge through the forming-live-candle off-by-one", () => {
    // A live candle adds one bar; the helper is called with barCount including it.
    expect(isAtLiveEdge({ from: barCount - 117, to: barCount + 2 }, barCount + 1)).toBe(true);
  });

  it("is OFF-edge when scrolled left into history", () => {
    // Right boundary well before the last bar → latest bar off-screen right.
    expect(isAtLiveEdge({ from: 200, to: 320 }, barCount)).toBe(false);
  });

  it("is OFF-edge when over-scrolled right into blank future", () => {
    // Right boundary far past the last bar → lots of empty space on the right.
    expect(isAtLiveEdge({ from: lastBar - 80, to: lastBar + 40 }, barCount)).toBe(false);
  });

  it("flips off-edge as soon as the last bar is >1.5 bars off the right", () => {
    expect(isAtLiveEdge({ from: lastBar - 121, to: lastBar - 1 }, barCount)).toBe(true);
    expect(isAtLiveEdge({ from: lastBar - 122, to: lastBar - 2 }, barCount)).toBe(false);
  });
});
