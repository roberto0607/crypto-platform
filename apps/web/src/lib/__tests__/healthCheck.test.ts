import { describe, it, expect, vi } from "vitest";
import { checkHealthWithRetry } from "@/lib/healthCheck";

// Build axios-shaped errors. The helper only reads `err.response?.status` and
// `err.response?.headers["retry-after"]`, so we mock the call (`get`), not the
// transport — and inject an instant `sleep` so we assert backoff durations
// directly instead of dancing with fake timers.
function httpError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });
}
function networkError() {
  // No `response` property → indistinguishable from a fetch/axios network failure.
  return new Error("Network Error");
}

const apiBase = "/api";

describe("checkHealthWithRetry", () => {
  it("returns online on a 2xx with no retries", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(await checkHealthWithRetry({ apiBase, get, sleep })).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT report offline on 429 — retries silently, then succeeds", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(await checkHealthWithRetry({ apiBase, get, sleep })).toBe(true);
    expect(get).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("never reports offline even when 429 persists past every attempt", async () => {
    const get = vi.fn().mockRejectedValue(httpError(429));
    const sleep = vi.fn().mockResolvedValue(undefined);

    // A 429 means the server answered (reachable, just throttled). Exhausting
    // maxAttempts on 429 must resolve online, never the offline wall.
    expect(await checkHealthWithRetry({ apiBase, get, sleep, maxAttempts: 4 })).toBe(true);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("honors a numeric Retry-After header on 429", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, { "retry-after": "7" }))
      .mockResolvedValueOnce({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await checkHealthWithRetry({ apiBase, get, sleep });
    expect(sleep).toHaveBeenCalledWith(7_000); // 7s header → 7000ms
  });

  it("falls back to backoff when Retry-After is absent", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await checkHealthWithRetry({ apiBase, get, sleep });
    expect(sleep).toHaveBeenCalledWith(5_000); // first backoff step
  });

  it("reports offline immediately on a 5xx (server reachable but broken)", async () => {
    const get = vi.fn().mockRejectedValue(httpError(503));
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(await checkHealthWithRetry({ apiBase, get, sleep })).toBe(false);
    expect(get).toHaveBeenCalledTimes(1); // no retry — definitive failure
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT report offline on a single network error — retries first", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(await checkHealthWithRetry({ apiBase, get, sleep })).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("reports offline only after 3 consecutive network errors", async () => {
    const get = vi.fn().mockRejectedValue(networkError());
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(
      await checkHealthWithRetry({ apiBase, get, sleep, maxNetworkFailures: 3 }),
    ).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("treats cancellation as online (caller tearing down — no wall flash)", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200 });
    const sleep = vi.fn().mockResolvedValue(undefined);

    expect(
      await checkHealthWithRetry({ apiBase, get, sleep, isCancelled: () => true }),
    ).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
