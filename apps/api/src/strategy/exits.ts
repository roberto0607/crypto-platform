import type {
  Candle,
  LiquidityLevels,
  Regime,
  StopLossResult,
  TakeProfitResult,
  TrailingStopState,
} from "./types.js";

// ── Stop Loss ────────────────────────────────────────────────

export function computeStopLoss(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  candles: Candle[],
  entryIndex: number,
  atr14_15m: number,
  atrMultiplierSL: number = 1.5,
): StopLossResult {
  if (direction === "LONG") {
    let structure = Infinity;
    for (let i = Math.max(0, entryIndex - 2); i <= entryIndex; i++) {
      if (candles[i].low < structure) structure = candles[i].low;
    }
    const atrBased = entryPrice - atrMultiplierSL * atr14_15m;
    const final = Math.min(structure, atrBased);
    return { structure, atrBased, final };
  } else {
    let structure = -Infinity;
    for (let i = Math.max(0, entryIndex - 2); i <= entryIndex; i++) {
      if (candles[i].high > structure) structure = candles[i].high;
    }
    const atrBased = entryPrice + atrMultiplierSL * atr14_15m;
    const final = Math.max(structure, atrBased);
    return { structure, atrBased, final };
  }
}

// ── Take Profit ──────────────────────────────────────────────

export function computeTakeProfit(
  direction: "LONG" | "SHORT",
  regime: Regime,
  entryPrice: number,
  r: number,
  atr14_15m: number,
  vwapDaily: number,
  liq: LiquidityLevels,
  rMultipleTPTrend: number = 2.5,
  rMultipleTPRange: number = 2.0,
): TakeProfitResult {
  const isRange = regime === "RANGE";
  const rMultiple = isRange ? rMultipleTPRange : rMultipleTPTrend;
  const fallback =
    direction === "LONG"
      ? entryPrice + rMultiple * r
      : entryPrice - rMultiple * r;

  let primary: number | null = null;

  if (isRange) {
    primary = rangePrimaryTP(direction, entryPrice, atr14_15m, vwapDaily, liq);
    if (primary === null) {
      primary = liquidityTP(direction, entryPrice, atr14_15m, liq);
    }
  } else {
    primary = liquidityTP(direction, entryPrice, atr14_15m, liq);
  }

  return {
    primary,
    fallback,
    final: primary !== null ? primary : fallback,
  };
}

function liquidityTP(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  atr14_15m: number,
  liq: LiquidityLevels,
): number | null {
  const minDist = 1.0 * atr14_15m;

  if (direction === "LONG") {
    const candidates: number[] = [];
    if (liq.pdh - entryPrice >= minDist) candidates.push(liq.pdh);
    if (liq.eqh !== null && liq.eqh.level - entryPrice >= minDist)
      candidates.push(liq.eqh.level);
    if (liq.sessionHigh - entryPrice >= minDist)
      candidates.push(liq.sessionHigh);

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a < b ? a : b));
  } else {
    const candidates: number[] = [];
    if (entryPrice - liq.pdl >= minDist) candidates.push(liq.pdl);
    if (liq.eql !== null && entryPrice - liq.eql.level >= minDist)
      candidates.push(liq.eql.level);
    if (entryPrice - liq.sessionLow >= minDist)
      candidates.push(liq.sessionLow);

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a > b ? a : b));
  }
}

function rangePrimaryTP(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  atr14_15m: number,
  vwapDaily: number,
  liq: LiquidityLevels,
): number | null {
  const minDist = 0.75 * atr14_15m;
  const midrange = (liq.pdh + liq.pdl) / 2;

  if (direction === "LONG") {
    const candidates: number[] = [];
    if (vwapDaily > entryPrice && vwapDaily - entryPrice >= minDist)
      candidates.push(vwapDaily);
    if (midrange > entryPrice && midrange - entryPrice >= minDist)
      candidates.push(midrange);

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a < b ? a : b));
  } else {
    const candidates: number[] = [];
    if (vwapDaily < entryPrice && entryPrice - vwapDaily >= minDist)
      candidates.push(vwapDaily);
    if (midrange < entryPrice && entryPrice - midrange >= minDist)
      candidates.push(midrange);

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a > b ? a : b));
  }
}

// ── Trailing Stop ────────────────────────────────────────────

export function initTrailingStop(
  stopLossInitial: number,
  entryPrice: number,
): TrailingStopState {
  return {
    activated: false,
    currentStop: stopLossInitial,
    highestHighSinceEntry: entryPrice,
    lowestLowSinceEntry: entryPrice,
  };
}

export function updateTrailingStop(
  state: TrailingStopState,
  direction: "LONG" | "SHORT",
  entryPrice: number,
  r: number,
  candle: Candle,
  atr14_15m: number,
  atrMultiplierTrailing: number = 1.0,
): TrailingStopState {
  const highestHighSinceEntry = Math.max(state.highestHighSinceEntry, candle.high);
  const lowestLowSinceEntry = Math.min(state.lowestLowSinceEntry, candle.low);

  let activated = state.activated;
  if (!activated) {
    if (direction === "LONG" && candle.close - entryPrice >= r) {
      activated = true;
    } else if (direction === "SHORT" && entryPrice - candle.close >= r) {
      activated = true;
    }
  }

  let currentStop = state.currentStop;
  if (activated) {
    if (direction === "LONG") {
      const candidate = highestHighSinceEntry - atrMultiplierTrailing * atr14_15m;
      currentStop = Math.max(currentStop, candidate);
    } else {
      const candidate = lowestLowSinceEntry + atrMultiplierTrailing * atr14_15m;
      currentStop = Math.min(currentStop, candidate);
    }
  }

  return {
    activated,
    currentStop,
    highestHighSinceEntry,
    lowestLowSinceEntry,
  };
}

// ── Partial Exit Check ───────────────────────────────────────

export function shouldPartialExit(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  r: number,
  candleClose: number,
  partialExitThreshold: number = 1.5,
): boolean {
  if (direction === "LONG") {
    return candleClose - entryPrice >= partialExitThreshold * r;
  } else {
    return entryPrice - candleClose >= partialExitThreshold * r;
  }
}

// ── Time Exit Check ──────────────────────────────────────────

export function shouldTimeExit(
  entryTimestamp: string,
  candleTimestamp: string,
  maxHoldingMs: number = 24 * 60 * 60 * 1000,
): boolean {
  const entryMs = new Date(entryTimestamp).getTime();
  const candleMs = new Date(candleTimestamp).getTime();
  return candleMs - entryMs >= maxHoldingMs;
}

// ── SL / TP Hit Check ────────────────────────────────────────

export function checkSlTp(
  direction: "LONG" | "SHORT",
  stopLoss: number,
  takeProfit: number,
  candle: Candle,
): "SL_HIT" | "TRAILING_STOP" | "TP_HIT" | null {
  if (direction === "LONG") {
    if (candle.low <= stopLoss) return "SL_HIT";
    if (candle.high >= takeProfit) return "TP_HIT";
  } else {
    if (candle.high >= stopLoss) return "SL_HIT";
    if (candle.low <= takeProfit) return "TP_HIT";
  }
  return null;
}

