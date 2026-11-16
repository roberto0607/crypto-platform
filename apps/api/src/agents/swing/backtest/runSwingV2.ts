/**
 * One Swing Agent v2 run over a period: the live v2 rules
 * (evaluateSwingV2 on snapshotAt) through the same fill model as v1
 * (simulate.ts), from `startIndex` to `endIndex` (exclusive). Indicators
 * use all bars before each decision (causal), so a period's warm-up is
 * real history, not leakage.
 */
import type { Candle } from "../../../indicators/shared";
import type { SwingCosts, SwingSide } from "../evaluateSwing";
import { evaluateSwingV2 } from "../evaluateSwingV2";
import { buildSwingSeries, snapshotAt, type SwingSeries } from "../swingSeries";
import { dailyAdxAt, regimeOf, type BacktestCandles, type BacktestTrade } from "./runSwingBacktest";
import { simulate, type SimResult } from "./simulate";

export interface RoomSample { side: SwingSide; roomR: number | "none" }

export interface V2RunInput {
  candles: BacktestCandles;
  costs: SwingCosts;
  startEquity: number;
  startIndex: number;
  endIndex: number;
  series?: SwingSeries;
}

export interface V2RunOutput {
  sim: SimResult;
  trades: BacktestTrade[];
  /** The room check's value at every evaluation that reached it. */
  room: RoomSample[];
}

/** Index of the first 4h bar whose open time is >= t. */
export function indexAtOrAfter(h4: Candle[], t: number): number {
  let lo = 0;
  let hi = h4.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (h4[mid]!.time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export function runSwingV2(input: V2RunInput): V2RunOutput {
  const series = input.series ?? buildSwingSeries(input.candles);
  const room: RoomSample[] = [];
  const sim = simulate({
    h4: input.candles.h4,
    h1: input.candles.h1,
    costs: input.costs,
    startIndex: input.startIndex,
    endIndex: input.endIndex,
    startEquity: input.startEquity,
    decide: (k, account) => {
      const d = evaluateSwingV2(snapshotAt(series, k), account, input.costs);
      if (d.roomR !== null && d.candidateSide) room.push({ side: d.candidateSide, roomR: d.roomR });
      return d;
    },
  });
  const adxAt = dailyAdxAt(input.candles.d1);
  return { sim, room, trades: sim.trades.map((t) => ({ ...t, regime: regimeOf(adxAt(t.decisionTime)) })) };
}
