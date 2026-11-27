/**
 * The pre-registered feature bar and gate rule, on hand-made statistics and
 * on synthetic data with planted features.
 */
import { describe, it, expect } from "vitest";
import { evaluateFeatures, qualifyDirectional, gateNoTradeTercile, restrictWindow, FULL_RULES, NESTED_RULES, type FeatureStats } from "../evaluate";
import { syntheticData, T_START } from "./synthetic";

const Y = [2019, 2020, 2021, 2022, 2023];

/** Statistics that clear every directional rule, long side, unless overridden. */
const passing = (over: Partial<FeatureStats> = {}): FeatureStats => ({
  name: "m_rsi14_4h", group: "momentum", role: "directional", oi: false,
  coverageYears: 4.6, nonNull: 0.99, n: 10_000,
  ic: [0.05, 0.08, 0.15], p: [0.5, 0.2, 0.001], adjP: [0.6, 0.3, 0.05],
  yearIc: Object.fromEntries(Y.map((y) => [y, 0.12])),
  cuts: [-1, 1],
  tercile: [
    { n: 100, longR: -0.2, shortR: 0.05, longRStress: -0.25, shortRStress: 0, hitLong: 0.45, hitShort: 0.55 },
    { n: 100, longR: 0, shortR: 0, longRStress: 0, shortRStress: 0, hitLong: 0.5, hitShort: 0.5 },
    { n: 100, longR: 0.25, shortR: -0.3, longRStress: 0.2, shortRStress: -0.35, hitLong: 0.6, hitShort: 0.4 },
  ],
  base: { longR: 0.02, shortR: -0.1, hitLong: 0.52, hitShort: 0.48 },
  yearTercile: {},
  ...over,
});

describe("qualifyDirectional (the 2026-11-16 bar)", () => {
  it("passes a feature clearing all five rules, on the side its IC points to", () => {
    const q = qualifyDirectional(passing(), FULL_RULES);
    expect(q).toEqual({ longTercile: 2, shortTercile: null, reasons: ["short: avg R 0.050 ≤ 0.10"] });
  });

  it("flips sides for a negative IC", () => {
    const s = passing({ ic: [0, 0, -0.15], yearIc: Object.fromEntries(Y.map((y) => [y, -0.12])) });
    const q = qualifyDirectional(s, FULL_RULES);
    expect(q.longTercile).toBeNull(); // long would vote from the low tercile: avg R -0.2
    expect(q.shortTercile).toBeNull(); // short from the high tercile: avg R -0.3
  });

  it("fails each rule on its own", () => {
    const fails = (over: Partial<FeatureStats>) => qualifyDirectional(passing(over), FULL_RULES).longTercile;
    expect(fails({ coverageYears: 2.9 })).toBeNull();
    expect(fails({ nonNull: 0.89 })).toBeNull();
    expect(fails({ ic: [0, 0, 0.099] })).toBeNull();
    expect(fails({ adjP: [0, 0, 0.11] })).toBeNull();
    expect(fails({ yearIc: { 2019: 0.1, 2020: 0.1, 2021: 0.1, 2022: -0.01, 2023: -0.01 } })).toBeNull(); // 3 of 5
    expect(fails({ yearIc: { 2019: 0.1, 2020: 0.1, 2021: 0.1, 2022: 0.1, 2023: -0.06 } })).toBeNull(); // opposite > 0.05
    expect(fails({ yearIc: { 2019: 0.1, 2020: 0.1, 2021: 0.1, 2022: 0.1, 2023: -0.05 } })).toBe(2); // 4 of 5, opposite 0.05 ok
    const t = passing().tercile;
    expect(fails({ tercile: [t[0]!, t[1]!, { ...t[2]!, longR: 0.1 }] })).toBeNull(); // not above +0.10R
    expect(fails({ base: { ...passing().base, longR: 0.16 } })).toBeNull(); // edge 0.09R
    expect(fails({ base: { ...passing().base, hitLong: 0.571 } })).toBeNull(); // hit edge 2.9 pp
  });

  it("uses 3 of 4 years for OI, and the nested rules inside the selection window", () => {
    const oi = passing({ oi: true, name: "p_oi_chg_7d", yearIc: { 2020: 0.1, 2021: 0.1, 2022: 0.1, 2023: -0.01 } });
    expect(qualifyDirectional(oi, FULL_RULES).longTercile).toBe(2);
    const nested = passing({ coverageYears: 2.6, yearIc: { 2019: 0.1, 2020: 0.1, 2021: 0.1 } });
    expect(qualifyDirectional(nested, FULL_RULES).longTercile).toBeNull();
    expect(qualifyDirectional(nested, NESTED_RULES).longTercile).toBe(2);
    expect(qualifyDirectional(passing({ coverageYears: 2.6, yearIc: { 2019: 0.1, 2020: 0.1, 2021: -0.01 } }), NESTED_RULES).longTercile).toBeNull();
    expect(qualifyDirectional(passing({ oi: true, coverageYears: 2.1, yearIc: { 2020: 0.1, 2021: 0.1 } }), NESTED_RULES).longTercile).toBe(2);
  });
});

describe("gateNoTradeTercile", () => {
  const yt = (bad: number[]) =>
    Object.fromEntries(Y.map((y, i) => [y, [0, 1, 2].map((t) => (t === 2 && bad.includes(i) ? { longR: -0.2, shortR: -0.1 } : { longR: 0.1, shortR: -0.3 }))]));

  it("is the tercile where both sides average ≤ −0.10R in 4 of 5 years", () => {
    expect(gateNoTradeTercile(yt([0, 1, 2, 3]), FULL_RULES)).toBe(2);
    expect(gateNoTradeTercile(yt([0, 1, 2]), FULL_RULES)).toBeNull();
    expect(gateNoTradeTercile(yt([0, 1, 2]), NESTED_RULES)).toBe(2); // 3 of 3 inside the selection window
  });

  it("needs both sides bad, not one", () => {
    const one = Object.fromEntries(Y.map((y) => [y, [0, 1, 2].map(() => ({ longR: -0.5, shortR: 0 }))]));
    expect(gateNoTradeTercile(one, FULL_RULES)).toBeNull();
  });
});

describe("evaluateFeatures (synthetic data)", () => {
  const data = syntheticData({ planted: ["m_rsi14_4h", "t_d_sma50_dist"], noiseFeatures: ["s_fng"] });
  // 1,000 resamples: the smallest p is 2/1001, enough to survive BH over 135 tests
  const results = evaluateFeatures(data, FULL_RULES, { resamples: 1000 });
  const by = (n: string) => results.find((r) => r.name === n)!;

  it("evaluates all 45 features and Benjamini–Hochberg-adjusts over all 135 tests", () => {
    expect(results).toHaveLength(45);
    for (const r of results) for (let h = 0; h < 3; h++) expect(r.adjP[h]).toBeGreaterThanOrEqual(r.p[h]!);
  });

  it("qualifies the planted features and not the noise or the empty ones", () => {
    expect(by("m_rsi14_4h").qualified).toBe(true);
    expect(by("m_rsi14_4h").longTercile).toBe(2);
    expect(by("t_d_sma50_dist").qualified).toBe(true);
    expect(by("s_fng").qualified).toBe(false);
    expect(by("l_pdh_atr").qualified).toBe(false);
    expect(by("l_pdh_atr").n).toBe(0);
  });

  it("restrictWindow keeps only rows inside, and targets never read past its end", () => {
    const sel = restrictWindow(data, T_START, Date.parse("2022-01-01T00:00:00Z") / 1000);
    expect(sel.rows.every((r) => r.barTime + 14_400 <= sel.window.toExclusive)).toBe(true);
    const altered = structuredClone(data);
    for (let i = 0; i < altered.h4.length; i++) {
      if (altered.h4[i]!.time >= sel.window.toExclusive) altered.h4[i] = { ...altered.h4[i]!, open: 1, high: 1, low: 1, close: 1 };
    }
    for (const r of altered.rows) if (r.barTime >= sel.window.toExclusive) r.values.m_rsi14_4h = 999;
    const a = evaluateFeatures(sel, NESTED_RULES, { resamples: 50 });
    const b = evaluateFeatures(restrictWindow(altered, T_START, sel.window.toExclusive), NESTED_RULES, { resamples: 50 });
    expect(b).toEqual(a);
  });
});
