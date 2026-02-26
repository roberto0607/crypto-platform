import type { Candle, TradeLog } from "./types.js";
import type {
  StrategyParams,
  OptimizationReport,
  RobustnessGrade,
  MonteCarloConfig,
} from "./backtestTypes.js";
import { DEFAULT_MC_CONFIG, SAMPLE_THRESHOLDS } from "./backtestTypes.js";
import { BacktestRunner } from "./backtestRunner.js";
import { computeBacktestMetrics } from "./backtestMetrics.js";
import { runTieredOptimization } from "./gridOptimizer.js";
import { runParameterRobustness } from "./parameterRobustness.js";
import { runMonteCarlo } from "./monteCarlo.js";
import { runRegimeSegmentation } from "./regimeSegmentation.js";
import { runAnnualAnalysis } from "./annualAnalysis.js";
import { runWalkForward, DEFAULT_WF_CONFIG } from "./walkForward.js";

// ── Constants ───────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HELD_OUT_DAYS = 90;

// ── Orchestrator Config ─────────────────────────────────────

export interface OrchestratorConfig {
  accountEquity: number;
  mcConfig?: MonteCarloConfig;
}

// ── Assign Grade ────────────────────────────────────────────

function assignGrade(
  fragileCount: number,
  oosPF: number,
  ruinProb: number,
  profitableYears: number,
  totalYears: number,
  allRegimePFsAbove110: boolean,
): RobustnessGrade {
  const minProfYears = totalYears >= 3 ? totalYears : totalYears;

  // Grade A
  if (
    fragileCount === 0 &&
    oosPF >= 1.3 &&
    ruinProb <= 0.02 &&
    profitableYears >= minProfYears &&
    allRegimePFsAbove110
  ) {
    return "A";
  }

  // Grade B
  if (
    fragileCount <= 1 &&
    oosPF >= 1.2 &&
    ruinProb <= 0.05 &&
    profitableYears >= Math.max(totalYears - 1, 1)
  ) {
    return "B";
  }

  // Grade C
  if (
    fragileCount <= 2 &&
    oosPF >= 1.1 &&
    ruinProb <= 0.1 &&
    profitableYears >= Math.max(totalYears - 1, 1)
  ) {
    return "C";
  }

  return "F";
}

// ── Run Full Optimization Pipeline ──────────────────────────

export function runOptimizationPipeline(
  candles15m: Candle[],
  candles4H: Candle[],
  candles1D: Candle[],
  config: OrchestratorConfig,
): OptimizationReport {
  const { accountEquity, mcConfig = DEFAULT_MC_CONFIG } = config;
  const flags: string[] = [];

  // ── Split held-out period (most recent 90 days) ───────────
  const dataEndMs = new Date(
    candles15m[candles15m.length - 1].timestamp,
  ).getTime();
  const heldOutStartMs = dataEndMs - HELD_OUT_DAYS * MS_PER_DAY;

  const trainCandles15m = candles15m.filter(
    (c) => new Date(c.timestamp).getTime() < heldOutStartMs,
  );
  const trainCandles4H = candles4H.filter(
    (c) => new Date(c.timestamp).getTime() < heldOutStartMs,
  );
  const trainCandles1D = candles1D.filter(
    (c) => new Date(c.timestamp).getTime() < heldOutStartMs,
  );

  const heldOutCandles15m = candles15m.filter(
    (c) => new Date(c.timestamp).getTime() >= heldOutStartMs,
  );
  const heldOutCandles4H = candles4H.filter(
    (c) => new Date(c.timestamp).getTime() >= heldOutStartMs,
  );
  const heldOutCandles1D = candles1D.filter(
    (c) => new Date(c.timestamp).getTime() >= heldOutStartMs,
  );

  const trainDataStart = new Date(trainCandles15m[0].timestamp).getTime();
  const trainDays =
    (new Date(trainCandles15m[trainCandles15m.length - 1].timestamp).getTime() -
      trainDataStart) /
    MS_PER_DAY;

  // ── Step 1-3: Tiered Grid Search ──────────────────────────
  const backtestFn = (params: StrategyParams): TradeLog[] => {
    const runner = new BacktestRunner({ accountEquity, params });
    const result = runner.run(trainCandles15m, trainCandles4H, trainCandles1D);
    return result.trades;
  };

  const tieredResult = runTieredOptimization(
    backtestFn,
    accountEquity,
    Math.round(trainDays),
  );
  const optimizedParams = tieredResult.tier3Final.params;

  // ── Step 4: Sensitivity / ±30% Robustness ─────────────────
  const robustness = runParameterRobustness(
    backtestFn,
    optimizedParams,
    accountEquity,
    Math.round(trainDays),
  );

  // ── Step 5: Walk-Forward Validation ───────────────────────
  const wfReport = runWalkForward(
    trainCandles15m,
    trainCandles4H,
    trainCandles1D,
    { ...DEFAULT_WF_CONFIG, accountEquity },
  );

  // Collect OOS trades for Monte Carlo
  const oosTrades: TradeLog[] = [];
  for (const w of wfReport.windows) {
    // Re-run to get actual trade logs for OOS period
    // (WFE report has metrics but we need raw trades)
    const runner = new BacktestRunner({ accountEquity, params: optimizedParams });
    const result = runner.run(trainCandles15m, trainCandles4H, trainCandles1D);
    const oosStart = new Date(w.oosStartDate).getTime();
    const oosEnd = new Date(w.oosEndDate).getTime();
    const windowOos = result.trades.filter((t) => {
      const ms = new Date(t.timestampEntry).getTime();
      return ms >= oosStart && ms < oosEnd;
    });
    oosTrades.push(...windowOos);
  }

  // Use full optimized backtest trades if walk-forward OOS is insufficient
  const optimizedTrades = backtestFn(optimizedParams);
  const mcTrades = oosTrades.length >= SAMPLE_THRESHOLDS.HARD_MIN_TRADES
    ? oosTrades
    : optimizedTrades;

  // ── Step 6: Monte Carlo Simulation ────────────────────────
  const monteCarlo = runMonteCarlo(mcTrades, mcConfig);

  // ── Step 7: Regime Segmentation ───────────────────────────
  const regimeSegmentation = runRegimeSegmentation(optimizedTrades);

  // ── Step 8: Annual Analysis ───────────────────────────────
  const annualAnalysis = runAnnualAnalysis(optimizedTrades);

  // ── Step 9 (part 1): Held-Out Final Test ──────────────────
  const heldOutRunner = new BacktestRunner({
    accountEquity,
    params: optimizedParams,
  });
  const heldOutResult = heldOutRunner.run(
    heldOutCandles15m,
    heldOutCandles4H,
    heldOutCandles1D,
  );
  const heldOutMetrics = computeBacktestMetrics(
    heldOutResult.trades,
    accountEquity,
    HELD_OUT_DAYS,
  );

  const heldOutPassed =
    heldOutMetrics.profitFactor >= 1.0 &&
    heldOutMetrics.maxDrawdownPct <= 25 &&
    heldOutMetrics.totalTrades >= 10;

  if (!heldOutPassed) flags.push("HELD_OUT_FAIL");
  if (!wfReport.passed) flags.push("WALK_FORWARD_FAIL");
  if (!robustness.passed) flags.push("ROBUSTNESS_FAIL");
  if (!monteCarlo.passed) flags.push("MONTE_CARLO_FAIL");
  if (!regimeSegmentation.regimeConsistencyPassed) flags.push("REGIME_CONSISTENCY_FAIL");
  if (!annualAnalysis.passed) flags.push("ANNUAL_ANALYSIS_FAIL");

  // ── Step 9 (part 2): Grade Assignment ─────────────────────
  const oosPF = wfReport.meanWfe.profitFactor ?? 0;

  // Check if all regime PFs >= 1.10
  const regimePFs = regimeSegmentation.segments
    .filter((s) =>
      ["TREND_UP", "TREND_DOWN", "RANGE"].includes(s.segmentName) &&
      s.tradeCount >= SAMPLE_THRESHOLDS.MIN_TRADES_PER_REGIME,
    )
    .map((s) => s.profitFactor);
  const allRegimePFsAbove110 =
    regimePFs.length > 0 && regimePFs.every((pf) => pf >= 1.1);

  const grade = assignGrade(
    robustness.fragileCount,
    oosPF,
    monteCarlo.probabilityOfRuin,
    annualAnalysis.profitableYears,
    annualAnalysis.totalYears,
    allRegimePFsAbove110,
  );

  return {
    optimizedParams,
    grade,
    tieredResult,
    robustness,
    monteCarlo,
    regimeSegmentation,
    annualAnalysis,
    heldOutPassed,
    heldOutPF: heldOutMetrics.profitFactor,
    heldOutMaxDD: heldOutMetrics.maxDrawdownPct,
    heldOutTrades: heldOutMetrics.totalTrades,
    flags,
  };
}
