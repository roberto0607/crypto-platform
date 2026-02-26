import type {
  Candle,
  EntrySignal,
  ExitReason,
  IndicatorSnapshot,
  InvalidationReason,
  LiquidityLevels,
  PendingSetup,
  Position,
  Regime,
  TradeLog,
  VwapState,
} from "./types.js";
import { TIMEFRAMES } from "./types.js";
import type { StrategyParams } from "./backtestTypes.js";
import { DEFAULT_PARAMS } from "./backtestTypes.js";
import { resetVwap, updateVwap, ema, atr, adx } from "./indicators.js";
import { classifyRegime } from "./regime.js";
import {
  pdh,
  pdl,
  sessionHigh,
  sessionLow,
  findEqualHighs,
  findEqualLows,
} from "./liquidity.js";
import { scanLongEntry, scanShortEntry } from "./signals.js";
import {
  computeStopLoss,
  computeTakeProfit,
  initTrailingStop,
  updateTrailingStop,
  shouldPartialExit,
  shouldTimeExit,
  checkSlTp,
} from "./exits.js";
import { computePositionSize } from "./sizing.js";
import {
  checkInvalidation,
  checkCandleRangeFilter,
} from "./invalidation.js";
import { buildTradeLog, TradeStore } from "./tradeLogger.js";

// ── Max concurrent positions ─────────────────────────────────
const MAX_OPEN_POSITIONS = 2;

// ── Engine Config ────────────────────────────────────────────
export interface EngineConfig {
  accountEquity: number;
  params?: Partial<StrategyParams>;
}

// ── Engine Event ─────────────────────────────────────────────
export type EngineEvent =
  | { type: "REGIME_CHANGE"; from: Regime; to: Regime }
  | { type: "SETUP_DETECTED"; setup: PendingSetup }
  | { type: "SETUP_INVALIDATED"; reason: InvalidationReason }
  | { type: "ENTRY"; signal: EntrySignal; position: Position }
  | { type: "PARTIAL_EXIT"; position: Position; exitPrice: number }
  | { type: "EXIT"; log: TradeLog }
  | { type: "VWAP_RESET" }
  | { type: "DAILY_LEVELS_UPDATED"; pdh: number; pdl: number };

// ── Strategy Engine ──────────────────────────────────────────
export class StrategyEngine {
  // Tunable parameters (merged defaults + overrides)
  private readonly params: StrategyParams;
  private readonly maxHoldingMs: number;

  // State
  private regime: Regime = "NO_TRADE";
  private vwapState: VwapState = resetVwap();
  private liq: LiquidityLevels = {
    pdh: 0, pdl: 0, eqh: null, eql: null, sessionHigh: 0, sessionLow: Infinity,
  };
  private snap: IndicatorSnapshot = {
    ema20_4H: 0, ema50_4H: 0, adx14_4H: 0, atr14_4H: 0, atr14_15m: 0,
    close4H: 0, vwapDaily: null,
  };

  // Candle history
  private candles15m: Candle[] = [];
  private candles4H: Candle[] = [];
  private sessionCandles: Candle[] = [];

  // Active state
  private pendingSetup: PendingSetup | null = null;
  private openPositions: Position[] = [];
  private accountEquity: number;

  // Output
  readonly tradeStore = new TradeStore();
  private events: EngineEvent[] = [];

  constructor(config: EngineConfig) {
    this.accountEquity = config.accountEquity;
    this.params = { ...DEFAULT_PARAMS, ...config.params };
    this.maxHoldingMs = this.params.maxHoldingHours * 60 * 60 * 1000;
  }

  // ── Public: flush events since last call ─────────────────
  flushEvents(): EngineEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ── Public: feed a completed daily candle ────────────────
  onDailyCandle(candle: Candle): void {
    this.liq.pdh = pdh(candle);
    this.liq.pdl = pdl(candle);

    this.sessionCandles = [];
    this.vwapState = resetVwap();
    this.snap.vwapDaily = null;

    this.emit({ type: "VWAP_RESET" });
    this.emit({ type: "DAILY_LEVELS_UPDATED", pdh: this.liq.pdh, pdl: this.liq.pdl });
  }

  // ── Public: feed a completed 4H candle ───────────────────
  on4HCandle(candle: Candle): void {
    this.candles4H.push(candle);
    if (this.candles4H.length > 60) {
      this.candles4H = this.candles4H.slice(-60);
    }

    this.recomputeBiasIndicators();

    const prevRegime = this.regime;
    this.regime = classifyRegime(this.snap, this.params.adxThreshold);
    if (this.regime !== prevRegime) {
      this.emit({ type: "REGIME_CHANGE", from: prevRegime, to: this.regime });
    }
  }

  // ── Public: feed a completed 15m candle ──────────────────
  onCandle(candle: Candle): void {
    this.candles15m.push(candle);
    if (this.candles15m.length > 100) {
      this.candles15m = this.candles15m.slice(-100);
    }
    this.sessionCandles.push(candle);

    this.vwapState = updateVwap(this.vwapState, candle);
    this.snap.vwapDaily = this.vwapState.value;

    const atr15m = atr(this.candles15m, 14);
    if (atr15m !== null) this.snap.atr14_15m = atr15m;

    this.liq.sessionHigh = sessionHigh(this.sessionCandles);
    this.liq.sessionLow = sessionLow(this.sessionCandles);
    this.liq.eqh = findEqualHighs(this.candles15m, this.snap.atr14_15m, this.params.eqTolerance);
    this.liq.eql = findEqualLows(this.candles15m, this.snap.atr14_15m, this.params.eqTolerance);

    this.processOpenPositions(candle);
    this.processPendingSetup(candle);

    if (
      this.pendingSetup === null &&
      this.openPositions.length < MAX_OPEN_POSITIONS &&
      this.snap.vwapDaily !== null &&
      this.snap.atr14_15m > 0
    ) {
      this.scanForEntry();
    }
  }

  // ── Process open positions ───────────────────────────────
  private processOpenPositions(candle: Candle): void {
    const remaining: Position[] = [];

    for (const pos of this.openPositions) {
      if (shouldTimeExit(pos.entryTimestamp, candle.timestamp, this.maxHoldingMs)) {
        this.closePosition(pos, candle.close, candle.timestamp, "TIME_EXIT", candle);
        continue;
      }

      const hitResult = checkSlTp(pos.direction, pos.stopLoss, pos.takeProfit, candle);
      if (hitResult !== null) {
        const exitPrice =
          hitResult === "SL_HIT" || hitResult === "TRAILING_STOP"
            ? pos.stopLoss
            : pos.takeProfit;
        const reason: ExitReason = pos.trailingStop.activated && hitResult === "SL_HIT"
          ? "TRAILING_STOP"
          : hitResult;
        this.closePosition(pos, exitPrice, candle.timestamp, reason, candle);
        continue;
      }

      const updatedTrailing = updateTrailingStop(
        pos.trailingStop,
        pos.direction,
        pos.entryPrice,
        pos.r,
        candle,
        this.snap.atr14_15m,
        this.params.atrMultiplierTrailing,
      );
      pos.trailingStop = updatedTrailing;
      if (updatedTrailing.activated) {
        pos.stopLoss = updatedTrailing.currentStop;
      }

      if (
        !pos.partialExitTriggered &&
        shouldPartialExit(pos.direction, pos.entryPrice, pos.r, candle.close, this.params.partialExitThreshold)
      ) {
        pos.partialExitTriggered = true;
        pos.positionSizeBtc *= 0.5;
        pos.positionSizeUsd *= 0.5;
        pos.stopLoss = pos.entryPrice;
        this.emit({ type: "PARTIAL_EXIT", position: pos, exitPrice: candle.close });
      }

      remaining.push(pos);
    }

    this.openPositions = remaining;
  }

  // ── Process pending setup invalidation ───────────────────
  private processPendingSetup(candle: Candle): void {
    if (this.pendingSetup === null) return;

    const idx = this.candles15m.length - 1;

    const reason = checkInvalidation(
      this.pendingSetup,
      this.regime,
      candle,
      idx,
      this.snap.atr14_15m,
      this.snap.adx14_4H,
      this.liq,
    );

    if (reason !== null) {
      this.emit({ type: "SETUP_INVALIDATED", reason });
      this.pendingSetup = null;
    }
  }

  // ── Scan for new entry signals ───────────────────────────
  private scanForEntry(): void {
    const vwap = this.snap.vwapDaily!;
    const atr15m = this.snap.atr14_15m;

    const longSig = scanLongEntry(
      this.candles15m, this.regime, this.liq, vwap, atr15m,
    );
    if (longSig !== null) {
      this.tryOpenPosition(longSig);
      return;
    }

    const shortSig = scanShortEntry(
      this.candles15m, this.regime, this.liq, vwap, atr15m,
    );
    if (shortSig !== null) {
      this.tryOpenPosition(shortSig);
    }
  }

  // ── Open a position from a confirmed signal ──────────────
  private tryOpenPosition(signal: EntrySignal): void {
    const entryCandle = this.candles15m[signal.entryIndex];

    const rangeCheck = checkCandleRangeFilter(entryCandle, signal.atr14_15m);
    if (rangeCheck !== null) {
      this.emit({ type: "SETUP_INVALIDATED", reason: rangeCheck });
      return;
    }

    const sl = computeStopLoss(
      signal.direction,
      signal.entryPrice,
      this.candles15m,
      signal.entryIndex,
      signal.atr14_15m,
      this.params.atrMultiplierSL,
    );

    const size = computePositionSize(
      this.accountEquity,
      signal.entryPrice,
      sl.final,
    );
    if (size.positionSizeBtc <= 0) return;

    const tp = computeTakeProfit(
      signal.direction,
      signal.regime,
      signal.entryPrice,
      size.r,
      signal.atr14_15m,
      signal.vwapAtEntry,
      this.liq,
      this.params.rMultipleTPTrend,
      this.params.rMultipleTPRange,
    );

    const position: Position = {
      direction: signal.direction,
      regime: signal.regime,
      entryPrice: signal.entryPrice,
      entryIndex: signal.entryIndex,
      entryTimestamp: entryCandle.timestamp,
      stopLoss: sl.final,
      stopLossInitial: sl.final,
      takeProfit: tp.final,
      r: size.r,
      positionSizeBtc: size.positionSizeBtc,
      positionSizeUsd: size.positionSizeUsd,
      partialExitTriggered: false,
      trailingStop: initTrailingStop(sl.final, signal.entryPrice),
      sweepLevel: signal.sweepLevel,
      sweepType: signal.sweepType,
      bosLevel: signal.bosLevel,
      vwapAtEntry: signal.vwapAtEntry,
      atr14_15m: signal.atr14_15m,
    };

    this.openPositions.push(position);
    this.pendingSetup = null;
    this.emit({ type: "ENTRY", signal, position });
  }

  // ── Close a position and log ─────────────────────────────
  private closePosition(
    pos: Position,
    exitPrice: number,
    exitTimestamp: string,
    exitReason: ExitReason,
    exitCandle: Candle,
  ): void {
    const entryCandleRange =
      pos.entryIndex < this.candles15m.length
        ? this.candles15m[pos.entryIndex].high - this.candles15m[pos.entryIndex].low
        : 0;

    const log = buildTradeLog(
      pos,
      exitPrice,
      exitTimestamp,
      exitReason,
      entryCandleRange,
      this.accountEquity,
      this.liq,
      this.snap,
    );

    this.tradeStore.append(log);
    this.accountEquity += log.pnlUsd;
    this.emit({ type: "EXIT", log });
  }

  // ── Recompute 4H indicators ──────────────────────────────
  private recomputeBiasIndicators(): void {
    const closes = this.candles4H.map((c) => c.close);

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const adx14 = adx(this.candles4H, 14);
    const atr14 = atr(this.candles4H, 14);

    if (ema20 !== null) this.snap.ema20_4H = ema20;
    if (ema50 !== null) this.snap.ema50_4H = ema50;
    if (adx14 !== null) this.snap.adx14_4H = adx14;
    if (atr14 !== null) this.snap.atr14_4H = atr14;
    if (closes.length > 0) this.snap.close4H = closes[closes.length - 1];
  }

  // ── Emit event ───────────────────────────────────────────
  private emit(event: EngineEvent): void {
    this.events.push(event);
  }

  // ── Getters ──────────────────────────────────────────────
  getRegime(): Regime { return this.regime; }
  getVwap(): number | null { return this.snap.vwapDaily; }
  getLiquidity(): Readonly<LiquidityLevels> { return this.liq; }
  getSnapshot(): Readonly<IndicatorSnapshot> { return this.snap; }
  getOpenPositions(): ReadonlyArray<Position> { return this.openPositions; }
  getPendingSetup(): Readonly<PendingSetup> | null { return this.pendingSetup; }
  getEquity(): number { return this.accountEquity; }
  getParams(): Readonly<StrategyParams> { return this.params; }
}

