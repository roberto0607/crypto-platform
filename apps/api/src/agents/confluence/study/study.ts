/**
 * The whole Phase 2 study on loaded in-sample data, and the pre-registered
 * bar to propose Phase 3:
 *   1. Full in-sample: select features, build the scorecard, run it:
 *      ≥ 30 calls, stress average R > 0, MAR ≥ 0.23.
 *   2. Nested: select again on 2019-05-19 → 2021-12-31 only (NESTED_RULES,
 *      targets closed before 2022-01-01), freeze, and run on 2022 → 2023:
 *      ≥ 10 calls, average R > 0.
 * Pure: the CLI and report that run it on the real data are PR 2b.
 */
import type { StudyData } from "./studyData";
import { evaluateFeatures, restrictWindow, FULL_RULES, NESTED_RULES, type FeatureResult } from "./evaluate";
import { buildScorecard, type ScorecardBuild } from "./scorecard";
import { runBacktest, type BacktestResult } from "./backtest";
import { STUDY_ADDENDUM as A, STUDY_PREREGISTRATION as S } from "./studyParams";

const utc = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

export interface StudyStage {
  results: FeatureResult[];
  build: ScorecardBuild;
  backtest: BacktestResult | null;
}

export interface StudyOutcome {
  full: StudyStage;
  nested: StudyStage;
  phase3: { pass: boolean; checks: Array<{ name: string; value: number | null; pass: boolean }> };
}

function stage(select: StudyData, run: StudyData, rules: typeof FULL_RULES, opts: { resamples?: number }): StudyStage {
  const results = evaluateFeatures(select, rules, opts);
  const build = buildScorecard(results, select, { excludeOi: A.excludeOiFromScorecard });
  const backtest = build.verdict === "scorecard" ? runBacktest(build.scorecard, run) : null;
  return { results, build, backtest };
}

export function runStudy(data: StudyData, opts: { resamples?: number } = {}): StudyOutcome {
  const full = stage(data, data, FULL_RULES, opts);
  const n = S.phase3.nested;
  const nested = stage(
    restrictWindow(data, utc(n.selectStart), utc(n.selectEndExclusive)),
    restrictWindow(data, utc(n.testStart), utc(n.testEndExclusive)),
    NESTED_RULES,
    opts,
  );
  const f = S.phase3.fullInSample;
  const fb = full.backtest;
  const nb = nested.backtest;
  const checks = [
    { name: `full: calls ≥ ${f.minCalls}`, value: fb?.calls ?? null, pass: !!fb && fb.calls >= f.minCalls },
    { name: `full: stress avg R > ${f.stressAvgRAbove}`, value: fb?.avgRStress ?? null, pass: !!fb && fb.avgRStress > f.stressAvgRAbove },
    { name: `full: MAR ≥ ${f.minMar}`, value: fb?.mar ?? null, pass: !!fb && fb.mar !== null && fb.mar >= f.minMar },
    { name: `nested: calls ≥ ${n.minCalls}`, value: nb?.calls ?? null, pass: !!nb && nb.calls >= n.minCalls },
    { name: `nested: avg R > ${n.avgRAbove}`, value: nb?.avgR ?? null, pass: !!nb && nb.avgR > n.avgRAbove },
  ];
  return { full, nested, phase3: { pass: checks.every((c) => c.pass), checks } };
}
