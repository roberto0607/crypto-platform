import type { Timeframe } from "./types.js";

// ── Warmup Requirements ─────────────────────────────────────
export const WARMUP = {
  EMA_20_4H: 20,
  EMA_50_4H: 50,
  ADX_14_4H: 29,
  ATR_14_4H: 15,
  ATR_14_15M: 15,
  VWAP_DAILY: 1,
  BINDING_4H_CANDLES: 50,
  BINDING_DAYS: 9,
  RECOMMENDED_DAYS: 14,
} as const;

// ── Expected candle intervals (ms) ─────────────────────────
export const CANDLE_INTERVAL_MS: Record<Timeframe, number> = {
  "15m": 15 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

// ── 15m candles per higher timeframe period ─────────────────
export const CANDLES_15M_PER = {
  "4H": 16,
  "1D": 96,
} as const;

// ── Sample Size Thresholds ──────────────────────────────────
export const SAMPLE_THRESHOLDS = {
  HARD_MIN_TRADES: 30,
  SOFT_MIN_TRADES: 50,
  TARGET_TRADES: 100,
  MIN_TRADES_PER_REGIME: 15,
  MIN_TRADES_OOS_WINDOW: 20,
} as const;

// ── Historical Range ────────────────────────────────────────
export const HISTORICAL_RANGE = {
  MIN_BACKTEST_DAYS: 90,
  RECOMMENDED_BACKTEST_DAYS: 180,
  MIN_WALKFORWARD_DAYS: 360,
  RECOMMENDED_WALKFORWARD_DAYS: 540,
} as const;

// ── Strategy Parameters (tunable) ───────────────────────────
export interface StrategyParams {
  adxThreshold: number;
  atrMultiplierSL: number;
  atrMultiplierTrailing: number;
  rMultipleTPTrend: number;
  rMultipleTPRange: number;
  partialExitThreshold: number;
  eqTolerance: number;
  maxHoldingHours: number;
}

export const DEFAULT_PARAMS: Readonly<StrategyParams> = {
  adxThreshold: 20,
  atrMultiplierSL: 1.5,
  atrMultiplierTrailing: 1.0,
  rMultipleTPTrend: 2.5,
  rMultipleTPRange: 2.0,
  partialExitThreshold: 1.5,
  eqTolerance: 0.1,
  maxHoldingHours: 24,
};

// ── Backtest Flags ──────────────────────────────────────────
export type BacktestFlag =
  | "LOW_SAMPLE"
  | "LOW_CONFIDENCE"
  | "HIGH_DRAWDOWN"
  | "STREAK_WARNING"
  | "OOS_DEGRADATION"
  | "INVALID";

// ── Data Validation ─────────────────────────────────────────
export type DataErrorCode =
  | "DATA_GAP"
  | "NON_MONOTONIC"
  | "NEGATIVE_VOLUME"
  | "OHLC_VIOLATION"
  | "INSUFFICIENT_WARMUP";

export interface DataValidationError {
  code: DataErrorCode;
  message: string;
  index?: number;
  timestamp?: string;
}

export interface DataValidationResult {
  valid: boolean;
  errors: DataValidationError[];
  tradeableCandles15m: number;
  tradeableDays: number;
}

// ══════════════════════════════════════════════════════════════
// NEW: Optimization types
// ══════════════════════════════════════════════════════════════

// ── Monte Carlo ─────────────────────────────────────────────

export interface MonteCarloConfig {
  nSims: number;
  initialEquity: number;
  ruinThreshold: number;
}

export const DEFAULT_MC_CONFIG: MonteCarloConfig = {
  nSims: 10_000,
  initialEquity: 10_000,
  ruinThreshold: 7_000,
};

export interface MonteCarloResult {
  nSims: number;
  probabilityOfRuin: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  p99MaxDrawdownPct: number;
  medianTerminalEquity: number;
  p5TerminalEquity: number;
  p95TerminalEquity: number;
  maxConsecutiveLossesP95: number;
  passed: boolean;
}

// ── Regime Segmentation ─────────────────────────────────────

export type VolatilityBucket = "HIGH" | "LOW";
export type TrendStrength = "STRONG" | "WEAK";

export interface SegmentMetrics {
  segmentName: string;
  tradeCount: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  sharpeRatio: number | null;
  maxDrawdownPct: number;
  avgHoldingMinutes: number;
  bestTradeR: number;
  worstTradeR: number;
  recoveryFactor: number;
  totalPnlUsd: number;
  pnlPctOfTotal: number;
}

export interface RegimeSegmentationReport {
  segments: SegmentMetrics[];
  regimeConsistencyPassed: boolean;
  regimeConcentrationPassed: boolean;
  volatilityStabilityPassed: boolean;
  flags: string[];
}

// ── Annual Analysis ─────────────────────────────────────────

export interface AnnualMetrics {
  year: number;
  tradeCount: number;
  totalPnlUsd: number;
  profitFactor: number;
  maxDrawdownPct: number;
  winRate: number;
  expectancy: number;
  pnlPctOfTotal: number;
}

export interface AnnualAnalysisReport {
  years: AnnualMetrics[];
  profitableYears: number;
  totalYears: number;
  worstYearDrawdown: number;
  bestYearPnlPct: number;
  passed: boolean;
  flags: string[];
}

// ── Parameter Robustness (±30%) ─────────────────────────────

export interface ParamVariationResult {
  paramName: keyof StrategyParams;
  baseValue: number;
  lowValue: number;
  highValue: number;
  basePF: number;
  lowPF: number;
  highPF: number;
  baseMaxDD: number;
  lowMaxDD: number;
  highMaxDD: number;
  robustnessRatio: number;
  drawdownRatio: number;
  fragile: boolean;
}

export interface RobustnessReport {
  params: ParamVariationResult[];
  fragileCount: number;
  passed: boolean;
}

// ── Grid Optimizer ──────────────────────────────────────────

export interface GridSearchResult {
  params: StrategyParams;
  profitFactor: number;
  sharpeRatio: number | null;
  winRate: number;
  maxDrawdownPct: number;
  totalTrades: number;
  expectancy: number;
}

export interface TieredOptimizationResult {
  tier1Top5: GridSearchResult[];
  tier2Best: GridSearchResult;
  tier3Final: GridSearchResult;
  totalCombosEvaluated: number;
}

// ── Robustness Grade ────────────────────────────────────────

export type RobustnessGrade = "A" | "B" | "C" | "F";

export interface OptimizationReport {
  optimizedParams: StrategyParams;
  grade: RobustnessGrade;
  tieredResult: TieredOptimizationResult;
  robustness: RobustnessReport;
  monteCarlo: MonteCarloResult;
  regimeSegmentation: RegimeSegmentationReport;
  annualAnalysis: AnnualAnalysisReport;
  heldOutPassed: boolean;
  heldOutPF: number;
  heldOutMaxDD: number;
  heldOutTrades: number;
  flags: string[];
}
