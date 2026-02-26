import type { Candle, TradeLog } from "./types.js";
import type { BacktestFlag, DataValidationResult, StrategyParams } from "./backtestTypes.js";
import { CANDLE_INTERVAL_MS, SAMPLE_THRESHOLDS } from "./backtestTypes.js";
import { StrategyEngine } from "./engine.js";
import { validateBacktestData } from "./dataValidation.js";
import { applySlippage, computeFee } from "./backtestConfig.js";

// ── Backtest Config ─────────────────────────────────────────
export interface BacktestConfig {
  accountEquity: number;
  params?: Partial<StrategyParams>;
}

// ── Equity Curve Point ──────────────────────────────────────
export interface EquityCurvePoint {
  tradeIndex: number;
  timestamp: string;
  cumulativePnl: number;
  equity: number;
  drawdownPct: number;
}

// ── Diagnostic Counts ───────────────────────────────────────
export interface DiagnosticCounts {
  regimeChanges: number;
  setupsDetected: number;
  setupsInvalidated: number;
  entries: number;
  exits: number;
}

// ── Backtest Result ─────────────────────────────────────────
export interface BacktestResult {
  validation: DataValidationResult;
  trades: TradeLog[];
  flags: BacktestFlag[];
  equityCurve: EquityCurvePoint[];
  finalEquity: number;
  diagnostics: DiagnosticCounts;
}

// ── Adjust Trade Log (slippage + fees) ──────────────────────

function adjustTradeLog(log: TradeLog): TradeLog {
  const slippedEntry = applySlippage(log.entryPrice, log.direction, "ENTRY");
  const slippedExit = applySlippage(log.exitPrice, log.direction, "EXIT");

  const r = Math.abs(slippedEntry - log.stopLossInitial);

  const grossPnl =
    log.direction === "LONG"
      ? (slippedExit - slippedEntry) * log.positionSizeBtc
      : (slippedEntry - slippedExit) * log.positionSizeBtc;

  const pnlUsd = grossPnl - computeFee(log.positionSizeUsd) - computeFee(log.positionSizeUsd);

  const rMultipleResult =
    r > 0
      ? log.direction === "LONG"
        ? (slippedExit - slippedEntry) / r
        : (slippedEntry - slippedExit) / r
      : 0;

  const pnlPct =
    log.accountEquityAtEntry > 0
      ? (pnlUsd / log.accountEquityAtEntry) * 100
      : 0;

  return {
    ...log,
    entryPrice: slippedEntry,
    exitPrice: slippedExit,
    rMultipleResult,
    pnlUsd,
    pnlPct,
  };
}

// ── Build Equity Curve ──────────────────────────────────────

function buildEquityCurve(
  trades: TradeLog[],
  startingEquity: number,
): EquityCurvePoint[] {
  const curve: EquityCurvePoint[] = [];
  let cumPnl = 0;
  let peak = startingEquity;

  for (let i = 0; i < trades.length; i++) {
    cumPnl += trades[i].pnlUsd;
    const equity = startingEquity + cumPnl;
    if (equity > peak) peak = equity;
    const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    curve.push({
      tradeIndex: i,
      timestamp: trades[i].timestampExit,
      cumulativePnl: cumPnl,
      equity,
      drawdownPct,
    });
  }

  return curve;
}

// ── Compute Flags ───────────────────────────────────────────

function computeFlags(
  trades: TradeLog[],
  equityCurve: EquityCurvePoint[],
): BacktestFlag[] {
  const flags: BacktestFlag[] = [];

  if (trades.length < SAMPLE_THRESHOLDS.HARD_MIN_TRADES) {
    flags.push("INVALID");
    return flags;
  }
  if (trades.length < SAMPLE_THRESHOLDS.SOFT_MIN_TRADES) {
    flags.push("LOW_SAMPLE");
  }

  let maxDd = 0;
  for (const pt of equityCurve) {
    if (pt.drawdownPct > maxDd) maxDd = pt.drawdownPct;
  }
  if (maxDd > 20) flags.push("HIGH_DRAWDOWN");

  let maxConsecLosses = 0;
  let streak = 0;
  for (const t of trades) {
    if (t.pnlUsd < 0) {
      streak++;
      if (streak > maxConsecLosses) maxConsecLosses = streak;
    } else {
      streak = 0;
    }
  }
  if (maxConsecLosses >= 8) flags.push("STREAK_WARNING");

  return flags;
}

// ── Backtest Runner ─────────────────────────────────────────

export class BacktestRunner {
  private readonly config: BacktestConfig;

  constructor(config: BacktestConfig) {
    this.config = config;
  }

  run(
    candles15m: Candle[],
    candles4H: Candle[],
    candles1D: Candle[],
  ): BacktestResult {
    const validation = validateBacktestData(candles15m, candles4H, candles1D);

    if (!validation.valid) {
      return {
        validation,
        trades: [],
        flags: ["INVALID"],
        equityCurve: [],
        finalEquity: this.config.accountEquity,
        diagnostics: {
          regimeChanges: 0,
          setupsDetected: 0,
          setupsInvalidated: 0,
          entries: 0,
          exits: 0,
        },
      };
    }

    const engine = new StrategyEngine({
      accountEquity: this.config.accountEquity,
      params: this.config.params,
    });

    let dailyIdx = 0;
    let fourHIdx = 0;
    const diag: DiagnosticCounts = {
      regimeChanges: 0,
      setupsDetected: 0,
      setupsInvalidated: 0,
      entries: 0,
      exits: 0,
    };

    const interval4H = CANDLE_INTERVAL_MS["4H"];
    const interval1D = CANDLE_INTERVAL_MS["1D"];

    for (const candle of candles15m) {
      const candleMs = new Date(candle.timestamp).getTime();

      while (dailyIdx < candles1D.length) {
        const closeMs =
          new Date(candles1D[dailyIdx].timestamp).getTime() + interval1D;
        if (closeMs > candleMs) break;
        engine.onDailyCandle(candles1D[dailyIdx]);
        dailyIdx++;
      }

      while (fourHIdx < candles4H.length) {
        const closeMs =
          new Date(candles4H[fourHIdx].timestamp).getTime() + interval4H;
        if (closeMs > candleMs) break;
        engine.on4HCandle(candles4H[fourHIdx]);
        fourHIdx++;
      }

      engine.onCandle(candle);

      for (const event of engine.flushEvents()) {
        switch (event.type) {
          case "REGIME_CHANGE":
            diag.regimeChanges++;
            break;
          case "SETUP_DETECTED":
            diag.setupsDetected++;
            break;
          case "SETUP_INVALIDATED":
            diag.setupsInvalidated++;
            break;
          case "ENTRY":
            diag.entries++;
            break;
          case "EXIT":
            diag.exits++;
            break;
        }
      }
    }

    const trades = [...engine.tradeStore.getAll()].map(adjustTradeLog);
    const equityCurve = buildEquityCurve(trades, this.config.accountEquity);
    const flags = computeFlags(trades, equityCurve);

    const finalEquity =
      equityCurve.length > 0
        ? equityCurve[equityCurve.length - 1].equity
        : this.config.accountEquity;

    return {
      validation,
      trades,
      flags,
      equityCurve,
      finalEquity,
      diagnostics: diag,
    };
  }
}
