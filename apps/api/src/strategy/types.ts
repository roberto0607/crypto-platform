// ── Timeframe ──
export type Timeframe = "15m" | "4H" | "1D";

export const TIMEFRAMES = {
    BIAS: "4H" as const,
    EXECUTION: "15m" as const,
    LIQUIDITY_REF: "1D" as const,
};

// --- Candle ---
export interface Candle {
    timestamp: string; // ISO 8601 candle open time (UTC)
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; // base-asset units
    timeframe: Timeframe;
}

// --VWAP State --
// Accumulator reset at 00:00 UTC each day
export interface VwapState {
    cumulativeTpVol: number; //sum(tp_k * volume_k)
    cumulativeVol: number; //sum(volume_k)
    value: number | null; //null until first 15m candle closes
}

// --Indicator Snapshot --
// All indicator values at a point in time, used as input to regime/signal logic
export interface IndicatorSnapshot {
    ema20_4H: number;
    ema50_4H: number;
    adx14_4H: number;
    atr14_4H: number;
    atr14_15m: number;
    close4H: number;
    vwapDaily: number | null;
}

// ── Regime ───
export type Regime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "NO_TRADE";

// ── Sweep Type ───────────────────────────────────────────────
export type SweepType = "PDH" | "PDL" | "EQH" | "EQL";

// ── Equal Level ──────────────────────────────────────────────
export interface EqualLevel {
  level: number;              // average of the two qualifying highs or lows
  indexA: number;             // candle index of first in pair (older)
  indexB: number;             // candle index of second in pair (newer)
  relDiff: number;            // abs(val_i - val_j) / ATR — used for tie-breaking
}

// ── Liquidity Levels ─────────────────────────────────────────
// Full snapshot of all liquidity references at a point in time.
export interface LiquidityLevels {
  pdh: number;                // previous day high
  pdl: number;                // previous day low
  eqh: EqualLevel | null;    // equal highs (null if none found)
  eql: EqualLevel | null;    // equal lows (null if none found)
  sessionHigh: number;        // highest high since 00:00 UTC today
  sessionLow: number;         // lowest low since 00:00 UTC today
}


// ── Signal Direction ─────────────────────────────────────────
export type SignalDirection = "LONG" | "SHORT";

// ── Pending Setup ────────────────────────────────────────────
// Intermediate state after sweep (L2/S2) detected but before
// all conditions are met. Tracks progress through the grace window.
export interface PendingSetup {
  direction: SignalDirection;
  regime: Regime;
  t0: number;                 // candle index where sweep occurred
  sweepLevel: number;         // the liquidity level that was swept
  sweepType: SweepType;
  bosLevel: number | null;    // swing high/low used for BOS, set when L4/S4 fires
  bosIndex: number | null;    // candle index where BOS confirmed
  vwapConfirmed: boolean;     // L3/S3 satisfied
  bosConfirmed: boolean;      // L4/S4 satisfied
}

// ── Entry Signal ─────────────────────────────────────────────
// Fully confirmed entry, ready for position sizing and execution.
export interface EntrySignal {
  direction: SignalDirection;
  regime: Regime;
  entryPrice: number;         // close of L5/S5 candle
  entryIndex: number;         // candle index of entry
  sweepLevel: number;
  sweepType: SweepType;
  bosLevel: number;
  vwapAtEntry: number;
  atr14_15m: number;
}

// ── Exit Reason ──────────────────────────────────────────────
export type ExitReason =
  | "TP_HIT"
  | "SL_HIT"
  | "TRAILING_STOP"
  | "TIME_EXIT"
  | "INVALIDATION"
  | "MANUAL";

// ── Stop Loss Result ─────────────────────────────────────────
export interface StopLossResult {
  structure: number;          // SL from recent candle lows/highs
  atrBased: number;           // SL from ATR multiplier
  final: number;              // min/max of the two (the wider stop)
}

// ── Take Profit Result ───────────────────────────────────────
export interface TakeProfitResult {
  primary: number | null;     // liquidity or VWAP/midrange target
  fallback: number;           // R-multiple target
  final: number;              // primary if available, else fallback
}

// ── Trailing Stop State ──────────────────────────────────────
export interface TrailingStopState {
  activated: boolean;
  currentStop: number;        // current trailing stop level
  highestHighSinceEntry: number;  // long: tracked high watermark
  lowestLowSinceEntry: number;   // short: tracked low watermark
}

// ── Position ─────────────────────────────────────────────────
// Active position state tracked candle-by-candle.
export interface Position {
  direction: SignalDirection;
  regime: Regime;
  entryPrice: number;
  entryIndex: number;
  entryTimestamp: string;     // ISO 8601
  stopLoss: number;           // current effective stop (may be trailed)
  stopLossInitial: number;    // original stop at entry
  takeProfit: number;         // primary TP target
  r: number;                  // abs(entry - initial SL)
  positionSizeBtc: number;
  positionSizeUsd: number;
  partialExitTriggered: boolean;
  trailingStop: TrailingStopState;
  sweepLevel: number;
  sweepType: SweepType;
  bosLevel: number;
  vwapAtEntry: number;
  atr14_15m: number;
}

// ── Invalidation Reason ──────────────────────────────────────
export type InvalidationReason =
  | "REGIME_CHANGE"        // I1
  | "PRICE_DISTANCE"       // I2
  | "WINDOW_EXPIRED"       // I3
  | "OPPOSING_SWEEP"       // I4
  | "MOMENTUM_COLLAPSE"    // I5
  | "CANDLE_RANGE_FILTER"; // I6

// ── Position Sizing Result ───────────────────────────────────
export interface PositionSizeResult {
  riskPerTrade: number;       // USD amount at risk
  r: number;                  // abs(entry - SL)
  positionSizeUsd: number;    // after cap applied
  positionSizeBtc: number;
  capped: boolean;            // true if max position cap was hit
}

// ── Trade Log ────────────────────────────────────────────────
// Spec Section 11: every field recorded per trade for backtest analytics.
export interface TradeLog {
  tradeId: string;                // UUID
  timestampEntry: string;         // ISO 8601
  timestampExit: string;          // ISO 8601
  direction: SignalDirection;
  regime: Regime;
  entryPrice: number;
  stopLossInitial: number;
  takeProfitTarget: number;
  exitPrice: number;
  exitReason: ExitReason;
  positionSizeBtc: number;
  positionSizeUsd: number;
  rMultipleResult: number;
  pnlUsd: number;
  pnlPct: number;
  holdingPeriodMinutes: number;
  pdh: number;
  pdl: number;
  vwapAtEntry: number;
  atr14_15mAtEntry: number;
  adx14_4hAtEntry: number;
  ema20_4hAtEntry: number;
  ema50_4hAtEntry: number;
  sweepLevel: number;
  sweepType: SweepType;
  bosLevel: number;
  partialExitTriggered: boolean;
  trailingStopActivated: boolean;
  accountEquityAtEntry: number;
  entryCandleRange: number;
}
