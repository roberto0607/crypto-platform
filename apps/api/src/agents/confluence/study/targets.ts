/**
 * Study targets (pre-registration + addendum point 2). Decide at bar k's
 * close, enter at bar k+1's open.
 *
 * - Forward returns: ln(close of bar k+h ÷ open of bar k+1), h = 6, 18, 42.
 * - 7-day R, long and short: stop = entry − side × 1.5 × ATR 14 (bar k),
 *   1R = 1.5 × ATR. Bars k+1 … k+42 are walked in order: an open beyond the
 *   stop exits at that open, else a low (long) / high (short) through the
 *   stop exits at the stop; otherwise exit at bar k+42's close. Fills carry
 *   slippage against the trade; the fee is on both legs' notional.
 * - No target if ATR is missing, any of bars k+1 … k+42 is missing, or bar
 *   k+42 closes at or after the window's end: nothing past the window is read.
 */
import type { Candle } from "../../../indicators/shared";
import { STUDY_COSTS, STUDY_PREREGISTRATION as S } from "./studyParams";

const H4 = 14_400;
const HOLD = S.targets.decisionHorizonBars;

export interface Costs {
  feeBps: number;
  slippageBps: number;
}

export interface ROutcome {
  r: number;
  exitIndex: number;
  exit: "stop" | "time";
}

/** Bars k+1 … k+42 all present, consecutive, and closed before `windowEnd`. */
export function holdWindowOk(h4: Candle[], k: number, windowEnd: number): boolean {
  const last = h4[k + HOLD];
  if (!h4[k] || !last) return false;
  if (last.time - h4[k]!.time !== HOLD * H4) return false; // a gap anywhere shortens the span
  return last.time + H4 < windowEnd;
}

/** The R outcome of a position decided at bar k's close. Assumes holdWindowOk. */
export function rOutcome(h4: Candle[], k: number, atr: number, side: 1 | -1, costs: Costs): ROutcome | null {
  const entryBar = h4[k + 1];
  if (!entryBar || !(atr > 0)) return null;
  const slip = costs.slippageBps / 10_000;
  const fee = costs.feeBps / 10_000;
  const unit = S.targets.stopAtr * atr;
  const entry = entryBar.open;
  const stop = entry - side * unit;
  let exitPrice = h4[k + HOLD]!.close;
  let exitIndex = k + HOLD;
  let exit: ROutcome["exit"] = "time";
  for (let j = k + 1; j <= k + HOLD; j++) {
    const b = h4[j]!;
    const gapped = side === 1 ? b.open <= stop : b.open >= stop;
    const touched = side === 1 ? b.low <= stop : b.high >= stop;
    if (gapped || touched) {
      exitPrice = gapped ? b.open : stop;
      exitIndex = j;
      exit = "stop";
      break;
    }
  }
  const entryFill = entry * (1 + side * slip);
  const exitFill = exitPrice * (1 - side * slip);
  const r = (side * (exitFill - entryFill) - fee * (entryFill + exitFill)) / unit;
  return { r, exitIndex, exit };
}

export interface RowTargets {
  /** Log returns for horizonBars, in order. */
  ret: number[];
  longR: number;
  shortR: number;
  longRStress: number;
  shortRStress: number;
}

export function targetsAt(h4: Candle[], k: number, atr: number | null, windowEnd: number): RowTargets | null {
  if (atr === null || !(atr > 0) || !holdWindowOk(h4, k, windowEnd)) return null;
  const entry = h4[k + 1]!.open;
  const ret = S.targets.horizonBars.map((h) => Math.log(h4[k + h]!.close / entry));
  const r = (side: 1 | -1, c: Costs) => rOutcome(h4, k, atr, side, c)!.r;
  return {
    ret,
    longR: r(1, STUDY_COSTS.base),
    shortR: r(-1, STUDY_COSTS.base),
    longRStress: r(1, STUDY_COSTS.stress),
    shortRStress: r(-1, STUDY_COSTS.stress),
  };
}
