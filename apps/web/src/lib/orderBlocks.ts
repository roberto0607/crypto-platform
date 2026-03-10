import type { Candle } from "./indicators";

export interface OrderBlock {
  startTime: number;   // epoch seconds (candle timestamp)
  top: number;         // price (max of open, close)
  bottom: number;      // price (min of open, close)
  type: "bullish" | "bearish";
  mitigated: boolean;  // has price closed through it?
}

/**
 * Average True Range over the last `period` candles ending at index `endIdx`.
 */
function atr(candles: Candle[], endIdx: number, period = 14): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, endIdx - period + 1); i <= endIdx; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Detect order blocks from candlestick data.
 *
 * An order block is the last opposing candle before a strong impulsive move:
 * - Bullish OB: last red candle before a strong bullish impulse (acts as support)
 * - Bearish OB: last green candle before a strong bearish impulse (acts as resistance)
 *
 * Impulse criteria: 3+ consecutive candles in one direction OR single candle body > 2x ATR.
 * OBs are mitigated when price closes through them.
 */
export function detectOrderBlocks(candles: Candle[]): OrderBlock[] {
  if (candles.length < 5) return [];

  const blocks: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const currentAtr = atr(candles, i);
    if (currentAtr === 0) continue;

    // Check for single-candle impulse (body > 2x ATR)
    const c = candles[i]!;
    const body = Math.abs(c.close - c.open);
    const isBullishCandle = c.close > c.open;

    if (body > 2 * currentAtr) {
      // Find the last opposing candle before this impulse
      const prev = candles[i - 1]!;
      const prevBullish = prev.close > prev.open;

      if (isBullishCandle && !prevBullish) {
        // Bullish impulse, previous candle was bearish → bullish OB
        blocks.push({
          startTime: prev.time,
          top: Math.max(prev.open, prev.close),
          bottom: Math.min(prev.open, prev.close),
          type: "bullish",
          mitigated: false,
        });
      } else if (!isBullishCandle && prevBullish) {
        // Bearish impulse, previous candle was bullish → bearish OB
        blocks.push({
          startTime: prev.time,
          top: Math.max(prev.open, prev.close),
          bottom: Math.min(prev.open, prev.close),
          type: "bearish",
          mitigated: false,
        });
      }
      continue;
    }

    // Check for 3+ consecutive candle impulse
    if (i + 2 < candles.length) {
      const c1 = candles[i]!;
      const c2 = candles[i + 1]!;
      const c3 = candles[i + 2]!;

      const allBullish = c1.close > c1.open && c2.close > c2.open && c3.close > c3.open;
      const allBearish = c1.close < c1.open && c2.close < c2.open && c3.close < c3.open;

      if (allBullish || allBearish) {
        const prev = candles[i - 1]!;
        const prevBullish = prev.close > prev.open;

        if (allBullish && !prevBullish) {
          blocks.push({
            startTime: prev.time,
            top: Math.max(prev.open, prev.close),
            bottom: Math.min(prev.open, prev.close),
            type: "bullish",
            mitigated: false,
          });
        } else if (allBearish && prevBullish) {
          blocks.push({
            startTime: prev.time,
            top: Math.max(prev.open, prev.close),
            bottom: Math.min(prev.open, prev.close),
            type: "bearish",
            mitigated: false,
          });
        }
      }
    }
  }

  // Deduplicate by startTime (same candle can be detected multiple ways)
  const seen = new Set<number>();
  const unique: OrderBlock[] = [];
  for (const ob of blocks) {
    if (!seen.has(ob.startTime)) {
      seen.add(ob.startTime);
      unique.push(ob);
    }
  }

  // Check mitigation: price closed through the OB after it was formed
  for (const ob of unique) {
    for (const c of candles) {
      if (c.time <= ob.startTime) continue;
      if (ob.type === "bullish" && c.close < ob.bottom) {
        ob.mitigated = true;
        break;
      }
      if (ob.type === "bearish" && c.close > ob.top) {
        ob.mitigated = true;
        break;
      }
    }
  }

  // Return only unmitigated OBs
  return unique.filter((ob) => !ob.mitigated);
}
