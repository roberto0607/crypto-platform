import type { StrategyParams } from "./backtestTypes.js";
import type {
  ParamVariationResult,
  RobustnessReport,
} from "./backtestTypes.js";
import type { TradeLog } from "./types.js";
import { computeBacktestMetrics } from "./backtestMetrics.js";

// ── Backtest function signature ─────────────────────────────

export type BacktestFn = (params: StrategyParams) => TradeLog[];

// ── Constants ───────────────────────────────────────────────

const VARIATION_PCT = 0.30;
const MIN_PF_AT_VARIANT = 1.0;
const MIN_ROBUSTNESS_RATIO = 0.60;
const MAX_DD_RATIO = 1.5;
const MAX_FRAGILE_PARAMS = 2;

// ── Snap to nearest valid step ──────────────────────────────

function snapToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

// ── Parameter step sizes ────────────────────────────────────

const PARAM_STEPS: Record<keyof StrategyParams, number> = {
  adxThreshold: 1,
  atrMultiplierSL: 0.25,
  atrMultiplierTrailing: 0.25,
  rMultipleTPTrend: 0.5,
  rMultipleTPRange: 0.5,
  partialExitThreshold: 0.25,
  eqTolerance: 0.02,
  maxHoldingHours: 6,
};

// ── Run ±30% Robustness Test ────────────────────────────────

export function runParameterRobustness(
  backtestFn: BacktestFn,
  optimizedParams: StrategyParams,
  startingEquity: number,
  backtestDays: number,
): RobustnessReport {
  const paramNames = Object.keys(PARAM_STEPS) as (keyof StrategyParams)[];
  const results: ParamVariationResult[] = [];

  for (const name of paramNames) {
    const baseValue = optimizedParams[name];
    const step = PARAM_STEPS[name];
    const lowValue = snapToStep(baseValue * (1 - VARIATION_PCT), step);
    const highValue = snapToStep(baseValue * (1 + VARIATION_PCT), step);

    // Run base
    const baseTrades = backtestFn(optimizedParams);
    const baseMetrics = computeBacktestMetrics(
      baseTrades,
      startingEquity,
      backtestDays,
    );

    // Run low variant
    const lowParams = { ...optimizedParams, [name]: lowValue };
    const lowTrades = backtestFn(lowParams);
    const lowMetrics = computeBacktestMetrics(
      lowTrades,
      startingEquity,
      backtestDays,
    );

    // Run high variant
    const highParams = { ...optimizedParams, [name]: highValue };
    const highTrades = backtestFn(highParams);
    const highMetrics = computeBacktestMetrics(
      highTrades,
      startingEquity,
      backtestDays,
    );

    const basePF = baseMetrics.profitFactor;
    const lowPF = lowMetrics.profitFactor;
    const highPF = highMetrics.profitFactor;

    const minPF = Math.min(
      isFinite(lowPF) ? lowPF : 0,
      isFinite(highPF) ? highPF : 0,
    );
    const maxPF = isFinite(basePF) ? basePF : 0;
    const robustnessRatio = maxPF > 0 ? minPF / maxPF : 0;

    const baseDD = baseMetrics.maxDrawdownPct;
    const maxVariantDD = Math.max(
      lowMetrics.maxDrawdownPct,
      highMetrics.maxDrawdownPct,
    );
    const drawdownRatio = baseDD > 0 ? maxVariantDD / baseDD : 0;

    const fragile =
      lowPF < MIN_PF_AT_VARIANT ||
      highPF < MIN_PF_AT_VARIANT ||
      robustnessRatio < MIN_ROBUSTNESS_RATIO ||
      drawdownRatio > MAX_DD_RATIO;

    results.push({
      paramName: name,
      baseValue,
      lowValue,
      highValue,
      basePF,
      lowPF,
      highPF,
      baseMaxDD: baseDD,
      lowMaxDD: lowMetrics.maxDrawdownPct,
      highMaxDD: highMetrics.maxDrawdownPct,
      robustnessRatio,
      drawdownRatio,
      fragile,
    });
  }

  const fragileCount = results.filter((r) => r.fragile).length;

  return {
    params: results,
    fragileCount,
    passed: fragileCount <= MAX_FRAGILE_PARAMS,
  };
}
