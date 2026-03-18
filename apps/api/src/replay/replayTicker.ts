import { advanceReplayLoop } from "./replayEngine";

/**
 * In-memory manager for active replay tick intervals.
 * Each active (unpaused) replay session gets a setInterval
 * that calls advanceReplayLoop every 250ms.
 */

const TICK_INTERVAL_MS = 250;

// key: "userId:pairId" → interval handle
const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();

function key(userId: string, pairId: string): string {
    return `${userId}:${pairId}`;
}

/** Start ticking for a user/pair session. Idempotent. */
export function startTicking(userId: string, pairId: string): void {
    const k = key(userId, pairId);
    // Clear any existing interval first
    stopTicking(userId, pairId);

    const interval = setInterval(async () => {
        try {
            const result = await advanceReplayLoop(userId, pairId);
            if (!result) {
                // Session gone, paused, or no data — stop ticking
                stopTicking(userId, pairId);
            }
        } catch {
            // Never let errors kill the interval; just skip this tick
        }
    }, TICK_INTERVAL_MS);

    activeIntervals.set(k, interval);
}

/** Stop ticking for a user/pair session. Idempotent. */
export function stopTicking(userId: string, pairId: string): void {
    const k = key(userId, pairId);
    const existing = activeIntervals.get(k);
    if (existing) {
        clearInterval(existing);
        activeIntervals.delete(k);
    }
}

/** Stop all active replay tickers (for graceful shutdown). */
export function stopAllTickers(): void {
    for (const [k, interval] of activeIntervals) {
        clearInterval(interval);
        activeIntervals.delete(k);
    }
}
