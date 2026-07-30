/**
 * Deterministic pre-LLM ranking layer for the Scanner Agent.
 *
 * Cost control from the Gate 1b design: the LLM only ever reasons over a
 * shortlist (top 5-10 of ~75 pairs), never the full universe per cycle.
 * This file produces that shortlist with plain arithmetic, no LLM call.
 *
 * Data source (Gate 1b Task 0 recon): trading_pairs has no 24h-change/volume
 * column, and the frontend's own 24h-change display fetches one 1d candle
 * PER PAIR (apps/web/src/pages/TradingPage.tsx's fetchAllOpensInto — an
 * N-query pattern). Neither that nor the full /v1/market/indicators
 * endpoint (300 candles + indicator math per call) is cheap enough to run
 * across all 75 pairs every scan cycle. fetchPairDailyStats() below is ONE
 * query for every tracked pair's last ~3 weeks of daily candles instead.
 */
import { pool } from "../../db/pool";

export interface DailyCandle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PairDailyStats {
  pairId: string;
  symbol: string;
  /** Ascending by ts (oldest first, latest/"today" last). */
  candles: DailyCandle[];
}

export interface RankedCandidate {
  pairId: string;
  symbol: string;
  /** Today's high-low range as a % of today's open — a single-candle
   *  volatility proxy, cheap to compute, no ATR/multi-candle smoothing. */
  volatilityPct: number;
  /** Today's volume divided by the average of the prior baseline days.
   *  1.0 = normal, >1.0 = above-average activity. */
  volumeRatio: number;
  /** volatilityPct * volumeRatio — rewards pairs unusual on BOTH axes at
   *  once over pairs that are only volatile OR only high-volume. */
  score: number;
}

/** 1 "today" candle + this many prior days as the volume-average baseline. */
const BASELINE_DAYS = 20;
const LOOKBACK_DAYS = BASELINE_DAYS + 1;
const DEFAULT_SHORTLIST_SIZE = 8;

// avgBaselineVolume > 0 only guards literal divide-by-zero -- a baseline
// that's nonzero but tiny (sparse candle history, near-dead pair) still
// produces an enormous ratio that has nothing to do with real activity.
// Capping bounds that blowup without needing an arbitrary absolute-volume
// epsilon (which would need a different value per pair's price/volume
// scale); a pair legitimately trading at >25x its 20-day average volume
// in one day is already an extreme, rare event worth flagging as-is.
const MAX_VOLUME_RATIO = 25;

/**
 * Pure ranking function — no DB/network/LLM call. Feed it fixture
 * PairDailyStats and assert the ranking order; this is the unit-tested
 * surface (see __tests__/rank.test.ts).
 */
export function rankPairs(
  pairs: PairDailyStats[],
  shortlistSize = DEFAULT_SHORTLIST_SIZE,
): RankedCandidate[] {
  const candidates: RankedCandidate[] = [];

  for (const pair of pairs) {
    // Need at least one baseline day plus today to compute a volume ratio.
    if (pair.candles.length < 2) continue;

    const latest = pair.candles[pair.candles.length - 1]!;
    const baseline = pair.candles.slice(0, -1);

    if (latest.open <= 0) continue; // guard against bad/zero data

    const volatilityPct = ((latest.high - latest.low) / latest.open) * 100;

    const avgBaselineVolume = baseline.reduce((sum, c) => sum + c.volume, 0) / baseline.length;
    const volumeRatio = avgBaselineVolume > 0
      ? Math.min(latest.volume / avgBaselineVolume, MAX_VOLUME_RATIO)
      : 0;

    candidates.push({
      pairId: pair.pairId,
      symbol: pair.symbol,
      volatilityPct,
      volumeRatio,
      score: volatilityPct * volumeRatio,
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, shortlistSize);
}

/**
 * One query for every active pair's last ~3 weeks of daily candles —
 * not N per-pair queries. Grouped into PairDailyStats[] in JS.
 */
export async function fetchPairDailyStats(): Promise<PairDailyStats[]> {
  const { rows } = await pool.query<{
    pair_id: string;
    symbol: string;
    ts: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>(
    `SELECT c.pair_id, p.symbol, c.ts, c.open, c.high, c.low, c.close, c.volume
     FROM candles c
     JOIN trading_pairs p ON p.id = c.pair_id
     WHERE c.timeframe = '1d'
       AND p.is_active = true
       AND c.ts >= now() - ($1 || ' days')::interval
     ORDER BY c.pair_id, c.ts ASC`,
    [LOOKBACK_DAYS],
  );

  const byPair = new Map<string, PairDailyStats>();
  for (const row of rows) {
    let entry = byPair.get(row.pair_id);
    if (!entry) {
      entry = { pairId: row.pair_id, symbol: row.symbol, candles: [] };
      byPair.set(row.pair_id, entry);
    }
    entry.candles.push({
      ts: row.ts,
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseFloat(row.volume),
    });
  }

  return [...byPair.values()];
}

/** Orchestrator: fetch + rank in one call, for the Scanner Agent runner. */
export async function getShortlist(shortlistSize = DEFAULT_SHORTLIST_SIZE): Promise<RankedCandidate[]> {
  const pairs = await fetchPairDailyStats();
  return rankPairs(pairs, shortlistSize);
}
