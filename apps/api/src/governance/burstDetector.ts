import { config } from "../config";

const windows = new Map<string, number[]>();

export function recordOrder(userId: string): void {
  const now = Date.now();
  let timestamps = windows.get(userId);
  if (!timestamps) {
    timestamps = [];
    windows.set(userId, timestamps);
  }
  timestamps.push(now);
  prune(userId, timestamps, now);
}

export function checkBurst(userId: string): boolean {
  recordOrder(userId);
  const timestamps = windows.get(userId);
  if (!timestamps) return false;
  return timestamps.length > config.maxOrderBurst;
}

function prune(userId: string, timestamps: number[], now: number): void {
  const cutoff = now - config.orderBurstWindowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  if (timestamps.length === 0) {
    windows.delete(userId);
  }
}

/** Clear all windows (useful for tests). */
export function resetBurstDetector(): void {
  windows.clear();
}
