/**
 * The scorecard rule, the backtest and the Phase 3 bar.
 */
import { describe, it, expect } from "vitest";
import { buildScorecard, decide, vote, type Scorecard } from "../scorecard";
import { runBacktest } from "../backtest";
import { runStudy } from "../study";
import { evaluateFeatures, FULL_RULES, type FeatureResult } from "../evaluate";
import { syntheticData } from "./synthetic";

const voter = (name: string, longTercile: 0 | 2 | null, shortTercile: 0 | 2 | null) => ({ name, cuts: [-1, 1] as [number, number], longTercile, shortTercile });

describe("vote / decide", () => {
  const card: Scorecard = {
    voters: [voter("a", 2, 0), voter("b", 2, null), voter("c", 0, 2), voter("d", 2, 0)],
    gates: [{ name: "v_atr_pct_4h", cuts: [1, 2], tercile: 2 }],
    G: 4,
    m: 2,
  };

  it("votes +1 / −1 from the voting terciles, 0 otherwise and for NULL", () => {
    expect(vote(card.voters[0]!, 5)).toBe(1);
    expect(vote(card.voters[0]!, -5)).toBe(-1);
    expect(vote(card.voters[0]!, 0)).toBe(0);
    expect(vote(card.voters[1]!, -5)).toBe(0); // long-only feature
    expect(vote(card.voters[0]!, null)).toBe(0);
  });

  it("goes LONG at score ≥ m, SHORT at ≤ −m, and NO-TRADE inside a gate", () => {
    expect(decide(card, { a: 5, b: 5, c: 0, d: 0, v_atr_pct_4h: 0 })).toBe("LONG");
    expect(decide(card, { a: 5, b: 0, c: 0, d: 0, v_atr_pct_4h: 0 })).toBe("NO_TRADE");
    expect(decide(card, { a: -5, b: 0, c: 5, d: -5, v_atr_pct_4h: 0 })).toBe("SHORT");
    expect(decide(card, { a: 5, b: 5, c: -5, d: 5, v_atr_pct_4h: 3 })).toBe("NO_TRADE");
    expect(decide(card, { a: 5, b: 5, c: -5, d: 5, v_atr_pct_4h: null })).toBe("LONG");
  });
});

describe("buildScorecard", () => {
  const data = syntheticData({ planted: ["m_rsi14_4h", "t_d_sma50_dist", "s_fng", "l_pdh_atr", "f_cvd_proxy_24h"], seed: 7, noise: 0.25 });
  const results = evaluateFeatures(data, FULL_RULES, { resamples: 300 });

  it("takes one voter per group, the qualifying feature with the highest |IC₇d|", () => {
    const b = buildScorecard(results, data, { excludeOi: true });
    if (b.verdict !== "scorecard") throw new Error(b.reason);
    expect(b.scorecard.voters.map((v) => v.name).sort()).toEqual(["f_cvd_proxy_24h", "l_pdh_atr", "m_rsi14_4h", "s_fng", "t_d_sma50_dist"].sort());
    expect(b.scorecard.G).toBe(5);
    expect(b.scorecard.m).toBe(3);
  });

  it("drops the weaker of two groups whose voters correlate above 0.6", () => {
    const twin = structuredClone(data);
    for (const r of twin.rows) r.values.s_fng = r.values.m_rsi14_4h === null ? null : r.values.m_rsi14_4h! * 2 + 1;
    const res = evaluateFeatures(twin, FULL_RULES, { resamples: 300 });
    const b = buildScorecard(res, twin, { excludeOi: true });
    if (b.verdict !== "scorecard") throw new Error(b.reason);
    expect(b.scorecard.voters.map((v) => v.group).filter((g) => g === "sentiment" || g === "momentum")).toHaveLength(1);
    expect(b.scorecard.G).toBe(4);
  });

  it("is 'no edge found' with fewer than 3 groups, and leaves OI out when told to", () => {
    const few = results.map((r): FeatureResult => (["m_rsi14_4h", "t_d_sma50_dist"].includes(r.name) ? r : { ...r, qualified: false }));
    expect(buildScorecard(few, data, { excludeOi: true })).toMatchObject({ verdict: "no_edge", G: 2 });
    const oiOnly = results.map((r): FeatureResult => (r.name === "m_rsi14_4h" ? r : r.name === "t_d_sma50_dist" || r.name === "s_fng" ? r : { ...r, qualified: false }));
    const withOi = oiOnly.map((r) => (r.name === "s_fng" ? { ...r, oi: true } : r));
    expect(buildScorecard(withOi, data, { excludeOi: true })).toMatchObject({ verdict: "no_edge", G: 2 });
    expect(buildScorecard(withOi, data, { excludeOi: false })).toMatchObject({ verdict: "scorecard" });
  });
});

describe("runBacktest", () => {
  const data = syntheticData({ planted: ["m_rsi14_4h", "t_d_sma50_dist", "s_fng"], seed: 3, noise: 0.2 });
  const card: Scorecard = {
    voters: ["m_rsi14_4h", "t_d_sma50_dist", "s_fng"].map((n) => voter(n, 2, 0)),
    gates: [],
    G: 3,
    m: 2,
  };
  for (const v of card.voters) v.cuts = [-0.02, 0.02];

  it("holds one position at a time and decides again at the exit bar's close", () => {
    const bt = runBacktest(card, data);
    expect(bt.calls).toBe(bt.trades.length);
    expect(bt.calls).toBeGreaterThan(30);
    for (let i = 1; i < bt.trades.length; i++) expect(bt.trades[i]!.k).toBeGreaterThanOrEqual(bt.trades[i - 1]!.exitIndex);
    for (const t of bt.trades) expect(t.exitIndex - t.k).toBeLessThanOrEqual(42);
  });

  it("reports base and stress average R, and MAR from 1% risk per trade", () => {
    const bt = runBacktest(card, data);
    expect(bt.avgR).toBeGreaterThan(0);
    expect(bt.avgRStress).toBeLessThan(bt.avgR);
    expect(bt.mar).not.toBeNull();
    expect(bt.maxDrawdownPct).toBeGreaterThan(0);
    // 1% risk: no single trade moves equity by more than ~1% × |R|
    for (const t of bt.trades) expect(Math.abs(t.pnlUsd / t.equityBefore)).toBeLessThanOrEqual(0.01 * Math.abs(t.r) + 1e-9);
  });
});

describe("runStudy", () => {
  it("runs the full in-sample selection, the nested check, and applies the Phase 3 bar", () => {
    const data = syntheticData({ planted: ["m_rsi14_4h", "t_d_sma50_dist", "s_fng"], seed: 5, noise: 0.2 });
    const s = runStudy(data, { resamples: 400 });
    expect(s.full.build.verdict).toBe("scorecard");
    expect(s.nested.build.verdict).toBe("scorecard");
    expect(s.nested.backtest!.trades.every((t) => data.rows.find((r) => r.k === t.k)!.barTime >= Date.parse("2022-01-01T00:00:00Z") / 1000)).toBe(true);
    expect(s.phase3.checks.map((c) => c.name)).toEqual([
      "full: calls ≥ 30", "full: stress avg R > 0", "full: MAR ≥ 0.23", "nested: calls ≥ 10", "nested: avg R > 0",
    ]);
    expect(s.phase3.pass).toBe(s.phase3.checks.every((c) => c.pass));
  });

  it("stops at 'no edge found' when nothing qualifies", () => {
    const s = runStudy(syntheticData({ planted: [], noiseFeatures: ["m_rsi14_4h"] }), { resamples: 50 });
    expect(s.full.build.verdict).toBe("no_edge");
    expect(s.phase3.pass).toBe(false);
  });
});
