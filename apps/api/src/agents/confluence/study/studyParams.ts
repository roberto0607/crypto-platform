/**
 * The Phase 2 factor study's pre-registration, as code. Every number here is
 * copied from docs/agents/confluence-preregistration.md: the rules approved
 * 2026-11-16 and the implementation-choices addendum approved 2026-11-26,
 * both before any study run. studyParams.test.ts parses both JSON blocks of
 * that file and fails on any difference. Don't edit one without the other,
 * and don't edit either after the study has run.
 */
import { FEATURE_COLUMNS, type FeatureGroup } from "../featureColumns";

export const STUDY_PREREGISTRATION = {
  approved: "2026-11-16",
  committed: "2026-11-22",
  inSample: { start: "2019-05-19", endExclusive: "2024-01-01" },
  targets: {
    entry: "next_bar_open",
    horizonBars: [6, 18, 42],
    decisionHorizonBars: 42,
    stopAtr: 1.5,
    atrPeriod: 14,
    feeBpsPerSide: 5,
    slippageBpsPerSide: 5,
    stressCostMultiplier: 2,
  },
  significance: {
    ic: "spearman",
    bootstrap: "moving_block",
    blockLength: "horizon",
    resamples: 2000,
    correction: "benjamini_hochberg",
    q: 0.1,
  },
  featureBar: {
    decidingHorizonBars: 42,
    minYears: 3,
    minNonNull: 0.9,
    minAbsIc: 0.1,
    maxCorrectedP: 0.1,
    sameSignYears: { required: 4, of: 5 },
    sameSignYearsOi: { required: 3, of: 4 },
    maxOppositeSignAbsIc: 0.05,
    minVotedSideAvgR: 0.1,
    minVotedSideEdgeR: 0.1,
    minHitRateEdgePp: 3,
  },
  gateFeatures: [
    "v_atr_pct_4h", "v_atr_pct_1d", "v_atr_pct_rank_1y",
    "v_adx_4h", "v_adx_1d",
    "e_hours_to_fomc", "e_hours_since_fomc", "e_hours_to_cpi", "e_hours_since_cpi",
  ],
  gateRule: { maxAvgRBothSides: -0.1, years: { required: 4, of: 5 } },
  scorecard: {
    voter: "highest_abs_ic_qualifying_feature_per_group",
    votes: [-1, 0, 1],
    maxGroupCorrelation: 0.6,
    minScore: "max(2, ceil(G/2))",
    minGroups: 3,
    maxOpenPositions: 1,
    maxHoldBars: 42,
  },
  liveOi: { minCorrelation24h: 0.8, minCorrelation7d: 0.8, dailyPointUtcHour: 16, overlapDays: 180 },
  phase3: {
    fullInSample: { minCalls: 30, stressAvgRAbove: 0, minMar: 0.23 },
    nested: {
      selectStart: "2019-05-19",
      selectEndExclusive: "2022-01-01",
      testStart: "2022-01-01",
      testEndExclusive: "2024-01-01",
      minCalls: 10,
      avgRAbove: 0,
    },
  },
} as const;

export const STUDY_ADDENDUM = {
  addendum: "2026-11-26",
  nestedSelection: {
    minYears: 2,
    sameSignYears: { required: 3, of: 3 },
    sameSignYearsOi: { required: 2, of: 2 },
    gateRuleYears: { required: 3, of: 3 },
  },
  targetMethod: {
    returnFrom: "open_k_plus_1",
    stopFrom: "entry",
    stopCheck: "4h_bars",
    dropIfTargetCloseAtOrAfterWindowEnd: true,
    dropIfBarMissing: true,
  },
  bootstrapMethod: { resample: "moving_blocks_of_pairs", pValue: "two_sided_percentile_plus_one", seed: 20261116 },
  bhFamily: { features: 45, horizons: 3, tests: 135 },
  excludedFromVoting: ["e_fomc_within_7d", "e_cpi_within_7d", "f_cvd_real_24h", "f_cvd_real_7d", "f_book_imbalance", "e_news_gate"],
  oiFeatures: ["p_oi_usd", "p_oi_chg_24h", "p_oi_chg_7d"],
  excludeOiFromScorecard: true,
  backtest: { riskPerTrade: 0.01, maxNotionalToEquity: 1, startEquity: 100000, marCosts: "base" },
} as const;

export interface StudyFeature {
  name: string;
  group: FeatureGroup;
  role: "gate" | "directional";
  oi: boolean;
}

const gates = new Set<string>(STUDY_PREREGISTRATION.gateFeatures);
const excluded = new Set<string>(STUDY_ADDENDUM.excludedFromVoting);
const oi = new Set<string>(STUDY_ADDENDUM.oiFeatures);

/** The 45 studied features: numeric, not live-only. */
export const STUDY_FEATURES: StudyFeature[] = FEATURE_COLUMNS
  .filter((c) => c.kind === "num" && c.source !== "live" && !excluded.has(c.name))
  .map((c) => ({ name: c.name, group: c.group, role: gates.has(c.name) ? "gate" : "directional", oi: oi.has(c.name) }));

export const GATE_FEATURES = STUDY_FEATURES.filter((f) => f.role === "gate").map((f) => f.name);
export const DIRECTIONAL_FEATURES = STUDY_FEATURES.filter((f) => f.role === "directional").map((f) => f.name);

/** Base and stress costs per side, in bps. */
export const STUDY_COSTS = {
  base: { feeBps: STUDY_PREREGISTRATION.targets.feeBpsPerSide, slippageBps: STUDY_PREREGISTRATION.targets.slippageBpsPerSide },
  stress: {
    feeBps: STUDY_PREREGISTRATION.targets.feeBpsPerSide * STUDY_PREREGISTRATION.targets.stressCostMultiplier,
    slippageBps: STUDY_PREREGISTRATION.targets.slippageBpsPerSide * STUDY_PREREGISTRATION.targets.stressCostMultiplier,
  },
} as const;
