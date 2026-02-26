import { describe, it, expect } from "vitest";
import type { TradeLog, Candle, Regime, SweepType } from "../src/strategy/types";
import type { StrategyParams } from "../src/strategy/backtestTypes";
import { DEFAULT_PARAMS } from "../src/strategy/backtestTypes";
import { runMonteCarlo } from "../src/strategy/monteCarlo";
import { runRegimeSegmentation } from "../src/strategy/regimeSegmentation";
import { runAnnualAnalysis } from "../src/strategy/annualAnalysis";
import { runParameterRobustness } from "../src/strategy/parameterRobustness";
import { runTieredOptimization } from "../src/strategy/gridOptimizer";
import { runOptimizationPipeline } from "../src/strategy/optimizedOrchestrator";

// ── Shared Helpers ──────────────────────────────────────────

let tradeCounter = 0;

function makeTrade(overrides: Partial<TradeLog> = {}): TradeLog {
  tradeCounter++;
  return {
    tradeId: `test-${tradeCounter}`,
    timestampEntry: overrides.timestampEntry ?? "2024-06-15T10:00:00Z",
    timestampExit: overrides.timestampExit ?? "2024-06-15T14:00:00Z",
    direction: "LONG",
    regime: "TREND_UP",
    entryPrice: 42000,
    stopLossInitial: 41500,
    takeProfitTarget: 43000,
    exitPrice: 42500,
    exitReason: "TP_HIT",
    positionSizeBtc: 0.1,
    positionSizeUsd: 4200,
    rMultipleResult: 1.0,
    pnlUsd: 50,
    pnlPct: 0.5,
    holdingPeriodMinutes: 240,
    pdh: 42500,
    pdl: 41000,
    vwapAtEntry: 42100,
    atr14_15mAtEntry: 200,
    adx14_4hAtEntry: 25,
    ema20_4hAtEntry: 41800,
    ema50_4hAtEntry: 41500,
    sweepLevel: 41000,
    sweepType: "PDL" as SweepType,
    bosLevel: 42200,
    partialExitTriggered: false,
    trailingStopActivated: false,
    accountEquityAtEntry: 10000,
    entryCandleRange: 150,
    ...overrides,
  };
}

function makeCandle(
  timeframe: "15m" | "4H" | "1D",
  timestamp: string,
  price: number,
  spread = 50,
): Candle {
  return {
    timestamp,
    open: price,
    high: price + spread,
    low: price - spread,
    close: price + spread * 0.3,
    volume: 100,
    timeframe,
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Monte Carlo
// ═══════════════════════════════════════════════════════════════

describe("monteCarlo", () => {
  it("all-positive PnL → ruin probability 0", () => {
    const trades = Array.from({ length: 100 }, () =>
      makeTrade({ pnlUsd: 100 }),
    );
    const result = runMonteCarlo(trades, {
      nSims: 1000,
      initialEquity: 10000,
      ruinThreshold: 7000,
    });

    expect(result.probabilityOfRuin).toBe(0);
    expect(result.medianTerminalEquity).toBeGreaterThan(10000);
    expect(result.passed).toBe(true);
  });

  it("alternating +$50/-$50 → median terminal ≈ initial", () => {
    const trades = Array.from({ length: 100 }, (_, i) =>
      makeTrade({ pnlUsd: i % 2 === 0 ? 50 : -50 }),
    );
    const result = runMonteCarlo(trades, {
      nSims: 1000,
      initialEquity: 10000,
      ruinThreshold: 7000,
    });

    // Net PnL is 0 → terminal should be close to initial
    expect(result.medianTerminalEquity).toBeCloseTo(10000, -1);
  });

  it("80% large losses → high ruin probability, passed=false", () => {
    const trades = Array.from({ length: 100 }, (_, i) =>
      makeTrade({ pnlUsd: i % 5 === 0 ? 200 : -500 }),
    );
    const result = runMonteCarlo(trades, {
      nSims: 1000,
      initialEquity: 10000,
      ruinThreshold: 7000,
    });

    expect(result.probabilityOfRuin).toBeGreaterThan(0.5);
    expect(result.passed).toBe(false);
  });

  it("empty trades → ruin=1, passed=false", () => {
    const result = runMonteCarlo([], {
      nSims: 100,
      initialEquity: 10000,
      ruinThreshold: 7000,
    });

    expect(result.probabilityOfRuin).toBe(1);
    expect(result.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Regime Segmentation
// ═══════════════════════════════════════════════════════════════

describe("regimeSegmentation", () => {
  it("balanced regimes → 7 segments created", () => {
    const regimes: Regime[] = ["TREND_UP", "TREND_DOWN", "RANGE"];
    const trades: TradeLog[] = [];
    for (const regime of regimes) {
      for (let i = 0; i < 20; i++) {
        trades.push(
          makeTrade({
            regime,
            pnlUsd: 100,
            rMultipleResult: 1.5,
            adx14_4hAtEntry: regime === "RANGE" ? 18 : 30,
            atr14_15mAtEntry: i < 10 ? 100 : 300,
          }),
        );
      }
    }

    const report = runRegimeSegmentation(trades);

    // 3 regime + 2 volatility + 2 trend strength = 7
    expect(report.segments).toHaveLength(7);
    expect(report.regimeConsistencyPassed).toBe(true);
    expect(report.regimeConcentrationPassed).toBe(true);
  });

  it("100% concentration in one regime → REGIME_CONCENTRATION_RISK", () => {
    const trades = Array.from({ length: 30 }, () =>
      makeTrade({
        regime: "TREND_UP",
        pnlUsd: 100,
        rMultipleResult: 1.5,
      }),
    );

    const report = runRegimeSegmentation(trades);

    expect(report.regimeConcentrationPassed).toBe(false);
    expect(report.flags).toContain("REGIME_CONCENTRATION_RISK");
  });

  it("regime PF below threshold → regimeConsistencyPassed=false", () => {
    const trades: TradeLog[] = [];
    // TREND_UP: all losses → PF = 0 (below 1.2)
    for (let i = 0; i < 20; i++) {
      trades.push(
        makeTrade({
          regime: "TREND_UP",
          pnlUsd: -100,
          rMultipleResult: -1.0,
        }),
      );
    }
    // TREND_DOWN & RANGE: profitable
    for (let i = 0; i < 20; i++) {
      trades.push(
        makeTrade({
          regime: "TREND_DOWN",
          pnlUsd: 100,
          rMultipleResult: 1.5,
        }),
      );
    }
    for (let i = 0; i < 20; i++) {
      trades.push(
        makeTrade({
          regime: "RANGE",
          pnlUsd: 100,
          rMultipleResult: 1.5,
        }),
      );
    }

    const report = runRegimeSegmentation(trades);

    expect(report.regimeConsistencyPassed).toBe(false);
    expect(report.flags).toContain("REGIME_CONSISTENCY_FAIL");
  });

  it("empty trades → all segment counts 0", () => {
    const report = runRegimeSegmentation([]);

    for (const seg of report.segments) {
      expect(seg.tradeCount).toBe(0);
    }
    expect(report.regimeConsistencyPassed).toBe(true);
    expect(report.regimeConcentrationPassed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Annual Analysis
// ═══════════════════════════════════════════════════════════════

describe("annualAnalysis", () => {
  it("trades spanning 3 years → totalYears=3", () => {
    const trades = [
      makeTrade({ timestampEntry: "2023-03-15T10:00:00Z", pnlUsd: 500 }),
      makeTrade({ timestampEntry: "2024-06-15T10:00:00Z", pnlUsd: 500 }),
      makeTrade({ timestampEntry: "2025-09-15T10:00:00Z", pnlUsd: 500 }),
    ];

    const report = runAnnualAnalysis(trades);

    expect(report.totalYears).toBe(3);
    expect(report.years.map((y) => y.year)).toEqual([2023, 2024, 2025]);
  });

  it("all 3 years profitable → passed=true", () => {
    const trades: TradeLog[] = [];
    for (const year of [2023, 2024, 2025]) {
      for (let i = 0; i < 10; i++) {
        trades.push(
          makeTrade({
            timestampEntry: `${year}-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
            pnlUsd: 200,
            rMultipleResult: 1.5,
          }),
        );
      }
    }

    const report = runAnnualAnalysis(trades);

    expect(report.profitableYears).toBe(3);
    expect(report.passed).toBe(true);
  });

  it("1 of 3 profitable → passed=false, INSUFFICIENT_YEARLY_PROFIT", () => {
    const trades: TradeLog[] = [];
    // 2023: profitable
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2023-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: 300,
        }),
      );
    }
    // 2024: losing
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2024-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: -200,
        }),
      );
    }
    // 2025: losing
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2025-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: -200,
        }),
      );
    }

    const report = runAnnualAnalysis(trades);

    expect(report.profitableYears).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.flags).toContain("INSUFFICIENT_YEARLY_PROFIT");
  });

  it("single year >70% of total PnL → SINGLE_YEAR_DOMINANCE", () => {
    const trades: TradeLog[] = [];
    // 2023: dominates
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2023-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: 1000,
        }),
      );
    }
    // 2024: tiny profit
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2024-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: 10,
        }),
      );
    }
    // 2025: tiny profit
    for (let i = 0; i < 10; i++) {
      trades.push(
        makeTrade({
          timestampEntry: `2025-06-${String(i + 1).padStart(2, "0")}T10:00:00Z`,
          pnlUsd: 10,
        }),
      );
    }

    const report = runAnnualAnalysis(trades);

    expect(report.flags).toContain("SINGLE_YEAR_DOMINANCE");
    expect(report.passed).toBe(false);
  });

  it("empty trades → passed=false, NO_TRADES", () => {
    const report = runAnnualAnalysis([]);

    expect(report.passed).toBe(false);
    expect(report.totalYears).toBe(0);
    expect(report.flags).toContain("NO_TRADES");
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Parameter Robustness
// ═══════════════════════════════════════════════════════════════

describe("parameterRobustness", () => {
  const baseParams: StrategyParams = { ...DEFAULT_PARAMS };

  function makeProfitableTrades(count: number, winPnl = 200, lossPnl = -80): TradeLog[] {
    // ~67% wins → PF ≈ (67*200)/(33*80) ≈ 5.0
    return Array.from({ length: count }, (_, i) =>
      makeTrade({ pnlUsd: i % 3 < 2 ? winPnl : lossPnl }),
    );
  }

  it("all variants PF > 1.0 → fragileCount=0, passed=true", () => {
    const backtestFn = () => makeProfitableTrades(50);
    const report = runParameterRobustness(backtestFn, baseParams, 10000, 180);

    expect(report.fragileCount).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("one param variant PF < 1.0 → that param fragile=true", () => {
    const backtestFn = (params: StrategyParams) => {
      // When adxThreshold is varied from default (20), return all losses
      if (params.adxThreshold !== baseParams.adxThreshold) {
        return Array.from({ length: 50 }, () => makeTrade({ pnlUsd: -100 }));
      }
      return makeProfitableTrades(50);
    };

    const report = runParameterRobustness(backtestFn, baseParams, 10000, 180);

    const adxResult = report.params.find((p) => p.paramName === "adxThreshold");
    expect(adxResult?.fragile).toBe(true);
    expect(report.fragileCount).toBeGreaterThanOrEqual(1);
  });

  it(">2 fragile params → passed=false", () => {
    const fragileParams = new Set(["adxThreshold", "atrMultiplierSL", "rMultipleTPTrend"]);
    const backtestFn = (params: StrategyParams) => {
      for (const name of fragileParams) {
        if (params[name as keyof StrategyParams] !== baseParams[name as keyof StrategyParams]) {
          return Array.from({ length: 50 }, () => makeTrade({ pnlUsd: -100 }));
        }
      }
      return makeProfitableTrades(50);
    };

    const report = runParameterRobustness(backtestFn, baseParams, 10000, 180);

    expect(report.fragileCount).toBeGreaterThan(2);
    expect(report.passed).toBe(false);
  });

  it("all 8 StrategyParams are tested", () => {
    const backtestFn = () => makeProfitableTrades(50);
    const report = runParameterRobustness(backtestFn, baseParams, 10000, 180);

    expect(report.params).toHaveLength(8);
    const names = report.params.map((p) => p.paramName);
    expect(names).toContain("adxThreshold");
    expect(names).toContain("atrMultiplierSL");
    expect(names).toContain("atrMultiplierTrailing");
    expect(names).toContain("rMultipleTPTrend");
    expect(names).toContain("rMultipleTPRange");
    expect(names).toContain("partialExitThreshold");
    expect(names).toContain("eqTolerance");
    expect(names).toContain("maxHoldingHours");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Grid Optimizer
// ═══════════════════════════════════════════════════════════════

describe("gridOptimizer", () => {
  function makeGridTrades(params: StrategyParams): TradeLog[] {
    // Use adxThreshold to drive profitability deterministically
    // Higher adxThreshold → more wins → higher PF
    const winRatio = Math.min(0.9, params.adxThreshold / 28);
    return Array.from({ length: 40 }, (_, i) =>
      makeTrade({
        pnlUsd: i / 40 < winRatio ? 150 : -100,
        rMultipleResult: i / 40 < winRatio ? 1.5 : -1.0,
        accountEquityAtEntry: 10000,
      }),
    );
  }

  it("tier1Top5 has at most 5 results sorted by PF desc", () => {
    const result = runTieredOptimization(makeGridTrades, 10000, 180);

    expect(result.tier1Top5.length).toBeLessThanOrEqual(5);
    expect(result.tier1Top5.length).toBeGreaterThan(0);

    // Verify sorted by PF descending
    for (let i = 1; i < result.tier1Top5.length; i++) {
      const prevPF = isFinite(result.tier1Top5[i - 1].profitFactor)
        ? result.tier1Top5[i - 1].profitFactor
        : 0;
      const curPF = isFinite(result.tier1Top5[i].profitFactor)
        ? result.tier1Top5[i].profitFactor
        : 0;
      expect(prevPF).toBeGreaterThanOrEqual(curPF);
    }
  });

  it("tier2Best refines from tier1Top5 base params", () => {
    const result = runTieredOptimization(makeGridTrades, 10000, 180);

    // tier2Best should have one of the tier1Top5 primary param values
    const tier1AdxValues = result.tier1Top5.map((r) => r.params.adxThreshold);
    expect(tier1AdxValues).toContain(result.tier2Best.params.adxThreshold);
  });

  it("tier3Final includes maxHoldingHours from TIER3_RANGES", () => {
    const result = runTieredOptimization(makeGridTrades, 10000, 180);

    const validHours = [12, 18, 24, 36, 48];
    expect(validHours).toContain(result.tier3Final.params.maxHoldingHours);
  });

  it("totalCombosEvaluated > 0", () => {
    const result = runTieredOptimization(makeGridTrades, 10000, 180);

    expect(result.totalCombosEvaluated).toBeGreaterThan(0);
    // Tier 1 alone is 7*5*4*3 = 420
    expect(result.totalCombosEvaluated).toBeGreaterThanOrEqual(420);
  });

  it("<30 trades → fallback behavior", () => {
    const fewTradesFn = () =>
      Array.from({ length: 20 }, () => makeTrade({ pnlUsd: 100 }));

    const result = runTieredOptimization(fewTradesFn, 10000, 180);

    // All combos evaluated but none qualify → tier1Top5 empty, fallback defaults
    expect(result.tier1Top5).toHaveLength(0);
    expect(result.tier2Best.params).toEqual(DEFAULT_PARAMS);
    expect(result.totalCombosEvaluated).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. Integration: Optimized Orchestrator
// ═══════════════════════════════════════════════════════════════

describe("optimizedOrchestrator", { timeout: 120_000 }, () => {
  function generateSyntheticCandles(
    timeframe: "15m" | "4H" | "1D",
    days: number,
    startPrice: number,
    startDate: Date,
  ): Candle[] {
    const intervalMs =
      timeframe === "15m"
        ? 15 * 60 * 1000
        : timeframe === "4H"
          ? 4 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;

    const candlesPerDay =
      timeframe === "15m" ? 96 : timeframe === "4H" ? 6 : 1;
    const count = days * candlesPerDay;

    const candles: Candle[] = [];
    let price = startPrice;
    let time = startDate.getTime();

    for (let i = 0; i < count; i++) {
      const phase = i / count;
      // Trending up first 40%, range 20%, trending down 40%
      const drift =
        phase < 0.4 ? 0.002 : phase < 0.6 ? 0.0001 : -0.003;
      const noise = (Math.random() - 0.5) * 0.003;

      const open = price;
      const change = price * (drift + noise);
      const close = price + change;
      const high =
        Math.max(open, close) + Math.abs(change) * (0.5 + Math.random());
      const low =
        Math.min(open, close) - Math.abs(change) * (0.5 + Math.random());
      const volume = 10 + Math.random() * 90;

      candles.push({
        timestamp: new Date(time).toISOString(),
        open,
        high: Math.max(high, Math.max(open, close)),
        low: Math.min(low, Math.min(open, close)),
        close,
        volume,
        timeframe,
      });

      price = close;
      time += intervalMs;
    }

    return candles;
  }

  it("returns a valid OptimizationReport with all fields", () => {
    const startDate = new Date("2023-01-01T00:00:00Z");
    const days = 270; // Need enough for 90-day held-out + training + walk-forward

    const candles15m = generateSyntheticCandles("15m", days, 42000, startDate);
    const candles4H = generateSyntheticCandles("4H", days, 42000, startDate);
    const candles1D = generateSyntheticCandles("1D", days, 42000, startDate);

    const report = runOptimizationPipeline(candles15m, candles4H, candles1D, {
      accountEquity: 100_000,
      mcConfig: { nSims: 100, initialEquity: 100_000, ruinThreshold: 70_000 },
    });

    // Report structure
    expect(report).toHaveProperty("optimizedParams");
    expect(report).toHaveProperty("grade");
    expect(report).toHaveProperty("tieredResult");
    expect(report).toHaveProperty("robustness");
    expect(report).toHaveProperty("monteCarlo");
    expect(report).toHaveProperty("regimeSegmentation");
    expect(report).toHaveProperty("annualAnalysis");
    expect(report).toHaveProperty("flags");

    // Grade is valid
    expect(["A", "B", "C", "F"]).toContain(report.grade);

    // optimizedParams has all 8 keys
    const paramKeys = Object.keys(report.optimizedParams);
    expect(paramKeys).toContain("adxThreshold");
    expect(paramKeys).toContain("atrMultiplierSL");
    expect(paramKeys).toContain("atrMultiplierTrailing");
    expect(paramKeys).toContain("rMultipleTPTrend");
    expect(paramKeys).toContain("rMultipleTPRange");
    expect(paramKeys).toContain("partialExitThreshold");
    expect(paramKeys).toContain("eqTolerance");
    expect(paramKeys).toContain("maxHoldingHours");

    // Tiered result was evaluated
    expect(report.tieredResult.totalCombosEvaluated).toBeGreaterThan(0);
  });
});
