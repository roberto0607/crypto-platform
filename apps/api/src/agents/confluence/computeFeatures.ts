/**
 * The candle-derived and calendar features at one closed 4h bar, computed
 * once over a candle history with the shared indicator math
 * (packages/indicators). The backfill (featureRowAt over the full history)
 * and the live recorder (featureRowAtClose on what it loaded at the close)
 * use the same code, and the test checks they give identical rows.
 *
 * No lookahead, by construction:
 * - 4h values at bar k depend on bars 0..k only (all causal indicators).
 * - Daily/weekly values are those of the last HTF bar CLOSED by bar k's close
 *   (open + tf <= close instant); a bar whose indicator is still in warm-up
 *   gives NULL, never an older value.
 * - 1D/1W S/R levels: srHtfLevelsAt — only levels and touches confirmed by
 *   HTF bars closed by then, no later break.
 * - ATR % rank compares with STRICTLY earlier bars.
 */
import {
  computeADX,
  computeMACD,
  computePineATR,
  computeRSI,
  computeSMA,
  computeSupportResistance,
  htfValueAt,
  prevPeriodLevelSeries,
  srHtfLevelsAt,
  WARMUP,
  type Candle,
  type Point,
  type SRLevel,
} from "../../indicators/shared";
import { computeCVD } from "../../indicators/cvd";
import { eventFeaturesAt } from "./eventCalendar";
import type { FeatureValues, NumFeature, BoolFeature } from "./featureColumns";
import { FEATURE_PARAMS as P } from "./featureParams";
import { closedBy } from "./featureCandles";

const H4 = 14_400;
const D1 = 86_400;
const W1 = 604_800;

export interface FeatureCandles {
  h4: Candle[];
  d1: Candle[];
  w1: Candle[];
}

/** One closed 4h bar's features. `missing` = reason for each NULL computed here. */
export interface FeatureRow {
  barTime: number;
  closeTime: number;
  close: number;
  atr14_4h: number | null;
  values: FeatureValues;
  missing: Record<string, string>;
}

type ValueMap = Map<number, number>;

interface HtfSeries {
  sec: number;
  /** Bar open times as points (value = time), for "which bar is in force". */
  times: Point[];
  close: ValueMap;
  sma: Record<number, ValueMap>;
  rsi: ValueMap;
  macdHist: ValueMap;
  atr: ValueMap;
  adx: ValueMap;
  diDiff: ValueMap;
  sr: SRLevel[];
  barTimes: number[];
}

export interface FeatureSeries {
  candles: FeatureCandles;
  atr: Float64Array;
  rsi: Float64Array;
  macdHist: Float64Array;
  adx: Float64Array;
  diDiff: Float64Array;
  atrPct: Float64Array;
  cvd: Float64Array;
  pdh: Float64Array;
  pdl: Float64Array;
  pwh: Float64Array;
  pwl: Float64Array;
  daily: HtfSeries;
  weekly: HtfSeries;
}

const toMap = (pts: Point[], firstReal = -1, cs?: Candle[]): ValueMap => {
  const minTime = firstReal >= 0 && cs ? (cs[firstReal]?.time ?? Infinity) : -Infinity;
  return new Map(pts.filter((p) => p.time >= minTime && Number.isFinite(p.value)).map((p) => [p.time, p.value]));
};

function align(h4: Candle[], pts: Point[], firstReal = 0): Float64Array {
  const index = new Map(h4.map((c, i) => [c.time, i]));
  const out = new Float64Array(h4.length).fill(NaN);
  for (const p of pts) {
    const i = index.get(p.time);
    if (i !== undefined && i >= firstReal) out[i] = p.value;
  }
  return out;
}

function htfSeries(cs: Candle[], sec: number, smaPeriods: readonly number[], sr: { left: number; right: number }): HtfSeries {
  const adx = computeADX(cs, P.adx);
  const plus = toMap(adx.plusDI);
  const minus = toMap(adx.minusDI);
  const diDiff: ValueMap = new Map();
  for (const [t, v] of plus) {
    const m = minus.get(t);
    if (m !== undefined) diDiff.set(t, v - m);
  }
  const sma: Record<number, ValueMap> = {};
  for (const p of smaPeriods) sma[p] = toMap(computeSMA(cs, p));
  return {
    sec,
    times: cs.map((c) => ({ time: c.time, value: c.time })),
    close: new Map(cs.map((c) => [c.time, c.close])),
    sma,
    rsi: toMap(computeRSI(cs, P.rsiPeriod), WARMUP.rsi(P.rsiPeriod), cs),
    macdHist: toMap(computeMACD(cs, P.macd.fast, P.macd.slow, P.macd.signal).histogram, WARMUP.macd(P.macd.fast, P.macd.slow, P.macd.signal), cs),
    atr: toMap(computePineATR(cs, P.atrPeriod)),
    adx: toMap(adx.adx),
    diDiff,
    sr: computeSupportResistance(cs, { left: sr.left, right: sr.right }),
    barTimes: cs.map((c) => c.time),
  };
}

export function buildFeatureSeries(candles: FeatureCandles): FeatureSeries {
  const { h4 } = candles;
  const atr = align(h4, computePineATR(h4, P.atrPeriod));
  const adx = computeADX(h4, P.adx);
  const plus = align(h4, adx.plusDI);
  const minus = align(h4, adx.minusDI);
  const day = prevPeriodLevelSeries(h4, { candleSec: H4, period: "day" });
  const week = prevPeriodLevelSeries(h4, { candleSec: H4, period: "week" });
  // Proxy CVD only: strip any side volume so the history and live rows match.
  const cvdPts = computeCVD(h4.map(({ buyVolume: _b, sellVolume: _s, ...c }) => c)).values;
  return {
    candles,
    atr,
    rsi: align(h4, computeRSI(h4, P.rsiPeriod), WARMUP.rsi(P.rsiPeriod)),
    macdHist: align(h4, computeMACD(h4, P.macd.fast, P.macd.slow, P.macd.signal).histogram, WARMUP.macd(P.macd.fast, P.macd.slow, P.macd.signal)),
    adx: align(h4, adx.adx),
    diDiff: plus.map((v, i) => v - minus[i]!),
    atrPct: atr.map((v, i) => v / h4[i]!.close),
    cvd: Float64Array.from(cvdPts.map((p) => p.value)),
    pdh: align(h4, day.high),
    pdl: align(h4, day.low),
    pwh: align(h4, week.high),
    pwl: align(h4, week.low),
    daily: htfSeries(candles.d1, D1, P.dailySma, P.sr1d),
    weekly: htfSeries(candles.w1, W1, P.weeklySma, P.sr1w),
  };
}

const num = (v: number | undefined): number | null => (v === undefined || !Number.isFinite(v) ? null : v);

/** Nearest support / resistance distance in ATR (0 inside a zone), capped; none on a side = the cap. */
function levelDistances(levels: SRLevel[], close: number, atr: number): { sup: number; res: number } {
  let sup = Infinity;
  let res = Infinity;
  for (const l of levels) {
    if (l.role === "support" && l.bottom < close) sup = Math.min(sup, Math.max(0, close - l.top) / atr);
    if (l.role === "resistance" && l.top > close) res = Math.min(res, Math.max(0, l.bottom - close) / atr);
  }
  return { sup: Math.min(sup, P.levelCapAtr), res: Math.min(res, P.levelCapAtr) };
}

/** Index of the first 4h bar with time >= t (binary search). */
function firstAtOrAfter(h4: Candle[], t: number): number {
  let lo = 0;
  let hi = h4.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h4[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function featureRowAt(series: FeatureSeries, k: number): FeatureRow {
  const { h4 } = series.candles;
  const bar = h4[k];
  if (!bar) throw new Error(`featureRowAt: no 4h bar at index ${k}`);
  const closeTime = bar.time + H4;
  const close = bar.close;
  const values: FeatureValues = {};
  const missing: Record<string, string> = {};
  const setNum = (name: NumFeature, v: number | null, reason = "warmup") => {
    values[name] = v;
    if (v === null) missing[name] = reason;
  };
  const setBool = (name: BoolFeature, v: boolean | null, reason: string) => {
    values[name] = v;
    if (v === null) missing[name] = reason;
  };
  const atr = num(series.atr[k]);
  const perAtr = (v: number | null) => (v === null || atr === null ? null : v / atr);

  // ── Higher-timeframe helpers: the bar in force at the close, and its value. ──
  const inForce = (s: HtfSeries) => htfValueAt(s.times, s.sec, closeTime);
  const dT = inForce(series.daily);
  const wT = inForce(series.weekly);
  const htf = (s: HtfSeries, t: number | null, m: ValueMap) => (t === null ? null : num(m.get(t)));
  const slope = (s: HtfSeries, t: number | null, period: number, n: number): { v: number | null; reason: string } => {
    if (t === null) return { v: null, reason: "warmup" };
    const now = s.sma[period]!.get(t);
    if (now === undefined) return { v: null, reason: "warmup" };
    const before = s.sma[period]!.get(t - n * s.sec);
    if (before === undefined) return { v: null, reason: s.sma[period]!.size > 0 && t - n * s.sec >= Math.min(...s.sma[period]!.keys()) ? "gap" : "warmup" };
    return { v: now / before - 1, reason: "" };
  };

  // ── Trend ──
  const dist = (sma: number | null) => (sma === null ? null : Math.log(close / sma));
  setNum("t_w_sma20_dist", dist(htf(series.weekly, wT, series.weekly.sma[20]!)));
  setNum("t_w_sma50_dist", dist(htf(series.weekly, wT, series.weekly.sma[50]!)));
  setNum("t_w_sma200_dist", dist(htf(series.weekly, wT, series.weekly.sma[200]!)));
  setNum("t_d_sma50_dist", dist(htf(series.daily, dT, series.daily.sma[50]!)));
  setNum("t_d_sma200_dist", dist(htf(series.daily, dT, series.daily.sma[200]!)));
  for (const [name, s, t, p, n] of [
    ["t_w_sma20_slope", series.weekly, wT, 20, P.weeklySlopeBars],
    ["t_w_sma50_slope", series.weekly, wT, 50, P.weeklySlopeBars],
    ["t_w_sma200_slope", series.weekly, wT, 200, P.weeklySlopeBars],
    ["t_d_sma50_slope", series.daily, dT, 50, P.dailySlopeBars],
    ["t_d_sma200_slope", series.daily, dT, 200, P.dailySlopeBars],
  ] as const) {
    const r = slope(s, t, p, n);
    setNum(name, r.v, r.reason);
  }

  // ── Momentum ──
  setNum("m_rsi14_4h", num(series.rsi[k]));
  setNum("m_rsi14_1d", htf(series.daily, dT, series.daily.rsi));
  setNum("m_macd_hist_atr_4h", perAtr(num(series.macdHist[k])));
  const histD = htf(series.daily, dT, series.daily.macdHist);
  const atrD = htf(series.daily, dT, series.daily.atr);
  setNum("m_macd_hist_atr_1d", histD === null || atrD === null ? null : histD / atrD);

  // ── Location ──
  if (atr === null) {
    for (const n of ["l_sup_1d_atr", "l_res_1d_atr", "l_sup_1w_atr", "l_res_1w_atr", "l_room_long_r", "l_room_short_r"] as const) setNum(n, null);
  } else {
    const active = (s: HtfSeries) => srHtfLevelsAt(s.sr, s.barTimes, s.sec, closeTime).filter((l) => l.brokenIndex === null);
    const d = levelDistances(active(series.daily), close, atr);
    const w = levelDistances(active(series.weekly), close, atr);
    setNum("l_sup_1d_atr", d.sup);
    setNum("l_res_1d_atr", d.res);
    setNum("l_sup_1w_atr", w.sup);
    setNum("l_res_1w_atr", w.res);
    setNum("l_room_long_r", Math.min(d.res, w.res) / P.stopAtr);
    setNum("l_room_short_r", Math.min(d.sup, w.sup) / P.stopAtr);
  }
  const signed = (lvl: number) => (Number.isFinite(lvl) ? perAtr(lvl - close) : null);
  setNum("l_pdh_atr", signed(series.pdh[k]!));
  setNum("l_pdl_atr", signed(series.pdl[k]!));
  setNum("l_pwh_atr", signed(series.pwh[k]!));
  setNum("l_pwl_atr", signed(series.pwl[k]!));

  // ── Volatility / regime ──
  setNum("v_atr_pct_4h", atr === null ? null : atr / close);
  const closeD = htf(series.daily, dT, series.daily.close);
  setNum("v_atr_pct_1d", atrD === null || closeD === null ? null : atrD / closeD);
  {
    const now = series.atrPct[k]!;
    const windowStart = closeTime - P.atrRankWindowSec;
    if (!Number.isFinite(now) || windowStart < h4[0]!.time) {
      setNum("v_atr_pct_rank_1y", null, "warmup");
    } else {
      let below = 0;
      let equal = 0;
      let n = 0;
      for (let i = firstAtOrAfter(h4, windowStart); i < k; i++) {
        const v = series.atrPct[i]!;
        if (!Number.isFinite(v)) continue;
        n++;
        if (v < now) below++;
        else if (v === now) equal++;
      }
      const expected = P.atrRankWindowSec / H4 - 1;
      setNum("v_atr_pct_rank_1y", n >= P.atrRankMinCoverage * expected ? (below + 0.5 * equal) / n : null, "coverage");
    }
  }
  setNum("v_adx_4h", num(series.adx[k]));
  setNum("v_adx_1d", htf(series.daily, dT, series.daily.adx));
  setNum("v_di_diff_4h", num(series.diDiff[k]));
  setNum("v_di_diff_1d", htf(series.daily, dT, series.daily.diDiff));

  // ── Order flow: proxy CVD, net delta ÷ volume over a trailing window ──
  for (const [name, sec] of [["f_cvd_proxy_24h", P.cvdShortSec], ["f_cvd_proxy_7d", P.cvdLongSec]] as const) {
    const start = closeTime - sec;
    if (start < h4[0]!.time) {
      setNum(name, null, "warmup");
      continue;
    }
    const j = firstAtOrAfter(h4, start);
    const bars = k - j + 1;
    if (bars < 0.9 * (sec / H4)) {
      setNum(name, null, "gap");
      continue;
    }
    let vol = 0;
    for (let i = j; i <= k; i++) vol += h4[i]!.volume;
    const delta = series.cvd[k]! - (j > 0 ? series.cvd[j - 1]! : 0);
    setNum(name, vol > 0 ? delta / vol : null, "no_volume");
  }

  // ── Events ──
  const ev = eventFeaturesAt(closeTime);
  setNum("e_hours_to_fomc", ev.e_hours_to_fomc, "calendar");
  setNum("e_hours_since_fomc", ev.e_hours_since_fomc, "calendar");
  setBool("e_fomc_within_7d", ev.e_fomc_within_7d, "calendar");
  setNum("e_hours_to_cpi", ev.e_hours_to_cpi, "calendar");
  setNum("e_hours_since_cpi", ev.e_hours_since_cpi, "calendar");
  setBool("e_cpi_within_7d", ev.e_cpi_within_7d, "calendar");

  return { barTime: bar.time, closeTime, close, atr14_4h: atr, values, missing };
}

/**
 * The live path: the row for the 4h bar that closed at `closeTime`, from
 * candles as loaded at that moment (anything not closed by then is dropped
 * first). null when no 4h bar closes exactly then (a gap in the 1h data).
 */
export function featureRowAtClose(candles: FeatureCandles, closeTime: number): FeatureRow | null {
  const known: FeatureCandles = {
    h4: closedBy(candles.h4, H4, closeTime),
    d1: closedBy(candles.d1, D1, closeTime),
    w1: closedBy(candles.w1, W1, closeTime),
  };
  const k = known.h4.length - 1;
  if (k < 0 || known.h4[k]!.time + H4 !== closeTime) return null;
  return featureRowAt(buildFeatureSeries(known), k);
}
