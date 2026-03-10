import type { Candle } from "@/api/endpoints/candles";

export interface VolumeProfileLevel {
    price: number;       // center of the price bucket
    totalVolume: number;
    buyVolume: number;
    sellVolume: number;
}

export interface VolumeProfileData {
    levels: VolumeProfileLevel[];
    poc: number;    // Point of Control — price with highest volume
    vah: number;    // Value Area High (70% of volume above)
    val: number;    // Value Area Low (70% of volume below)
}

/**
 * Compute volume profile from candle data.
 * Divides the price range into buckets and distributes each candle's volume
 * across the buckets its range spans.
 */
export function computeVolumeProfile(
    candles: Candle[],
    bucketCount = 50,
): VolumeProfileData | null {
    if (candles.length === 0) return null;

    // Find price range
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of candles) {
        const low = parseFloat(c.low);
        const high = parseFloat(c.high);
        if (low < minPrice) minPrice = low;
        if (high > maxPrice) maxPrice = high;
    }

    const range = maxPrice - minPrice;
    if (range <= 0) return null;

    const bucketSize = range / bucketCount;

    // Initialize buckets
    const buckets: VolumeProfileLevel[] = [];
    for (let i = 0; i < bucketCount; i++) {
        buckets.push({
            price: minPrice + (i + 0.5) * bucketSize,
            totalVolume: 0,
            buyVolume: 0,
            sellVolume: 0,
        });
    }

    // Distribute volume from each candle across its price range
    for (const c of candles) {
        const low = parseFloat(c.low);
        const high = parseFloat(c.high);
        const vol = parseFloat(c.volume);
        const buyVol = parseFloat(c.buy_volume ?? "0");
        const sellVol = parseFloat(c.sell_volume ?? "0");

        const candleRange = high - low;
        if (candleRange <= 0 || vol <= 0) continue;

        // Find which buckets this candle spans
        const startBucket = Math.max(0, Math.floor((low - minPrice) / bucketSize));
        const endBucket = Math.min(bucketCount - 1, Math.floor((high - minPrice) / bucketSize));

        const spannedBuckets = endBucket - startBucket + 1;
        const volPerBucket = vol / spannedBuckets;
        const buyVolPerBucket = buyVol / spannedBuckets;
        const sellVolPerBucket = sellVol / spannedBuckets;

        for (let b = startBucket; b <= endBucket; b++) {
            buckets[b]!.totalVolume += volPerBucket;
            buckets[b]!.buyVolume += buyVolPerBucket;
            buckets[b]!.sellVolume += sellVolPerBucket;
        }
    }

    // Find POC (bucket with max volume)
    let pocIdx = 0;
    let maxVol = 0;
    for (let i = 0; i < buckets.length; i++) {
        if (buckets[i]!.totalVolume > maxVol) {
            maxVol = buckets[i]!.totalVolume;
            pocIdx = i;
        }
    }
    const poc = buckets[pocIdx]!.price;

    // Compute Value Area (smallest range containing 70% of total volume)
    const totalVolume = buckets.reduce((sum, b) => sum + b.totalVolume, 0);
    const targetVolume = totalVolume * 0.7;

    // Expand outward from POC
    let vaLow = pocIdx;
    let vaHigh = pocIdx;
    let vaVolume = buckets[pocIdx]!.totalVolume;

    while (vaVolume < targetVolume && (vaLow > 0 || vaHigh < bucketCount - 1)) {
        const addLow = vaLow > 0 ? buckets[vaLow - 1]!.totalVolume : 0;
        const addHigh = vaHigh < bucketCount - 1 ? buckets[vaHigh + 1]!.totalVolume : 0;

        if (addLow >= addHigh && vaLow > 0) {
            vaLow--;
            vaVolume += addLow;
        } else if (vaHigh < bucketCount - 1) {
            vaHigh++;
            vaVolume += addHigh;
        } else {
            vaLow--;
            vaVolume += addLow;
        }
    }

    const vah = buckets[vaHigh]!.price + bucketSize / 2;
    const val = buckets[vaLow]!.price - bucketSize / 2;

    return { levels: buckets, poc, vah, val };
}
