/**
 * Candle-derived features on real Coinbase BTC-USD candles (the shared
 * indicator fixture) plus a long synthetic series for the 1-year windows:
 * values come from the shared indicator math, and nothing in a row depends
 * on data after its bar's close.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeADX, computeMACD, computePineATR, computeRSI, computeSMA, fixtureCandles, htfValueAt, prevPeriodLevelSeries,
  type Candle, type CandleFixture,
} from "../../../indicators/shared";
import { computeCVD } from "../../../indicators/cvd";
import { buildFeatureSeries, featureRowAt, featureRowAtClose, type FeatureCandles } from "../computeFeatures";
import { FEATURE_PARAMS as P } from "../featureParams";

const H4 = 14_400;
const D1 = 86_400;
const W1 = 604_800;

const fixture = JSON.parse(
  readFileSync(new URL("../../../../../../packages/indicators/fixtures/btcusd-coinbase.json", import.meta.url), "utf8"),
) as CandleFixture;
const candles: FeatureCandles = {
  h4: fixtureCandles(fixture.timeframes["4h"]!),
  d1: fixtureCandles(fixture.timeframes["1d"]!),
  w1: fixtureCandles(fixture.timeframes["1w"]!),
};
const series = buildFeatureSeries(candles);
const last = candles.h4.length - 1;
const at = (pts: { time: number; value: number }[], time: number) => pts.find((p) => p.time === time)?.value ?? null;

function knownAt(cs: FeatureCandles, k: number): FeatureCandles {
  const t = cs.h4[k]!.time + H4;
  return {
    h4: cs.h4.slice(0, k + 1),
    d1: cs.d1.filter((c) => c.time + D1 <= t),
    w1: cs.w1.filter((c) => c.time + W1 <= t),
  };
}

/** Deterministic random walk: hourly-ish 4h bars, daily and weekly built from them. */
function synthetic(days: number): FeatureCandles {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const start = Date.parse("2019-01-07T00:00:00Z") / 1000; // a Monday
  const h4: Candle[] = [];
  let px = 10_000;
  for (let i = 0; i < days * 6; i++) {
    const o = px;
    const cl = o * (1 + (rnd() - 0.5) * 0.03 * (1 + Math.sin(i / 400)));
    const hi = Math.max(o, cl) * (1 + rnd() * 0.01);
    const lo = Math.min(o, cl) * (1 - rnd() * 0.01);
    h4.push({ time: start + i * H4, open: o, high: hi, low: lo, close: cl, volume: 100 + rnd() * 50 });
    px = cl;
  }
  const group = (sec: number, n: number): Candle[] => {
    const out: Candle[] = [];
    for (let i = 0; i + n <= h4.length; i += n) {
      const b = h4.slice(i, i + n);
      out.push({ time: b[0]!.time, open: b[0]!.open, high: Math.max(...b.map((x) => x.high)), low: Math.min(...b.map((x) => x.low)), close: b[n - 1]!.close, volume: b.reduce((s, x) => s + x.volume, 0) });
    }
    void sec;
    return out;
  };
  return { h4, d1: group(D1, 6), w1: group(W1, 42) };
}

describe("featureRowAt on the fixture", () => {
  const row = featureRowAt(series, last);
  const closeTime = candles.h4[last]!.time + H4;
  const close = candles.h4[last]!.close;
  const atr = at(computePineATR(candles.h4, 14), candles.h4[last]!.time)!;

  it("is stamped with the bar's open and close times", () => {
    expect(row.barTime).toBe(candles.h4[last]!.time);
    expect(row.closeTime).toBe(closeTime);
    expect(row.close).toBe(close);
    expect(row.atr14_4h).toBeCloseTo(atr, 9);
  });

  it("trend: log distance to weekly/daily SMAs in force at the close, and their slopes", () => {
    const w200 = htfValueAt(computeSMA(candles.w1, 200), W1, closeTime)!;
    const d50 = htfValueAt(computeSMA(candles.d1, 50), D1, closeTime)!;
    expect(row.values.t_w_sma200_dist).toBeCloseTo(Math.log(close / w200), 12);
    expect(row.values.t_d_sma50_dist).toBeCloseTo(Math.log(close / d50), 12);
    const w20 = computeSMA(candles.w1, 20);
    const iw = w20.findIndex((p) => p.value === htfValueAt(w20, W1, closeTime));
    expect(row.values.t_w_sma20_slope).toBeCloseTo(w20[iw]!.value / w20[iw - P.weeklySlopeBars]!.value - 1, 12);
  });

  it("momentum: RSI 14 and MACD histogram ÷ ATR on 4h and the last closed day", () => {
    expect(row.values.m_rsi14_4h).toBeCloseTo(at(computeRSI(candles.h4, 14), candles.h4[last]!.time)!, 12);
    expect(row.values.m_rsi14_1d).toBeCloseTo(htfValueAt(computeRSI(candles.d1, 14), D1, closeTime)!, 12);
    const hist = at(computeMACD(candles.h4).histogram, candles.h4[last]!.time)!;
    expect(row.values.m_macd_hist_atr_4h).toBeCloseTo(hist / atr, 12);
    const histD = htfValueAt(computeMACD(candles.d1).histogram, D1, closeTime)!;
    const atrD = htfValueAt(computePineATR(candles.d1, 14), D1, closeTime)!;
    expect(row.values.m_macd_hist_atr_1d).toBeCloseTo(histD / atrD, 12);
  });

  it("location: PDH/PDL/PWH/PWL signed distance in ATR; level distances non-negative and capped", () => {
    const pdh = at(prevPeriodLevelSeries(candles.h4, { candleSec: H4, period: "day" }).high, candles.h4[last]!.time)!;
    expect(row.values.l_pdh_atr).toBeCloseTo((pdh - close) / atr, 12);
    for (const k of ["l_sup_1d_atr", "l_res_1d_atr", "l_sup_1w_atr", "l_res_1w_atr"] as const) {
      const v = row.values[k] as number;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(P.levelCapAtr);
    }
    const nearestRes = Math.min(row.values.l_res_1d_atr as number, row.values.l_res_1w_atr as number);
    expect(row.values.l_room_long_r).toBeCloseTo(nearestRes / P.stopAtr, 12);
  });

  it("volatility: ATR %, ADX and DI difference on 4h and 1D", () => {
    expect(row.values.v_atr_pct_4h).toBeCloseTo(atr / close, 12);
    const adx = computeADX(candles.h4, P.adx);
    expect(row.values.v_adx_4h).toBeCloseTo(at(adx.adx, candles.h4[last]!.time)!, 12);
    expect(row.values.v_di_diff_4h).toBeCloseTo(at(adx.plusDI, candles.h4[last]!.time)! - at(adx.minusDI, candles.h4[last]!.time)!, 12);
    const adxD = computeADX(candles.d1, P.adx);
    expect(row.values.v_adx_1d).toBeCloseTo(htfValueAt(adxD.adx, D1, closeTime)!, 12);
  });

  it("ATR % rank needs a full year of 4h bars: the fixture has ~280 days, so it is null (warm-up)", () => {
    expect(row.values.v_atr_pct_rank_1y).toBeNull();
    expect(row.missing.v_atr_pct_rank_1y).toBe("warmup");
  });

  it("ATR % rank is null for 'coverage' when the year exists but too many 4h bars are missing", () => {
    const k = 2_400;
    const syn = synthetic(500);
    // drop 15% of the year before bar k
    const holed = { ...syn, h4: syn.h4.filter((_, i) => i >= k || i < k - 2_190 || i % 7 !== 0) };
    const s = buildFeatureSeries(holed);
    const kk = holed.h4.findIndex((c) => c.time === syn.h4[k]!.time);
    const r = featureRowAt(s, kk);
    expect(r.values.v_atr_pct_rank_1y).toBeNull();
    expect(r.missing.v_atr_pct_rank_1y).toBe("coverage");
  });

  it("order flow: proxy CVD as net delta ÷ volume over the last 24h and 7d", () => {
    const cvd = computeCVD(candles.h4).values;
    const vol = (n: number) => candles.h4.slice(last - n + 1).reduce((s, c) => s + c.volume, 0);
    expect(row.values.f_cvd_proxy_24h).toBeCloseTo((cvd[last]!.value - cvd[last - 6]!.value) / vol(6), 9);
    expect(row.values.f_cvd_proxy_7d).toBeCloseTo((cvd[last]!.value - cvd[last - 42]!.value) / vol(42), 9);
  });

  it("events come from the calendar at the close instant", () => {
    expect(row.values.e_hours_to_fomc).not.toBeNull();
    expect(typeof row.values.e_cpi_within_7d).toBe("boolean");
  });
});

describe("warm-up", () => {
  it("the first 4h bar has nulls with a warm-up reason, never a made-up value", () => {
    const row = featureRowAt(series, 0);
    expect(row.values.m_rsi14_4h).toBeNull();
    expect(row.missing.m_rsi14_4h).toBe("warmup");
    expect(row.values.m_macd_hist_atr_4h).toBeNull();
    expect(row.values.f_cvd_proxy_7d).toBeNull();
  });
});

describe("no lookahead", () => {
  it("a row built from only the data known at bar k's close is identical (fixture, several bars)", () => {
    for (const k of [60, 400, 900, last - 7, last]) {
      expect(featureRowAtClose(knownAt(candles, k), candles.h4[k]!.time + H4)).toEqual(featureRowAt(series, k));
    }
  });

  it("the same on a 2-year synthetic series where the 1-year ATR rank is defined", () => {
    const syn = synthetic(730);
    const s = buildFeatureSeries(syn);
    const k = syn.h4.length - 1;
    const row = featureRowAt(s, k);
    expect(row.values.v_atr_pct_rank_1y).not.toBeNull();
    expect(row.values.v_atr_pct_rank_1y!).toBeGreaterThanOrEqual(0);
    expect(row.values.v_atr_pct_rank_1y!).toBeLessThanOrEqual(1);
    expect(featureRowAtClose(knownAt(syn, k), syn.h4[k]!.time + H4)).toEqual(row);
    const mid = Math.floor(k * 0.7);
    expect(featureRowAtClose(knownAt(syn, mid), syn.h4[mid]!.time + H4)).toEqual(featureRowAt(s, mid));
  });

  it("featureRowAtClose returns null when no 4h bar closes at that instant", () => {
    expect(featureRowAtClose(candles, candles.h4[last]!.time + H4 + 60)).toBeNull();
  });
});

describe("ATR % rank", () => {
  it("is the share of the prior year's 4h ATR % below the current one (ties count half)", () => {
    const syn = synthetic(730);
    const s = buildFeatureSeries(syn);
    const k = syn.h4.length - 1;
    const atr = computePineATR(syn.h4, 14);
    const pct = new Map(atr.map((p) => [p.time, p.value / syn.h4.find((c) => c.time === p.time)!.close]));
    const now = pct.get(syn.h4[k]!.time)!;
    const windowStart = syn.h4[k]!.time + H4 - P.atrRankWindowSec;
    const prior = syn.h4.filter((c) => c.time >= windowStart && c.time < syn.h4[k]!.time).map((c) => pct.get(c.time)!);
    const rank = (prior.filter((v) => v < now).length + 0.5 * prior.filter((v) => v === now).length) / prior.length;
    expect(featureRowAt(s, k).values.v_atr_pct_rank_1y).toBeCloseTo(rank, 12);
  });
});
