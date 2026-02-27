const DEFAULT_MAX_ATTEMPTS = 120;
const DEFAULT_WINDOW_MS = 60_000;

const maxAttempts = parseInt(process.env.RATE_ABUSE_MAX_ATTEMPTS ?? "", 10) || DEFAULT_MAX_ATTEMPTS;
const windowMs = parseInt(process.env.RATE_ABUSE_WINDOW_MS ?? "", 10) || DEFAULT_WINDOW_MS;

/** Per-user list of timestamps within the rolling window. */
const windows = new Map<string, number[]>();

/** Record an order attempt for a user. */
export function recordAttempt(userId: string): void {
  const now = Date.now();
  const cutoff = now - windowMs;

  let timestamps = windows.get(userId);
  if (!timestamps) {
    timestamps = [];
    windows.set(userId, timestamps);
  }

  // Prune expired entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid > 0) {
    timestamps.splice(0, firstValid);
  } else if (firstValid === -1) {
    timestamps.length = 0;
  }

  timestamps.push(now);
}

/** Get attempt count in the rolling window. */
export function getAttemptCount(userId: string): number {
  const now = Date.now();
  const cutoff = now - windowMs;

  const timestamps = windows.get(userId);
  if (!timestamps) return 0;

  // Prune expired entries
  const firstValid = timestamps.findIndex((t) => t > cutoff);
  if (firstValid === -1) {
    timestamps.length = 0;
    return 0;
  }
  if (firstValid > 0) {
    timestamps.splice(0, firstValid);
  }

  return timestamps.length;
}

/** Check if user has exceeded the max attempts threshold. */
export function isAboveThreshold(userId: string): boolean {
  return getAttemptCount(userId) >= maxAttempts;
}

/** Exported for testing. */
export const CONFIG = { maxAttempts, windowMs } as const;
