import type {
  ExitReason,
  IndicatorSnapshot,
  LiquidityLevels,
  Position,
  TradeLog,
} from "./types.js";

// ── UUID ─────────────────────────────────────────────────────
// Simple v4 UUID without external dependency.
function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Build Trade Log ──────────────────────────────────────────
// Called once when a position is fully closed.
// All inputs are snapshots captured at entry time except exit fields.

export function buildTradeLog(
  position: Position,
  exitPrice: number,
  exitTimestamp: string,
  exitReason: ExitReason,
  entryCandleRange: number,
  accountEquityAtEntry: number,
  liq: LiquidityLevels,
  snap: IndicatorSnapshot,
): TradeLog {
  const { direction, entryPrice, r } = position;

  // R-multiple: positive = profit, negative = loss
  const rMultipleResult =
    direction === "LONG"
      ? (exitPrice - entryPrice) / r
      : (entryPrice - exitPrice) / r;

  // P&L
  const pnlUsd =
    direction === "LONG"
      ? (exitPrice - entryPrice) * position.positionSizeBtc
      : (entryPrice - exitPrice) * position.positionSizeBtc;

  const pnlPct =
    accountEquityAtEntry > 0 ? (pnlUsd / accountEquityAtEntry) * 100 : 0;

  // Holding period
  const entryMs = new Date(position.entryTimestamp).getTime();
  const exitMs = new Date(exitTimestamp).getTime();
  const holdingPeriodMinutes = Math.round((exitMs - entryMs) / 60000);

  return {
    tradeId: uuid(),
    timestampEntry: position.entryTimestamp,
    timestampExit: exitTimestamp,
    direction,
    regime: position.regime,
    entryPrice,
    stopLossInitial: position.stopLossInitial,
    takeProfitTarget: position.takeProfit,
    exitPrice,
    exitReason,
    positionSizeBtc: position.positionSizeBtc,
    positionSizeUsd: position.positionSizeUsd,
    rMultipleResult,
    pnlUsd,
    pnlPct,
    holdingPeriodMinutes,
    pdh: liq.pdh,
    pdl: liq.pdl,
    vwapAtEntry: position.vwapAtEntry,
    atr14_15mAtEntry: position.atr14_15m,
    adx14_4hAtEntry: snap.adx14_4H,
    ema20_4hAtEntry: snap.ema20_4H,
    ema50_4hAtEntry: snap.ema50_4H,
    sweepLevel: position.sweepLevel,
    sweepType: position.sweepType,
    bosLevel: position.bosLevel,
    partialExitTriggered: position.partialExitTriggered,
    trailingStopActivated: position.trailingStop.activated,
    accountEquityAtEntry,
    entryCandleRange,
  };
}

// ── Trade Store ──────────────────────────────────────────────
// In-memory log store for backtesting. Production would persist to DB.

export class TradeStore {
  private logs: TradeLog[] = [];

  append(log: TradeLog): void {
    this.logs.push(log);
  }

  getAll(): ReadonlyArray<TradeLog> {
    return this.logs;
  }

  count(): number {
    return this.logs.length;
  }

  clear(): void {
    this.logs = [];
  }

  // ── Backtest Summary Stats ───────────────────────────────
  summary(): TradeSummary {
    const total = this.logs.length;
    if (total === 0) {
      return {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgRMultiple: 0,
        totalPnlUsd: 0,
        maxDrawdownPct: 0,
        avgHoldingMinutes: 0,
        profitFactor: 0,
      };
    }

    let wins = 0;
    let losses = 0;
    let sumR = 0;
    let totalPnl = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let sumHolding = 0;

    // Drawdown tracking
    let peak = 0;
    let equity = 0;
    let maxDrawdownPct = 0;

    for (const log of this.logs) {
      sumR += log.rMultipleResult;
      totalPnl += log.pnlUsd;
      sumHolding += log.holdingPeriodMinutes;

      if (log.pnlUsd >= 0) {
        wins++;
        grossProfit += log.pnlUsd;
      } else {
        losses++;
        grossLoss += Math.abs(log.pnlUsd);
      }

      // Equity curve for drawdown
      equity += log.pnlUsd;
      if (equity > peak) peak = equity;
      if (peak > 0) {
        const dd = ((peak - equity) / peak) * 100;
        if (dd > maxDrawdownPct) maxDrawdownPct = dd;
      }
    }

    return {
      totalTrades: total,
      wins,
      losses,
      winRate: (wins / total) * 100,
      avgRMultiple: sumR / total,
      totalPnlUsd: totalPnl,
      maxDrawdownPct,
      avgHoldingMinutes: Math.round(sumHolding / total),
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : Infinity,
    };
  }
}

// ── Summary Type ─────────────────────────────────────────────
export interface TradeSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;            // percentage
  avgRMultiple: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;     // percentage
  avgHoldingMinutes: number;
  profitFactor: number;       // grossProfit / grossLoss
}
