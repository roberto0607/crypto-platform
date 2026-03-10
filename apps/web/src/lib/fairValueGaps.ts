import type { Candle } from "./indicators";

export interface FairValueGap {
  time: number;        // epoch seconds (middle candle timestamp)
  top: number;         // upper boundary of gap
  bottom: number;      // lower boundary of gap
  type: "bullish" | "bearish";
}

/**
 * Detect Fair Value Gaps (FVGs / imbalances) from candlestick data.
 *
 * A FVG is a 3-candle pattern where there's a price gap (imbalance):
 * - Bullish FVG: candle[i-2].high < candle[i].low — gap up (unfilled demand zone)
 * - Bearish FVG: candle[i-2].low > candle[i].high — gap down (unfilled supply zone)
 *
 * FVGs are valid until price fills them (a candle closes inside the gap).
 * Only returns unfilled FVGs.
 */
export function detectFairValueGaps(candles: Candle[]): FairValueGap[] {
  if (candles.length < 3) return [];

  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2]!;
    const middle = candles[i - 1]!;
    const third = candles[i]!;

    // Bullish FVG: gap between first candle's high and third candle's low
    if (first.high < third.low) {
      gaps.push({
        time: middle.time,
        top: third.low,
        bottom: first.high,
        type: "bullish",
      });
    }

    // Bearish FVG: gap between first candle's low and third candle's high
    if (first.low > third.high) {
      gaps.push({
        time: middle.time,
        top: first.low,
        bottom: third.high,
        type: "bearish",
      });
    }
  }

  // Filter out filled FVGs: a FVG is filled when a subsequent candle closes inside it
  return gaps.filter((gap) => {
    for (const c of candles) {
      if (c.time <= gap.time) continue;
      // Filled if price closed within the gap zone
      if (gap.type === "bullish" && c.close >= gap.bottom && c.close <= gap.top) {
        return false;
      }
      if (gap.type === "bearish" && c.close >= gap.bottom && c.close <= gap.top) {
        return false;
      }
    }
    return true;
  });
}
