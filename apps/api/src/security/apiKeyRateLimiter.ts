import { config } from "../config";

/** In-memory sliding window per API key ID. */
const windows = new Map<string, number[]>();

/**
 * Record a request for the given API key.
 * Returns true if rate limit exceeded.
 */
export function checkApiKeyRateLimit(apiKeyId: string): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute
  const max = config.maxApiKeyReqPerMin;

  let timestamps = windows.get(apiKeyId);
  if (!timestamps) {
    timestamps = [];
    windows.set(apiKeyId, timestamps);
  }

  // Prune expired entries
  const cutoff = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  if (timestamps.length >= max) {
    return true; // exceeded
  }

  timestamps.push(now);
  return false;
}

/** Clear all windows (for tests). */
export function resetApiKeyRateLimiter(): void {
  windows.clear();
}
