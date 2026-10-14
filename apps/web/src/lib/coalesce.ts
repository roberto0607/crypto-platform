/**
 * Collapse duplicate fetches fired by several components mounting at once
 * (e.g. three useCompetitionMode() callers each refreshing on mount) into one
 * request. Every request counts against the user's 200/min rate limit.
 *
 * A call joins an in-flight request only if that request started less than
 * `windowMs` ago. Mount-time duplicates land in the same render (well under
 * the window). A refetch after a mutation normally comes later than that,
 * so it gets its own request instead of a response that predates the
 * mutation.
 */
export const COALESCE_WINDOW_MS = 100;

export function coalesceByKey<K, T>(
  fn: (key: K) => Promise<T>,
  windowMs: number = COALESCE_WINDOW_MS,
): (key: K) => Promise<T> {
  const inFlight = new Map<K, { promise: Promise<T>; startedAt: number }>();
  return (key: K) => {
    const existing = inFlight.get(key);
    if (existing && Date.now() - existing.startedAt < windowMs) return existing.promise;
    const promise = fn(key).finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });
    inFlight.set(key, { promise, startedAt: Date.now() });
    return promise;
  };
}

/** coalesceByKey for a fetch with no arguments. */
export function coalesce<T>(fn: () => Promise<T>, windowMs: number = COALESCE_WINDOW_MS): () => Promise<T> {
  const byKey = coalesceByKey<null, T>(() => fn(), windowMs);
  return () => byKey(null);
}
