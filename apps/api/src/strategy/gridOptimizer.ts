import type { StrategyParams } from "./backtestTypes.js";
import type {
  GridSearchResult,
  TieredOptimizationResult,
} from "./backtestTypes.js";
import { DEFAULT_PARAMS } from "./backtestTypes.js";
import type { TradeLog } from "./types.js";
import { computeBacktestMetrics } from "./backtestMetrics.js";

// ── Backtest function signature ─────────────────────────────

export type BacktestFn = (params: StrategyParams) => TradeLog[];

// ── Tier 1 Search Ranges ────────────────────────────────────

const TIER1_RANGES = {
  adxThreshold: [17, 18, 19, 20, 21, 22, 23],
  atrMultiplierSL: [1.0, 1.25, 1.5, 1.75, 2.0],
  rMultipleTPTrend: [2.0, 2.5, 3.0, 3.5],
  rMultipleTPRange: [1.5, 2.0, 2.5],
};

// ── Tier 2 Search Ranges ────────────────────────────────────

const TIER2_RANGES = {
  atrMultiplierTrailing: [0.75, 1.0, 1.25, 1.5],
  partialExitThreshold: [1.0, 1.25, 1.5, 2.0],
  eqTolerance: [0.06, 0.08, 0.1, 0.12, 0.15],
};

// ── Tier 3 Search Ranges ────────────────────────────────────

const TIER3_RANGES = {
  maxHoldingHours: [12, 18, 24, 36, 48],
};

// ── Evaluate a single param set ─────────────────────────────

function evaluate(
  backtestFn: BacktestFn,
  params: StrategyParams,
  startingEquity: number,
  backtestDays: number,
): GridSearchResult | null {
  const trades = backtestFn(params);
  if (trades.length < 30) return null;

  const metrics = computeBacktestMetrics(trades, startingEquity, backtestDays);

  return {
    params: { ...params },
    profitFactor: metrics.profitFactor,
    sharpeRatio: metrics.sharpeRatio,
    winRate: metrics.winRate,
    maxDrawdownPct: metrics.maxDrawdownPct,
    totalTrades: metrics.totalTrades,
    expectancy: metrics.expectancy,
  };
}

// ── Sort by OOS profit factor descending ────────────────────

function sortByPF(results: GridSearchResult[]): GridSearchResult[] {
  return [...results].sort((a, b) => {
    const aPF = isFinite(a.profitFactor) ? a.profitFactor : 0;
    const bPF = isFinite(b.profitFactor) ? b.profitFactor : 0;
    return bPF - aPF;
  });
}

// ── Run Tiered Optimization ─────────────────────────────────

export function runTieredOptimization(
  backtestFn: BacktestFn,
  startingEquity: number,
  backtestDays: number,
): TieredOptimizationResult {
  let totalCombos = 0;

  // ── Tier 1: Grid search over primary params ───────────────
  const tier1Results: GridSearchResult[] = [];

  for (const adx of TIER1_RANGES.adxThreshold) {
    for (const sl of TIER1_RANGES.atrMultiplierSL) {
      for (const tpTrend of TIER1_RANGES.rMultipleTPTrend) {
        for (const tpRange of TIER1_RANGES.rMultipleTPRange) {
          const params: StrategyParams = {
            ...DEFAULT_PARAMS,
            adxThreshold: adx,
            atrMultiplierSL: sl,
            rMultipleTPTrend: tpTrend,
            rMultipleTPRange: tpRange,
          };
          totalCombos++;
          const result = evaluate(
            backtestFn,
            params,
            startingEquity,
            backtestDays,
          );
          if (result) tier1Results.push(result);
        }
      }
    }
  }

  const tier1Top5 = sortByPF(tier1Results).slice(0, 5);

  if (tier1Top5.length === 0) {
    const fallback: GridSearchResult = {
      params: { ...DEFAULT_PARAMS },
      profitFactor: 0,
      sharpeRatio: null,
      winRate: 0,
      maxDrawdownPct: 0,
      totalTrades: 0,
      expectancy: 0,
    };
    return {
      tier1Top5: [],
      tier2Best: fallback,
      tier3Final: fallback,
      totalCombosEvaluated: totalCombos,
    };
  }

  // ── Tier 2: Refine secondary params on each top-5 set ─────
  const tier2Results: GridSearchResult[] = [];

  for (const base of tier1Top5) {
    for (const trail of TIER2_RANGES.atrMultiplierTrailing) {
      for (const partial of TIER2_RANGES.partialExitThreshold) {
        for (const eq of TIER2_RANGES.eqTolerance) {
          const params: StrategyParams = {
            ...base.params,
            atrMultiplierTrailing: trail,
            partialExitThreshold: partial,
            eqTolerance: eq,
          };
          totalCombos++;
          const result = evaluate(
            backtestFn,
            params,
            startingEquity,
            backtestDays,
          );
          if (result) tier2Results.push(result);
        }
      }
    }
  }

  const tier2Best =
    sortByPF(tier2Results)[0] ?? tier1Top5[0];

  // ── Tier 3: Validate structural params ────────────────────
  const tier3Results: GridSearchResult[] = [];

  for (const hours of TIER3_RANGES.maxHoldingHours) {
    const params: StrategyParams = {
      ...tier2Best.params,
      maxHoldingHours: hours,
    };
    totalCombos++;
    const result = evaluate(
      backtestFn,
      params,
      startingEquity,
      backtestDays,
    );
    if (result) tier3Results.push(result);
  }

  const tier3Final = sortByPF(tier3Results)[0] ?? tier2Best;

  return {
    tier1Top5,
    tier2Best,
    tier3Final,
    totalCombosEvaluated: totalCombos,
  };
}
