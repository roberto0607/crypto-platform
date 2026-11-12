/**
 * Higher-timeframe values at lower-timeframe times (packages/indicators
 * htf.ts), on the committed Coinbase BTC-USD fixture: the value in force at
 * time t is the HTF bar that had CLOSED by t — never one still forming —
 * including at the exact instant a daily/weekly candle closes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeSMA, computeEMA, fixtureCandles, htfValueAt, htfStepSeries, htfFormingMovingAverage,
  computeMovingAverage, TIMEFRAME_SEC, type CandleFixture, type Point,
} from "../shared";

const dir = new URL("../../../../../packages/indicators/fixtures/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("btcusd-coinbase.json", dir), "utf8")) as CandleFixture;
const h4 = fixtureCandles(fixture.timeframes["4h"]!);
const times = h4.map((c) => c.time);
const DAY = TIMEFRAME_SEC["1d"];
const WEEK = TIMEFRAME_SEC["1w"];

describe.each([
  ["1d", DAY, "SMA", 200],
  ["1d", DAY, "EMA", 50],
  ["1w", WEEK, "SMA", 50],
] as const)("%s %s %i on 4h bars", (tf, sec, type, length) => {
  const htf = fixtureCandles(fixture.timeframes[tf]!);
  const pts = computeMovingAverage(htf, type, length);
  const byOpen = new Map(pts.map((p) => [p.time, p]));
  const step = htfStepSeries(pts, sec, times);

  it("uses the indicator the line is configured with", () => {
    expect(pts).toEqual(type === "SMA" ? computeSMA(htf, length) : computeEMA(htf, length));
  });

  it("each 4h bar shows the HTF bar that closed last by its open — never a later one", () => {
    expect(step.length).toBeGreaterThan(1000);
    for (const p of step) {
      // the source bar: the latest one whose close (open + sec) is <= the 4h open
      const src = [...pts].reverse().find((q) => q.time + sec <= p.time)!;
      expect(p.value).toBe(src.value);
      expect(src.time + sec).toBeLessThanOrEqual(p.time);
      const next = pts[pts.indexOf(src) + 1];
      if (next) expect(next.time + sec).toBeGreaterThan(p.time);
    }
  });

  it("switches exactly at the HTF close: the bar opening at the close has the just-closed value", () => {
    let boundaries = 0;
    for (let i = 1; i < step.length; i++) {
      const t = step[i]!.time;
      const closed = byOpen.get(t - sec);
      if (!closed) continue; // not an HTF boundary
      boundaries++;
      expect(step[i]!.value).toBe(closed.value);
      expect(htfValueAt(pts, sec, t)).toBe(closed.value);
      // one second earlier the bar was still forming: the previous one is in force
      const prev = byOpen.get(t - 2 * sec);
      expect(htfValueAt(pts, sec, t - 1)).toBe(prev ? prev.value : null);
      // the 4h bar before the boundary still shows the previous HTF value
      expect(step[i - 1]!.value).toBe(prev?.value);
    }
    expect(boundaries).toBeGreaterThan(tf === "1d" ? 200 : 30);
  });

  it("matches htfValueAt at every bar", () => {
    for (const p of step) expect(htfValueAt(pts, sec, p.time)).toBe(p.value);
  });

  it("adding a still-forming HTF bar changes nothing on bars already closed", () => {
    const last = htf.at(-1)!;
    const forming = { ...last, time: last.time + sec, close: last.close * 1.5 };
    const withForming = htfStepSeries(computeMovingAverage([...htf, forming], type, length), sec, times);
    expect(withForming).toEqual(step);
  });

  it("the forming value equals the bar's MA once it closes at that price", () => {
    const closed = htf.slice(0, -1);
    const last = htf.at(-1)!;
    expect(htfFormingMovingAverage(closed, sec, { type, length }, last.close)).toBeCloseTo(pts.at(-1)!.value, 9);
  });
});

describe("htfValueAt edges", () => {
  const pts: Point[] = [{ time: 0, value: 1 }, { time: DAY, value: 2 }];
  it("is null before the first HTF bar closes", () => {
    expect(htfValueAt(pts, DAY, DAY - 1)).toBeNull();
    expect(htfValueAt([], DAY, 10 * DAY)).toBeNull();
    expect(htfStepSeries(pts, DAY, [0, DAY - 1])).toEqual([]);
  });
  it("holds the last closed value after the data ends", () => {
    expect(htfValueAt(pts, DAY, 2 * DAY)).toBe(2);
    expect(htfValueAt(pts, DAY, 50 * DAY)).toBe(2);
  });
  it("forming value needs enough closed bars", () => {
    expect(htfFormingMovingAverage([], DAY, { type: "SMA", length: 2 }, 5)).toBeNull();
    const one = [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    expect(htfFormingMovingAverage(one, DAY, { type: "SMA", length: 3 }, 5)).toBeNull();
    expect(htfFormingMovingAverage(one, DAY, { type: "SMA", length: 2 }, 5)).toBe(3);
  });
});
