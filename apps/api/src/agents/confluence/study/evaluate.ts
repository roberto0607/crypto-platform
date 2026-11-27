/**
 * Per-feature statistics and the pre-registered bar (2026-11-16 rules,
 * 2026-11-26 addendum). Everything is decided on the 7-day target; the 1-day
 * and 3-day ICs and p-values are computed (and BH-adjusted in the same
 * family) for the report only.
 *
 * - Directional: coverage, |IC₇d| ≥ 0.10 with BH-adjusted p ≤ 0.10, same
 *   sign in N years with no opposite year above |0.05|, and per side: the
 *   voting tercile's average R > +0.10R, ≥ 0.10R over that side's
 *   unconditional average, hit rate ≥ 3 pp over that side's base rate.
 * - Gate: coverage, and a tercile where both sides average ≤ −0.10R in N
 *   years (that tercile becomes a no-trade zone).
 * N depends on the rule set: FULL_RULES for the full window, NESTED_RULES
 * inside the nested check's selection window.
 */
import type { StudyData } from "./studyData";
import { STUDY_ADDENDUM as A, STUDY_FEATURES, STUDY_PREREGISTRATION as S, type StudyFeature } from "./studyParams";
import { targetsAt, type RowTargets } from "./targets";
import { benjaminiHochberg, blockBootstrapP, spearman, tercileCuts, tercileOf } from "./stats";

const H4 = 14_400;
const YEAR_SEC = 365.25 * 86_400;
const B = S.featureBar;
const D7 = S.targets.horizonBars.indexOf(S.featureBar.decidingHorizonBars);

export interface StudyRules {
  minYears: number;
  minNonNull: number;
  sameSign: number;
  sameSignOi: number;
  gateYears: number;
}

export const FULL_RULES: StudyRules = {
  minYears: B.minYears,
  minNonNull: B.minNonNull,
  sameSign: B.sameSignYears.required,
  sameSignOi: B.sameSignYearsOi.required,
  gateYears: S.gateRule.years.required,
};

export const NESTED_RULES: StudyRules = {
  minYears: A.nestedSelection.minYears,
  minNonNull: B.minNonNull,
  sameSign: A.nestedSelection.sameSignYears.required,
  sameSignOi: A.nestedSelection.sameSignYearsOi.required,
  gateYears: A.nestedSelection.gateRuleYears.required,
};

export interface TercileStats {
  n: number;
  longR: number;
  shortR: number;
  longRStress: number;
  shortRStress: number;
  /** Share of rows whose 7-day return is > 0 / < 0. */
  hitLong: number;
  hitShort: number;
}

export interface FeatureStats extends StudyFeature {
  /** Years from the feature's first value to the window's end. */
  coverageYears: number;
  /** Non-null share of rows from its first value on. */
  nonNull: number;
  /** Rows with a value and a target. */
  n: number;
  ic: number[];
  p: number[];
  adjP: number[];
  yearIc: Record<number, number>;
  cuts: [number, number] | null;
  tercile: TercileStats[];
  base: { longR: number; shortR: number; hitLong: number; hitShort: number };
  yearTercile: Record<number, Array<{ longR: number; shortR: number }>>;
}

export interface FeatureResult extends FeatureStats {
  /** Tercile that votes +1 / −1, or null if that side doesn't qualify. */
  longTercile: 0 | 2 | null;
  shortTercile: 0 | 2 | null;
  /** Gates: the no-trade tercile, or null. */
  noTradeTercile: 0 | 1 | 2 | null;
  qualified: boolean;
  reasons: string[];
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const share = (xs: number[], f: (x: number) => boolean) => (xs.length ? xs.filter(f).length / xs.length : NaN);

/** Rows inside [from, toExclusive); targets computed against it never read past its end. */
export function restrictWindow(data: StudyData, from: number, toExclusive: number): StudyData {
  return { window: { from, toExclusive }, h4: data.h4, rows: data.rows.filter((r) => r.barTime >= from && r.barTime + H4 <= toExclusive) };
}

export function computeTargets(data: StudyData): Map<number, RowTargets | null> {
  return new Map(data.rows.map((r) => [r.k, targetsAt(data.h4, r.k, r.atr, data.window.toExclusive)]));
}

function featureStats(f: StudyFeature, data: StudyData, targets: Map<number, RowTargets | null>, resamples: number, seed: number): FeatureStats {
  const withValue = data.rows.filter((r) => r.values[f.name] !== null && r.values[f.name] !== undefined);
  const first = withValue[0]?.barTime;
  const fromFirst = first === undefined ? [] : data.rows.filter((r) => r.barTime >= first);
  const samples = withValue
    .map((r) => ({ year: r.year, v: r.values[f.name]!, t: targets.get(r.k) }))
    .filter((s): s is { year: number; v: number; t: RowTargets } => !!s.t);
  const v = samples.map((s) => s.v);

  const ic: number[] = [];
  const p: number[] = [];
  S.targets.horizonBars.forEach((h, i) => {
    const y = samples.map((s) => s.t.ret[i]!);
    const c = samples.length >= 2 ? spearman(v, y) : NaN;
    ic.push(c);
    p.push(Number.isFinite(c) ? blockBootstrapP(v, y, h, resamples, seed) : 1);
  });

  const byYear = new Map<number, typeof samples>();
  for (const s of samples) byYear.set(s.year, [...(byYear.get(s.year) ?? []), s]);
  const yearIc: Record<number, number> = {};
  for (const [year, ss] of byYear) {
    const c = ss.length >= 2 ? spearman(ss.map((s) => s.v), ss.map((s) => s.t.ret[D7]!)) : NaN;
    if (Number.isFinite(c)) yearIc[year] = c;
  }

  const cuts = withValue.length >= 3 ? tercileCuts(withValue.map((r) => r.values[f.name]!)) : null;
  const groups: Array<typeof samples> = [[], [], []];
  if (cuts) for (const s of samples) groups[tercileOf(s.v, cuts)]!.push(s);
  const tstats = (ss: typeof samples): TercileStats => ({
    n: ss.length,
    longR: mean(ss.map((s) => s.t.longR)),
    shortR: mean(ss.map((s) => s.t.shortR)),
    longRStress: mean(ss.map((s) => s.t.longRStress)),
    shortRStress: mean(ss.map((s) => s.t.shortRStress)),
    hitLong: share(ss.map((s) => s.t.ret[D7]!), (x) => x > 0),
    hitShort: share(ss.map((s) => s.t.ret[D7]!), (x) => x < 0),
  });
  const all = tstats(samples);
  const yearTercile: FeatureStats["yearTercile"] = {};
  if (cuts) {
    for (const [year, ss] of byYear) {
      yearTercile[year] = [0, 1, 2].map((t) => {
        const g = ss.filter((s) => tercileOf(s.v, cuts) === t);
        return { longR: mean(g.map((s) => s.t.longR)), shortR: mean(g.map((s) => s.t.shortR)) };
      });
    }
  }

  return {
    ...f,
    coverageYears: first === undefined ? 0 : (data.window.toExclusive - first) / YEAR_SEC,
    nonNull: fromFirst.length ? withValue.length / fromFirst.length : 0,
    n: samples.length,
    ic,
    p,
    adjP: [],
    yearIc,
    cuts,
    tercile: groups.map(tstats),
    base: { longR: all.longR, shortR: all.shortR, hitLong: all.hitLong, hitShort: all.hitShort },
    yearTercile,
  };
}

function coverageReasons(s: FeatureStats, rules: StudyRules): string[] {
  const out: string[] = [];
  if (!(s.coverageYears >= rules.minYears)) out.push(`coverage ${s.coverageYears.toFixed(2)} years < ${rules.minYears}`);
  if (!(s.nonNull >= rules.minNonNull)) out.push(`non-null ${(100 * s.nonNull).toFixed(1)}% < ${100 * rules.minNonNull}%`);
  return out;
}

export function qualifyDirectional(s: FeatureStats, rules: StudyRules): { longTercile: 0 | 2 | null; shortTercile: 0 | 2 | null; reasons: string[] } {
  const reasons = coverageReasons(s, rules);
  const ic = s.ic[D7]!;
  if (!(Math.abs(ic) >= B.minAbsIc)) reasons.push(`|IC7d| ${Number.isFinite(ic) ? Math.abs(ic).toFixed(3) : "n/a"} < ${B.minAbsIc}`);
  if (!(s.adjP[D7]! <= B.maxCorrectedP)) reasons.push(`corrected p ${s.adjP[D7]?.toFixed(3)} > ${B.maxCorrectedP}`);
  const sign = Math.sign(ic);
  const years = Object.values(s.yearIc);
  const same = years.filter((y) => Math.sign(y) === sign && sign !== 0).length;
  const required = s.oi ? rules.sameSignOi : rules.sameSign;
  if (same < required) reasons.push(`same sign in ${same} years < ${required}`);
  if (years.some((y) => Math.sign(y) === -sign && Math.abs(y) > B.maxOppositeSignAbsIc)) reasons.push(`a year has the opposite sign with |IC| > ${B.maxOppositeSignAbsIc}`);
  if (!s.cuts) reasons.push("no terciles");
  if (reasons.length > 0) return { longTercile: null, shortTercile: null, reasons };

  const side = (name: "long" | "short", tercile: 0 | 2): 0 | 2 | null => {
    const t = s.tercile[tercile]!;
    const avg = name === "long" ? t.longR : t.shortR;
    const base = name === "long" ? s.base.longR : s.base.shortR;
    const hitEdgePp = 100 * ((name === "long" ? t.hitLong : t.hitShort) - (name === "long" ? s.base.hitLong : s.base.hitShort));
    const before = reasons.length;
    if (!(avg > B.minVotedSideAvgR)) reasons.push(`${name}: avg R ${avg.toFixed(3)} ≤ ${B.minVotedSideAvgR.toFixed(2)}`);
    if (!(avg - base >= B.minVotedSideEdgeR)) reasons.push(`${name}: edge ${(avg - base).toFixed(3)}R < ${B.minVotedSideEdgeR}R`);
    if (!(hitEdgePp >= B.minHitRateEdgePp)) reasons.push(`${name}: hit rate ${hitEdgePp.toFixed(1)} pp over base < ${B.minHitRateEdgePp} pp`);
    return reasons.length === before ? tercile : null;
  };
  const longTercile = side("long", ic > 0 ? 2 : 0);
  const shortTercile = side("short", ic > 0 ? 0 : 2);
  return { longTercile, shortTercile, reasons };
}

/** The tercile where both sides average ≤ −0.10R in at least rules.gateYears years, or null. */
export function gateNoTradeTercile(yearTercile: FeatureStats["yearTercile"], rules: StudyRules): 0 | 1 | 2 | null {
  let best: 0 | 1 | 2 | null = null;
  let bestYears = 0;
  for (const t of [0, 1, 2] as const) {
    const years = Object.values(yearTercile).filter((ts) => ts[t]!.longR <= S.gateRule.maxAvgRBothSides && ts[t]!.shortR <= S.gateRule.maxAvgRBothSides).length;
    if (years >= rules.gateYears && years > bestYears) {
      best = t;
      bestYears = years;
    }
  }
  return best;
}

export function evaluateFeatures(data: StudyData, rules: StudyRules, opts: { resamples?: number; seed?: number } = {}): FeatureResult[] {
  const resamples = opts.resamples ?? S.significance.resamples;
  const seed = opts.seed ?? A.bootstrapMethod.seed;
  const targets = computeTargets(data);
  const stats = STUDY_FEATURES.map((f) => featureStats(f, data, targets, resamples, seed));
  const adj = benjaminiHochberg(stats.flatMap((s) => s.p));
  const H = S.targets.horizonBars.length;
  stats.forEach((s, i) => (s.adjP = adj.slice(i * H, i * H + H)));

  return stats.map((s): FeatureResult => {
    if (s.role === "gate") {
      const reasons = coverageReasons(s, rules);
      const noTradeTercile = reasons.length === 0 ? gateNoTradeTercile(s.yearTercile, rules) : null;
      if (reasons.length === 0 && noTradeTercile === null) reasons.push(`no tercile with both sides ≤ ${S.gateRule.maxAvgRBothSides}R in ${rules.gateYears} years`);
      return { ...s, longTercile: null, shortTercile: null, noTradeTercile, qualified: noTradeTercile !== null, reasons };
    }
    const q = qualifyDirectional(s, rules);
    return { ...s, ...q, noTradeTercile: null, qualified: q.longTercile !== null || q.shortTercile !== null };
  });
}
