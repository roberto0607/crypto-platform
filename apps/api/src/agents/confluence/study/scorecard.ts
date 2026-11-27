/**
 * The pre-registered scorecard rule. In each evidence group the qualifying
 * directional feature with the highest |IC₇d| votes (+1 / 0 / −1 by its
 * frozen terciles). Groups whose voters correlate at |ρ| > 0.6 (Spearman,
 * rows where both are non-null) lose the weaker one. Score = sum of votes;
 * m = max(2, ⌈G/2⌉); LONG at ≥ m, SHORT at ≤ −m, else NO-TRADE, and NO-TRADE
 * whenever a qualifying gate's value is in its no-trade tercile. G < 3 → no
 * scorecard ("no edge found"). OI features are left out when told to (the
 * live OI overlap check failed).
 */
import type { FeatureGroup } from "../featureColumns";
import type { StudyData } from "./studyData";
import type { FeatureResult } from "./evaluate";
import { spearman, tercileOf } from "./stats";
import { STUDY_PREREGISTRATION as S } from "./studyParams";

const D7 = S.targets.horizonBars.indexOf(S.featureBar.decidingHorizonBars);

export interface Voter {
  name: string;
  group?: FeatureGroup;
  cuts: [number, number];
  longTercile: 0 | 2 | null;
  shortTercile: 0 | 2 | null;
}

export interface Gate {
  name: string;
  cuts: [number, number];
  tercile: 0 | 1 | 2;
}

export interface Scorecard {
  voters: Voter[];
  gates: Gate[];
  G: number;
  m: number;
}

export type ScorecardBuild =
  | { verdict: "scorecard"; scorecard: Scorecard; dropped: Array<{ name: string; group: FeatureGroup; reason: string }> }
  | { verdict: "no_edge"; G: number; reason: string };

export function minScore(G: number): number {
  return Math.max(2, Math.ceil(G / 2));
}

export function buildScorecard(results: FeatureResult[], data: StudyData, opts: { excludeOi: boolean }): ScorecardBuild {
  const best = new Map<FeatureGroup, FeatureResult>();
  for (const r of results) {
    if (r.role !== "directional" || !r.qualified || (opts.excludeOi && r.oi)) continue;
    const cur = best.get(r.group);
    if (!cur || Math.abs(r.ic[D7]!) > Math.abs(cur.ic[D7]!)) best.set(r.group, r);
  }
  const reps = [...best.values()].sort((a, b) => Math.abs(b.ic[D7]!) - Math.abs(a.ic[D7]!));
  const kept: FeatureResult[] = [];
  const dropped: Array<{ name: string; group: FeatureGroup; reason: string }> = [];
  for (const r of reps) {
    const clash = kept.find((k) => {
      const pairs = data.rows.filter((row) => row.values[r.name] != null && row.values[k.name] != null);
      const rho = spearman(pairs.map((p) => p.values[r.name]!), pairs.map((p) => p.values[k.name]!));
      return Math.abs(rho) > S.scorecard.maxGroupCorrelation;
    });
    if (clash) dropped.push({ name: r.name, group: r.group, reason: `|ρ| > ${S.scorecard.maxGroupCorrelation} with ${clash.name}` });
    else kept.push(r);
  }
  const G = kept.length;
  if (G < S.scorecard.minGroups) return { verdict: "no_edge", G, reason: `${G} group(s) admitted < ${S.scorecard.minGroups}` };
  return {
    verdict: "scorecard",
    dropped,
    scorecard: {
      voters: kept.map((r) => ({ name: r.name, group: r.group, cuts: r.cuts!, longTercile: r.longTercile, shortTercile: r.shortTercile })),
      gates: results.filter((r) => r.role === "gate" && r.qualified).map((r) => ({ name: r.name, cuts: r.cuts!, tercile: r.noTradeTercile! })),
      G,
      m: minScore(G),
    },
  };
}

export function vote(v: Voter, value: number | null | undefined): -1 | 0 | 1 {
  if (value === null || value === undefined) return 0;
  const t = tercileOf(value, v.cuts);
  if (t === v.longTercile) return 1;
  if (t === v.shortTercile) return -1;
  return 0;
}

export function decide(card: Scorecard, values: Record<string, number | null>): "LONG" | "SHORT" | "NO_TRADE" {
  for (const g of card.gates) {
    const v = values[g.name];
    if (v !== null && v !== undefined && tercileOf(v, g.cuts) === g.tercile) return "NO_TRADE";
  }
  const score = card.voters.reduce((s, v) => s + vote(v, values[v.name]), 0);
  if (score >= card.m) return "LONG";
  if (score <= -card.m) return "SHORT";
  return "NO_TRADE";
}
