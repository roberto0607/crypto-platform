/**
 * Volume Profile (VPVR) — bucket/POC math only.
 *
 * Ported from the `update()` method of apps/web/src/lib/vpvrPrimitive.ts,
 * which bundles this math together with a lightweight-charts canvas
 * renderer (ISeriesPrimitive, CanvasRenderingContext2D). That rendering
 * half is browser-only and does not belong server-side — this file is
 * exactly the pure-math subset (bucket allocation, POC, value area),
 * returning prices directly rather than raw bucket indices since a price
 * is what's useful outside a canvas-coordinate context. Keep the two in
 * sync if this math changes.
 */

const NUM_BUCKETS = 60;
const VALUE_AREA_PCT = 0.7;

export interface VolumeProfileCandle {
  high: number;
  low: number;
  volume: number;
}

export interface VolumeProfileResult {
  poc: number; // price with the highest traded volume
  vah: number; // value area high price
  val: number; // value area low price
  min: number;
  max: number;
  bucketSize: number;
  buckets: { priceLow: number; priceHigh: number; volume: number }[];
}

export function computeVolumeProfile(candles: VolumeProfileCandle[]): VolumeProfileResult | null {
  if (candles.length === 0) return null;

  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  if (max <= min) return null;

  const bucketSize = (max - min) / NUM_BUCKETS;
  const buckets = new Float64Array(NUM_BUCKETS);

  for (const c of candles) {
    const lo = Math.max(0, Math.floor((c.low - min) / bucketSize));
    const hi = Math.min(NUM_BUCKETS - 1, Math.floor((c.high - min) / bucketSize));
    const span = hi - lo + 1;
    const volPerBucket = c.volume / span;
    for (let b = lo; b <= hi; b++) {
      buckets[b]! += volPerBucket;
    }
  }

  let maxVolume = 0;
  let pocIndex = 0;
  let totalVolume = 0;
  for (let i = 0; i < NUM_BUCKETS; i++) {
    totalVolume += buckets[i]!;
    if (buckets[i]! > maxVolume) {
      maxVolume = buckets[i]!;
      pocIndex = i;
    }
  }

  const valueArea = new Uint8Array(NUM_BUCKETS);
  const targetVolume = totalVolume * VALUE_AREA_PCT;
  let vaVolume = buckets[pocIndex]!;
  valueArea[pocIndex] = 1;
  let lo = pocIndex - 1;
  let hi = pocIndex + 1;

  while (vaVolume < targetVolume && (lo >= 0 || hi < NUM_BUCKETS)) {
    const loVol = lo >= 0 ? buckets[lo]! : 0;
    const hiVol = hi < NUM_BUCKETS ? buckets[hi]! : 0;

    if (loVol >= hiVol && lo >= 0) {
      vaVolume += loVol;
      valueArea[lo] = 1;
      lo--;
    } else if (hi < NUM_BUCKETS) {
      vaVolume += hiVol;
      valueArea[hi] = 1;
      hi++;
    } else if (lo >= 0) {
      vaVolume += loVol;
      valueArea[lo] = 1;
      lo--;
    } else {
      break;
    }
  }

  let vahIndex = pocIndex;
  let valIndex = pocIndex;
  for (let i = 0; i < NUM_BUCKETS; i++) {
    if (valueArea[i]) {
      if (i > vahIndex) vahIndex = i;
      if (i < valIndex) valIndex = i;
    }
  }

  return {
    poc: min + (pocIndex + 0.5) * bucketSize,
    vah: min + (vahIndex + 1) * bucketSize,
    val: min + valIndex * bucketSize,
    min,
    max,
    bucketSize,
    buckets: Array.from(buckets, (volume, i) => ({
      priceLow: min + i * bucketSize,
      priceHigh: min + (i + 1) * bucketSize,
      volume,
    })),
  };
}
