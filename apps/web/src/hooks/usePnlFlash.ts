import { useEffect, useRef, useState } from "react";

export type PnlFlashDir = "up" | "down" | "";

export interface PnlFlash {
    /** Direction of the most recent qualifying change; "" when idle. */
    dir: PnlFlashDir;
    /** Increments on every flash — use as a React `key` to replay the CSS animation. */
    key: number;
}

const THROTTLE_MS = 250; // one flash per this window — raw SSE ticks are unthrottled
const CLEAR_MS = 300;    // clear `dir` after the animation so a fresh mount stays silent

/**
 * Drives a brief background flash when a P&L value changes.
 *
 * - Flashes "up" (green) / "down" (red) based on the delta direction.
 * - Throttled to at most one flash per 250ms — without this, unthrottled
 *   price ticks would strobe.
 * - Changes smaller than `minDelta` are treated as micro-noise and ignored.
 *   The baseline is NOT advanced on a suppressed change, so genuine cumulative
 *   drift still eventually flashes.
 * - No flash on first mount; the baseline re-seeds silently when `resetKey`
 *   changes (pair / match switch) so the first tick in a new context is quiet.
 */
export function usePnlFlash(
    value: number,
    resetKey: string | number,
    minDelta = 0.01,
): PnlFlash {
    const prev = useRef<number | null>(null);
    const lastFlash = useRef(0);
    const ctx = useRef(resetKey);
    const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [flash, setFlash] = useState<PnlFlash>({ dir: "", key: 0 });

    useEffect(() => {
        if (!Number.isFinite(value)) return;

        // Context switched (pair / match) — re-baseline silently.
        if (ctx.current !== resetKey) {
            ctx.current = resetKey;
            prev.current = value;
            return;
        }
        // First observation — establish the baseline, never flash.
        if (prev.current === null) {
            prev.current = value;
            return;
        }

        const delta = value - prev.current;
        if (Math.abs(delta) < minDelta) return;                    // micro-noise — keep baseline
        if (Date.now() - lastFlash.current < THROTTLE_MS) return;  // throttle — keep baseline

        lastFlash.current = Date.now();
        prev.current = value;
        setFlash((f) => ({ dir: delta > 0 ? "up" : "down", key: f.key + 1 }));

        if (clearTimer.current) clearTimeout(clearTimer.current);
        clearTimer.current = setTimeout(
            () => setFlash((f) => ({ dir: "", key: f.key })),
            CLEAR_MS,
        );
    }, [value, resetKey, minDelta]);

    // Clear any pending timer on unmount.
    useEffect(() => () => {
        if (clearTimer.current) clearTimeout(clearTimer.current);
    }, []);

    return flash;
}
