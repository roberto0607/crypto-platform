/**
 * Alternative.me Fear & Greed Index — macro sentiment input for regime
 * classification (Gate 1b Task 0 resolution: moved here from the
 * per-asset news client, since it's one whole-market score, not per-pair
 * data — verified live 2026-07-30: GET https://api.alternative.me/fng/?limit=1
 * returns real JSON, no auth, e.g. {"value":"28","value_classification":"Fear"}).
 *
 * Contrast with cryptocurrency.cv (see newsClient.ts): this source's docs
 * matched what a live request actually returns — no unverified claims here.
 */

const FNG_URL = "https://api.alternative.me/fng/?limit=1";
const FETCH_TIMEOUT_MS = 5000;

// The index is a DAILY score (Alternative.me computes it once per day from
// BTC volatility/drawdown vs. its own 30/90-day averages) — an hour-long
// cache is conservative slack around that cadence, not an arbitrary number.
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface FearGreedReading {
  value: number; // 0-100
  classification: string; // e.g. "Fear", "Extreme Greed"
  timestamp: number; // epoch seconds, as reported by the API
}

let cached: { data: FearGreedReading; expiresAt: number } | null = null;

/**
 * Returns null (not a throw) on any fetch/parse failure — this is an
 * optional macro input to regime classification, not a hard dependency;
 * classification must still proceed on ATR/EMA alone if this is down.
 */
export async function getFearGreedIndex(): Promise<FearGreedReading | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(FNG_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      data?: Array<{ value: string; value_classification: string; timestamp: string }>;
    };
    const entry = json.data?.[0];
    if (!entry) return null;

    const reading: FearGreedReading = {
      value: parseInt(entry.value, 10),
      classification: entry.value_classification,
      timestamp: parseInt(entry.timestamp, 10),
    };
    if (Number.isNaN(reading.value)) return null;

    cached = { data: reading, expiresAt: Date.now() + CACHE_TTL_MS };
    return reading;
  } catch {
    return null;
  }
}
