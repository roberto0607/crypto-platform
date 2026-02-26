import type { TradeLog } from "./types.js";
import type { BacktestFlag, StrategyParams } from "./backtestTypes.js";
import { DEFAULT_PARAMS } from "./backtestTypes.js";
import {
  computeBacktestMetrics,
  type BacktestMetrics,
} from "./backtestMetrics.js";

// Re-export for consumers
export type { StrategyParams } from "./backtestTypes.js";
export { DEFAULT_PARAMS } from "./backtestTypes.js";

// ── Parameter Variants ──────────────────────────────────────

export interface ParamVariant {
  name: keyof StrategyParams;
  values: number[];
}

export const DEFAULT_VARIANTS: ParamVariant[] = [
  { name: "adxThreshold", values: [18, 19, 20, 21, 22] },
  { name: "atrMultiplierSL", values: [1.25, 1.5, 1.75] },
  { name: "atrMultiplierTrailing", values: [0.75, 1.0, 1.25] },
  { name: "rMultipleTPTrend", values: [2.0, 2.5, 3.0] },
  { name: "rMultipleTPRange", values: [1.5, 2.0, 2.5] },
  { name: "partialExitThreshold", values: [1.0, 1.5, 2.0] },
  { name: "eqTolerance", values: [0.08, 0.1, 0.12] },
  { name: "maxHoldingHours", values: [18, 24, 36] },
];

// ── Thresholds ──────────────────────────────────────────────
const ROBUSTNESS_THRESHOLD = 0.6;
const MAX_FRAGILE_PARAMS = 2;

// ── Per-Variant Result ──────────────────────────────────────

export interface VariantResult {
  paramName: keyof StrategyParams;
  paramValue: number;
  metrics: BacktestMetrics;
}

// ── Per-Parameter Robustness ────────────────────────────────

export interface ParamRobustness {
  paramName: keyof StrategyParams;
  variants: VariantResult[];
  scores: {
    winRate: number;
    profitFactor: number;
    sharpeRatio: number | null;
  };
  robust: boolean;
}

// ── Full Report ─────────────────────────────────────────────

export interface SensitivityReport {
  parameters: ParamRobustness[];
  fragileCount: number;
  strategyFragile: boolean;
  flags: BacktestFlag[];
}

// ── Backtest Function Signature ─────────────────────────────

export type BacktestFn = (params: StrategyParams) => TradeLog[];

// ── Run Sensitivity Analysis ────────────────────────────────

export function runSensitivityAnalysis(
  backtestFn: BacktestFn,
  startingEquity: number,
  backtestDays: number,
  variants: ParamVariant[] = DEFAULT_VARIANTS,
): SensitivityReport {
  const parameters: ParamRobustness[] = [];

  for (const variant of variants) {
    const results: VariantResult[] = [];

    for (const value of variant.values) {
      const params: StrategyParams = {
        ...DEFAULT_PARAMS,
        [variant.name]: value,
      };
      const trades = backtestFn(params);
      const metrics = computeBacktestMetrics(
        trades,
        startingEquity,
        backtestDays,
      );

      results.push({
        paramName: variant.name,
        paramValue: value,
        metrics,
      });
    }

    const scores = computeRobustnessScores(results);
    const robust =
      scores.winRate >= ROBUSTNESS_THRESHOLD &&
      scores.profitFactor >= ROBUSTNESS_THRESHOLD &&
      (scores.sharpeRatio === null ||
        scores.sharpeRatio >= ROBUSTNESS_THRESHOLD);

    parameters.push({
      paramName: variant.name,
      variants: results,
      scores,
      robust,
    });
  }

  const fragileCount = parameters.filter((p) => !p.robust).length;

  return {
    parameters,
    fragileCount,
    strategyFragile: fragileCount > MAX_FRAGILE_PARAMS,
    flags: [],
  };
}

// ── Robustness Scores ───────────────────────────────────────

function computeRobustnessScores(results: VariantResult[]): {
  winRate: number;
  profitFactor: number;
  sharpeRatio: number | null;
} {
  const winRates = results.map((r) => r.metrics.winRate);
  const profitFactors = results
    .map((r) => r.metrics.profitFactor)
    .filter((v) => isFinite(v));
  const sharpes = results
    .map((r) => r.metrics.sharpeRatio)
    .filter((v): v is number => v !== null);

  return {
    winRate: minMaxRatio(winRates),
    profitFactor: minMaxRatio(profitFactors),
    sharpeRatio: sharpes.length >= 2 ? minMaxRatio(sharpes) : null,
  };
}

function minMaxRatio(values: number[]): number {
  const finite = values.filter((v) => isFinite(v));
  if (finite.length < 2) return finite.length === 1 ? 1 : 0;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max <= 0) return 0;
  if (min < 0) return 0;
  return min / max;
}

