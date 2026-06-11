/**
 * Leading-edge throttle with a single coalesced trailing call.
 *
 * - The first call (or any call >`ms` after the last fire) invokes `fn`
 *   immediately (leading edge).
 * - Calls arriving inside the window do NOT fire immediately; instead a single
 *   trailing call is scheduled for the window boundary. Multiple calls within
 *   the window collapse into that one trailing call (coalesce).
 *
 * Net: a burst of N rapid calls within one window produces exactly one leading
 * fire and at most one trailing fire. Calls spaced further than `ms` apart each
 * fire on their own leading edge.
 *
 * `cancel()` clears any pending trailing call and resets the clock, so the next
 * call fires immediately on its leading edge again (used on pair switch so a
 * stale trailing fetch from the old pair can't land).
 */
export interface Throttled {
  (): void;
  cancel: () => void;
}

export function createThrottle(fn: () => void, ms: number): Throttled {
  let lastFire = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const throttled = (() => {
    const now = Date.now();
    const elapsed = now - lastFire;
    if (elapsed >= ms) {
      // Leading edge — fire now.
      lastFire = now;
      fn();
    } else if (timer === null) {
      // Inside the window with no pending trailing call — schedule one.
      timer = setTimeout(() => {
        lastFire = Date.now();
        timer = null;
        fn();
      }, ms - elapsed);
    }
    // else: a trailing call is already pending — coalesce (do nothing).
  }) as Throttled;

  throttled.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastFire = 0;
  };

  return throttled;
}
