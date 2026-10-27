/**
 * leverage PR 7: which mark the ISOLATED card uses (positionMark) and when
 * the chart draws a liq line (chartLiqPrice).
 */
import { describe, it, expect } from "vitest";
import { positionMark, chartLiqPrice, MARK_FRESH_MS } from "@/lib/leverageUi";

describe("positionMark", () => {
  const now = 1_000_000;
  it("a fresh engine mark wins over the ticker", () => {
    expect(positionMark({ mark: 79919, paused: false, receivedAt: now - 100 }, now, 79905))
      .toEqual({ mark: 79919, stale: false, source: "engine" });
  });
  it("paused: the last good engine mark, stale", () => {
    expect(positionMark({ mark: 79919, paused: true, receivedAt: now }, now, 79905))
      .toEqual({ mark: 79919, stale: true, source: "engine" });
  });
  it("silent for longer than MARK_FRESH_MS: stale", () => {
    expect(positionMark({ mark: 79919, paused: false, receivedAt: now - MARK_FRESH_MS - 1 }, now, 79905).stale).toBe(true);
    expect(positionMark({ mark: 79919, paused: false, receivedAt: now - MARK_FRESH_MS }, now, 79905).stale).toBe(false);
  });
  it("paused before any good mark: the ticker, stale", () => {
    expect(positionMark({ mark: null, paused: true, receivedAt: now }, now, 79905))
      .toEqual({ mark: 79905, stale: true, source: "ticker" });
  });
  it("nothing received (engine off): the ticker, not stale", () => {
    expect(positionMark(undefined, now, 79905)).toEqual({ mark: 79905, stale: false, source: "ticker" });
  });
});

describe("chartLiqPrice", () => {
  const iso = { base_qty: "0.00602409", margin_mode: "ISOLATED", liq_price: "75075.37688442" };
  it("an open ISOLATED position: its liq price", () => {
    expect(chartLiqPrice(iso)).toBe(75075.37688442);
    expect(chartLiqPrice({ ...iso, base_qty: "-0.01", liq_price: "90845.77" })).toBe(90845.77);
  });
  it("no line: no position, a SPOT position, flat, or no liq price (a 1x long)", () => {
    expect(chartLiqPrice(null)).toBeNull();
    expect(chartLiqPrice({ base_qty: "0.01" })).toBeNull();
    expect(chartLiqPrice({ ...iso, base_qty: "0.00000000" })).toBeNull();
    expect(chartLiqPrice({ ...iso, liq_price: null })).toBeNull();
    expect(chartLiqPrice({ ...iso, liq_price: "0.00000000" })).toBeNull();
  });
});
