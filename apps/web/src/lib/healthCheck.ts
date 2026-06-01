import axios, { AxiosError } from "axios";

/**
 * Boot-time backend reachability probe for `/health`.
 *
 * The full-page "SERVER OFFLINE" wall (App.tsx) is gated on the result of this
 * helper, so the discrimination of failure modes matters: `serverOffline=true`
 * must mean "server is definitively unreachable", NOT "one request happened to
 * fail". Prior behavior set it on the first sign of trouble, which turned a
 * recoverable 429 (rate limited during multi-tab cold load, reproduced
 * 2026-05-31) into the offline wall.
 *
 * Failure-mode contract:
 *   - 2xx              → online. Done.
 *   - 429              → server is UP, just throttled. Honor Retry-After (or
 *                        back off), retry. Never reports offline on its own.
 *   - other HTTP error → an actual error response (5xx, or unexpected 4xx) means
 *                        the server is reachable but broken → offline immediately.
 *   - network error    → no response at all. Retry with backoff; only report
 *                        offline after `maxNetworkFailures` consecutive failures
 *                        (~15s with the default backoff), not on a single blip.
 */

/** Backoff schedule between retries, in ms. Last entry repeats once exhausted. */
const BACKOFF_MS = [5_000, 10_000];

export interface CheckHealthOptions {
  apiBase: string;
  /** Performs the GET. Injectable so tests can mock the call, not the transport. */
  get?: (url: string) => Promise<unknown>;
  /** Sleep between retries. Injectable for fake timers in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Lets the caller abort (e.g. effect cleanup) without reporting offline. */
  isCancelled?: () => boolean;
  /** Consecutive network errors required before declaring the server offline. */
  maxNetworkFailures?: number;
  /** Hard cap on total attempts (bounds repeated-429 looping). */
  maxAttempts?: number;
}

function backoffFor(attempt: number): number {
  return BACKOFF_MS.at(Math.min(attempt, BACKOFF_MS.length - 1)) ?? 10_000;
}

/** Parse a numeric `Retry-After` (seconds) header into ms, or null if absent/unparseable. */
function retryAfterMs(err: AxiosError): number | null {
  const raw = err.response?.headers?.["retry-after"];
  if (raw == null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

/**
 * Returns true if the backend is reachable, false if it's definitively offline.
 * Cancellation resolves to `true` (caller is tearing down; don't flash the wall).
 */
export async function checkHealthWithRetry(opts: CheckHealthOptions): Promise<boolean> {
  const {
    apiBase,
    get = (url: string) => axios.get(url, { timeout: 5_000 }),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    isCancelled = () => false,
    maxNetworkFailures = 3,
    maxAttempts = 6,
  } = opts;

  let networkFailures = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isCancelled()) return true;
    try {
      await get(`${apiBase}/health`);
      return true; // online
    } catch (rawErr) {
      const err = rawErr as AxiosError;
      const status = err.response?.status;

      if (status === 429) {
        // Rate limited: the server answered, so it's reachable — a 429 alone
        // must never trip the offline wall. Wait it out and retry.
        networkFailures = 0;
        if (isCancelled()) return true;
        await sleep(retryAfterMs(err) ?? backoffFor(attempt));
        continue;
      }

      if (status !== undefined) {
        // Any other HTTP error response (5xx, or an unexpected non-429 4xx):
        // the server is reachable but broken. Offline.
        return false;
      }

      // No response — genuine network error. Tolerate transient blips; only
      // declare offline after several consecutive failures.
      networkFailures++;
      if (networkFailures >= maxNetworkFailures) return false;
      if (isCancelled()) return true;
      await sleep(backoffFor(attempt));
    }
  }

  // Exhausted attempts without a hard failure — only reachable by repeated 429s,
  // which means the server is up (just throttled). Treat as online.
  return true;
}
