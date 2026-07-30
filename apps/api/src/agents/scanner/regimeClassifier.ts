/**
 * Deterministic regime classifier — trending / ranging / volatile-chop.
 *
 * Rule-based per Gate 1b's non-goals (a trained regime model is a future
 * ticket). Runs independently of Task 1's ranking shortlist and writes a
 * regime_tags row (migration 082) for every ACTIVE pair, not just today's
 * top candidates — the future Chart Analysis Agent needs regime context
 * for whichever pair a user is looking at, not just the Scanner's picks.
 *
 * Macro input (Gate 1b Task 0 resolution): Alternative.me's Fear & Greed
 * Index moved here from the per-asset news client, since it's one
 * whole-market score, not per-pair data. It only ever nudges the
 * volatility threshold, never the trend threshold or the regime label
 * directly — extreme fear/greed correlates with real market-wide
 * volatility, which is a volatility-axis signal, not a trend one.
 */
import { pool } from "../../db/pool";
import { computeATR, computeEMA, type Candle } from "../../indicators";
import { getFearGreedIndex } from "./fearGreedClient";

export type Regime = "trending" | "ranging" | "volatile-chop";

export interface RegimeClassification {
  regime: Regime;
  confidence: number; // 0-1
}

const ATR_PERIOD = 14;
const EMA_PERIOD = 20;
// How many candles back to compare EMA(20) against, to gauge trend slope.
const EMA_SLOPE_LOOKBACK = 5;

const TREND_SLOPE_THRESHOLD_PCT = 2;
const VOLATILE_ATR_THRESHOLD_PCT = 3;
// Extreme fear/greed correlates with real (not just noisy) volatility --
// lower the volatile-chop bar during those windows.
const EXTREME_MACRO_ATR_ADJUSTMENT_PCT = 1;
const EXTREME_FNG_LOW = 20;
const EXTREME_FNG_HIGH = 80;

const TIMEFRAME = "4h";
// 4h candles: ATR(14) + EMA(20) + a 5-period slope lookback need ~40
// candles minimum. 12 days of 4h candles (=72 candles) pads comfortably
// for gaps without pulling the same 300-candle depth the full indicator
// endpoint uses.
const LOOKBACK_DAYS = 12;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Pure classification — no DB/network call. See __tests__/regimeClassifier.test.ts.
 */
export function classifyRegime(
  atrPct: number,
  emaSlopePct: number,
  isExtremeMacro: boolean,
): RegimeClassification {
  const volatileThreshold = isExtremeMacro
    ? VOLATILE_ATR_THRESHOLD_PCT - EXTREME_MACRO_ATR_ADJUSTMENT_PCT
    : VOLATILE_ATR_THRESHOLD_PCT;

  const absSlope = Math.abs(emaSlopePct);

  if (absSlope >= TREND_SLOPE_THRESHOLD_PCT) {
    return { regime: "trending", confidence: clamp01(absSlope / (TREND_SLOPE_THRESHOLD_PCT * 2)) };
  }

  if (atrPct >= volatileThreshold) {
    return { regime: "volatile-chop", confidence: clamp01(atrPct / (volatileThreshold * 2)) };
  }

  // Neither axis crossed its threshold -- ranging. Confidence is high when
  // both are well below threshold, and drops toward 0 as either approaches it.
  const proximityToThreshold = Math.max(absSlope / TREND_SLOPE_THRESHOLD_PCT, atrPct / volatileThreshold);
  return { regime: "ranging", confidence: clamp01(1 - proximityToThreshold) };
}

interface PairCandleData {
  pairId: string;
  candles: Candle[];
}

async function fetchPairCandles(): Promise<PairCandleData[]> {
  const { rows } = await pool.query<{
    pair_id: string;
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `SELECT c.pair_id, c.ts, c.open, c.high, c.low, c.close, c.volume
     FROM candles c
     JOIN trading_pairs p ON p.id = c.pair_id
     WHERE c.timeframe = $1
       AND p.is_active = true
       AND c.ts >= now() - ($2 || ' days')::interval
     ORDER BY c.pair_id, c.ts ASC`,
    [TIMEFRAME, LOOKBACK_DAYS],
  );

  const byPair = new Map<string, PairCandleData>();
  for (const row of rows) {
    let entry = byPair.get(row.pair_id);
    if (!entry) {
      entry = { pairId: row.pair_id, candles: [] };
      byPair.set(row.pair_id, entry);
    }
    entry.candles.push({
      time: Math.floor(new Date(row.ts).getTime() / 1000),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
    });
  }
  return [...byPair.values()];
}

export interface RegimeRunResult {
  classified: number;
  skipped: number;
}

/**
 * Classifies every active pair and inserts one regime_tags row each
 * (append-only time series, matching migration 082's "history lookback"
 * design — not an upsert).
 */
export async function runRegimeClassification(): Promise<RegimeRunResult> {
  const [pairs, fearGreed] = await Promise.all([fetchPairCandles(), getFearGreedIndex()]);
  const isExtremeMacro = fearGreed !== null && (fearGreed.value <= EXTREME_FNG_LOW || fearGreed.value >= EXTREME_FNG_HIGH);

  let classified = 0;
  let skipped = 0;

  for (const pair of pairs) {
    const atrSeries = computeATR(pair.candles, ATR_PERIOD);
    const emaSeries = computeEMA(pair.candles, EMA_PERIOD);
    if (atrSeries.length === 0 || emaSeries.length < EMA_SLOPE_LOOKBACK + 1) {
      skipped++;
      continue;
    }

    const latestClose = pair.candles[pair.candles.length - 1]!.close;
    const latestAtr = atrSeries[atrSeries.length - 1]!.value;
    const atrPct = latestClose > 0 ? (latestAtr / latestClose) * 100 : 0;

    const emaNow = emaSeries[emaSeries.length - 1]!.value;
    const emaPrior = emaSeries[emaSeries.length - 1 - EMA_SLOPE_LOOKBACK]!.value;
    const emaSlopePct = emaPrior !== 0 ? ((emaNow - emaPrior) / emaPrior) * 100 : 0;

    const { regime, confidence } = classifyRegime(atrPct, emaSlopePct, isExtremeMacro);

    await pool.query(`INSERT INTO regime_tags (pair_id, regime, confidence) VALUES ($1, $2, $3)`, [
      pair.pairId,
      regime,
      confidence,
    ]);
    classified++;
  }

  return { classified, skipped };
}
