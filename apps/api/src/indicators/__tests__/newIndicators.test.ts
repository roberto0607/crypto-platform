/**
 * PR 1b indicators (shared source, API copy): SMA, Pine ATR, ADX/DI, UT Bot,
 * previous-period level series, swing points, warm-up metadata. Hand-worked
 * cases plus properties on the real BTC-USD fixture. TradingView reference
 * values are in tradingViewReference.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeSMA, computePineATR, computeATR, computeADX, computeUTBot, computeRSI, computeMACD, computeEMA,
  computeBollingerBands, prevPeriodHighLow, prevPeriodLevelSeries, findSwingPoints, WARMUP, firstRealTime,
  fixtureCandles, type Candle, type CandleFixture,
} from "../shared";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../packages/indicators/fixtures/btcusd-coinbase.json", import.meta.url), "utf8"),
) as CandleFixture;
const h4 = fixtureCandles(fixture.timeframes["4h"]!);
const d1 = fixtureCandles(fixture.timeframes["1d"]!);

const bar = (time: number, o: Partial<Candle> = {}): Candle => ({ time, open: 100, high: 100, low: 100, close: 100, volume: 1, ...o });

describe("computeSMA", () => {
  it("averages closes, first value at bar period-1, no padding", () => {
    const c = [1, 2, 3, 4, 5].map((close, i) => bar(i, { close }));
    expect(computeSMA(c, 3)).toEqual([{ time: 2, value: 2 }, { time: 3, value: 3 }, { time: 4, value: 4 }]);
    expect(computeSMA(c, 1).map((p) => p.value)).toEqual([1, 2, 3, 4, 5]);
    expect(computeSMA(c, 6)).toEqual([]);
  });

  it("any length: SMA 200 on 4h BTC matches a direct average", () => {
    const sma = computeSMA(h4, 200);
    expect(sma.length).toBe(h4.length - 199);
    const tail = h4.slice(-200).reduce((s, c) => s + c.close, 0) / 200;
    expect(sma[sma.length - 1]!.value).toBeCloseTo(tail, 9);
  });
});

describe("computePineATR", () => {
  it("seeds with the average of TR[0..p-1] (TR[0] = high - low) at bar p-1", () => {
    const c = [
      bar(0, { high: 12, low: 10, close: 11 }), // TR 2
      bar(1, { high: 15, low: 11, close: 14 }), // TR max(4, 4, 0) = 4
      bar(2, { high: 14, low: 8, close: 9 }), //  TR max(6, 0, 6) = 6
      bar(3, { high: 10, low: 9, close: 10 }), // TR max(1, 1, 0) = 1
    ];
    const atr = computePineATR(c, 3);
    expect(atr.map((p) => p.time)).toEqual([2, 3]);
    expect(atr[0]!.value).toBeCloseTo(4, 12);
    expect(atr[1]!.value).toBeCloseTo((4 * 2 + 1) / 3, 12);
  });

  it("differs from the chart's computeATR only by seeding: converged on a long series", () => {
    const pine = computePineATR(h4, 14);
    const chart = computeATR(h4, 14);
    expect(pine[0]!.value).not.toBeCloseTo(chart[14]!.value, 2);
    const a = pine[pine.length - 1]!.value;
    const b = chart[chart.length - 1]!.value;
    expect(Math.abs(a - b) / a).toBeLessThan(1e-12);
  });
});

describe("computeADX", () => {
  // Steady uptrend: up = 1, down = -1 → +DM 1, -DM 0, TR 2 → +DI 50, -DI 0, DX 1 → ADX 100.
  const trend = Array.from({ length: 40 }, (_, i) => bar(i, { high: i + 2, low: i, close: i + 1 }));

  it("+DI 50, -DI 0, ADX 100 on a steady uptrend; DI from bar 14, ADX from bar 27", () => {
    const { plusDI, minusDI, adx } = computeADX(trend);
    expect(plusDI[0]!.time).toBe(14);
    expect(adx[0]!.time).toBe(27);
    for (const p of plusDI) expect(p.value).toBeCloseTo(50, 9);
    for (const p of minusDI) expect(p.value).toBe(0);
    for (const p of adx) expect(p.value).toBeCloseTo(100, 9);
  });

  it("stays within 0..100 on real data", () => {
    const { plusDI, minusDI, adx } = computeADX(h4);
    expect(adx.length).toBe(h4.length - 27);
    for (const s of [plusDI, minusDI, adx]) for (const p of s) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
  });
});

describe("computeUTBot", () => {
  it("signals alternate, fire on a close crossing the previous stop, and sit on the right side of the stop", () => {
    const { stop, signals } = computeUTBot(h4);
    expect(stop[0]!.time).toBe(h4[9]!.time);
    expect(signals.length).toBeGreaterThan(10);
    const stopAt = new Map(stop.map((p) => [p.time, p.value]));
    for (let k = 0; k < signals.length; k++) {
      const s = signals[k]!;
      if (k > 0) expect(s.side).not.toBe(signals[k - 1]!.side);
      const prevClose = h4[s.index - 1]!.close;
      const prevStop = stopAt.get(h4[s.index - 1]!.time)!;
      if (s.side === "buy") {
        expect(s.price).toBeGreaterThan(stopAt.get(s.time)!);
        expect(prevClose).toBeLessThanOrEqual(prevStop);
      } else {
        expect(s.price).toBeLessThan(stopAt.get(s.time)!);
        expect(prevClose).toBeGreaterThanOrEqual(prevStop);
      }
    }
  });

  it("never signals on a forming bar, and signals are stable as bars are added", () => {
    const full = computeUTBot(h4).signals;
    const last = full[full.length - 1]!;
    const upToSignal = h4.slice(0, last.index + 1);
    expect(computeUTBot(upToSignal).signals.at(-1)).toEqual(last);
    const forming = computeUTBot(upToSignal, { lastIsForming: true });
    expect(forming.signals.at(-1)?.index).not.toBe(last.index);
    expect(forming.stop.length).toBe(computeUTBot(upToSignal).stop.length);
    // Signals never change once their bar has closed.
    for (const cut of [300, 800, 1200]) {
      const early = computeUTBot(h4.slice(0, cut)).signals;
      expect(full.slice(0, early.length)).toEqual(early);
    }
  });
});

describe("prevPeriodLevelSeries", () => {
  it.each([
    ["4h", "day", 14_400],
    ["4h", "week", 14_400],
    ["1d", "day", 86_400],
    ["1d", "week", 86_400],
  ] as const)("%s %s: equals prevPeriodHighLow at every bar once the previous period is fully loaded", (tf, period, candleSec) => {
    const candles = tf === "4h" ? h4 : d1;
    const series = prevPeriodLevelSeries(candles, { candleSec, period });
    const byTime = new Map(series.high.map((p, k) => [p.time, [p.value, series.low[k]!.value]]));
    let emitted = 0;
    for (let i = 0; i < candles.length; i++) {
      const got = byTime.get(candles[i]!.time);
      if (!got) { expect(emitted).toBe(0); continue; } // only the leading partial period is skipped
      emitted++;
      const lv = prevPeriodHighLow(candles.slice(0, i + 1), { candleSec, period })!;
      expect(got).toEqual([lv.pdh, lv.pdl]);
    }
    expect(emitted).toBeGreaterThan(candles.length - (period === "week" ? 14 * 42 : 12));
  });

  it("skips a partially loaded previous period", () => {
    // Data starts at 12:00 on day 0: day 0 is partial, so no PDH until day 2.
    const c = Array.from({ length: 16 }, (_, k) => bar(43_200 + k * 14_400, { high: 100 + k, low: 90 - k }));
    const s = prevPeriodLevelSeries(c, { candleSec: 14_400, period: "day" });
    expect(s.high[0]!.time).toBe(86_400 * 2 - 14_400); // last bar of day 1 (its close starts day 2)
    expect(s.high[0]!.value).toBe(100 + 8); // day 1 = bars 3..8
    expect(s.low[0]!.value).toBe(90 - 8);
  });
});

describe("findSwingPoints", () => {
  it("strict pivots with their confirmation bar", () => {
    const highs = [1, 2, 5, 2, 1, 0, 1, 5, 5, 1, 0, 0];
    const c = highs.map((h, i) => bar(i * 10, { high: h, low: h - 0.5 }));
    const { highs: sh, lows: sl } = findSwingPoints(c, { left: 2, right: 2 });
    // index 2 (5) confirms at bar 4; 7 and 8 tie at 5, so neither is a swing high.
    expect(sh).toEqual([{ index: 2, time: 20, price: 5, confirmedIndex: 4, confirmedTime: 40 }]);
    expect(sl).toEqual([{ index: 5, time: 50, price: -0.5, confirmedIndex: 7, confirmedTime: 70 }]);
  });

  it("matches liquidityZones' previous private pivot finder (lookback 3) on real data", () => {
    // The pre-refactor findSwingPoints from market/liquidityZones.ts, verbatim.
    const legacy = (candles: Candle[], lookback: number) => {
      const highs: number[] = [];
      const lows: number[] = [];
      for (let i = lookback; i < candles.length - lookback; i++) {
        let isHigh = true;
        let isLow = true;
        const c = candles[i]!;
        for (let j = 1; j <= lookback; j++) {
          if (candles[i - j]!.high >= c.high || candles[i + j]!.high >= c.high) isHigh = false;
          if (candles[i - j]!.low <= c.low || candles[i + j]!.low <= c.low) isLow = false;
        }
        if (isHigh) highs.push(c.high);
        if (isLow) lows.push(c.low);
      }
      return { highs, lows };
    };
    for (const candles of [h4, d1, h4.slice(-100)]) {
      const s = findSwingPoints(candles, { left: 3, right: 3 });
      expect({ highs: s.highs.map((p) => p.price), lows: s.lows.map((p) => p.price) }).toEqual(legacy(candles, 3));
    }
  });
});

describe("WARMUP", () => {
  it("unpadded series start exactly at their first real bar", () => {
    const at = (i: number) => firstRealTime(h4, i);
    expect(computeSMA(h4, 50)[0]!.time).toBe(at(WARMUP.sma(50)));
    expect(computeEMA(h4, 200)[0]!.time).toBe(at(WARMUP.ema(200)));
    expect(computeBollingerBands(h4).middle[0]!.time).toBe(at(WARMUP.bollinger()));
    expect(computePineATR(h4, 10)[0]!.time).toBe(at(WARMUP.pineAtr(10)));
    const adx = computeADX(h4);
    expect(adx.plusDI[0]!.time).toBe(at(WARMUP.di()));
    expect(adx.adx[0]!.time).toBe(at(WARMUP.adx()));
    const ut = computeUTBot(h4);
    expect(ut.stop[0]!.time).toBe(at(WARMUP.utBotStop()));
    expect(ut.signals[0]!.index).toBeGreaterThanOrEqual(WARMUP.utBotSignals());
    expect(findSwingPoints(h4).highs[0]!.confirmedIndex).toBeGreaterThanOrEqual(WARMUP.swings());
  });

  it("padded series (RSI, chart ATR, MACD) repeat the first real value before it", () => {
    const check = (values: number[], first: number) => {
      for (let i = 0; i < first; i++) expect(values[i]).toBe(values[first]);
      expect(values[first + 1]).not.toBe(values[first]);
    };
    check(computeRSI(h4, 14).map((p) => p.value), WARMUP.rsi(14));
    check(computeATR(h4, 14).map((p) => p.value), WARMUP.atr(14));
    check(computeMACD(h4).macd.map((p) => p.value), WARMUP.macd());
    // The padding really is padding: RSI with bar 0 changed differs from bar `period` on...
    const shifted = h4.map((c, i) => (i === 0 ? { ...c, close: c.close * 1.5 } : c));
    expect(computeRSI(shifted, 14)[13]!.value).toBe(computeRSI(shifted, 14)[14]!.value);
  });

  it("VWAP is real from the first full UTC day", () => {
    expect(WARMUP.vwap(h4)).toBe(0); // fixture starts at midnight
    expect(WARMUP.vwap(h4.slice(2))).toBe(4); // 08:00 start → next midnight is 4 bars on
    expect(WARMUP.vwap([])).toBe(-1);
    expect(firstRealTime(h4, 10_000)).toBeNull();
  });
});
