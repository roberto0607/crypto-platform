import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { coalesce, coalesceByKey, COALESCE_WINDOW_MS } from "@/lib/coalesce";

describe("coalesce", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deferred() {
    let resolve!: (v: string) => void;
    const promise = new Promise<string>((r) => (resolve = r));
    return { promise, resolve };
  }

  it("collapses calls made at the same time into one request", async () => {
    const d = deferred();
    const fn = vi.fn(() => d.promise);
    const get = coalesce(fn);

    const results = [get(), get(), get()];
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve("x");
    expect(await Promise.all(results)).toEqual(["x", "x", "x"]);
  });

  it("starts a fresh request once the previous one settled", async () => {
    const fn = vi.fn(async () => "x");
    const get = coalesce(fn);
    await get();
    await get();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not join a request older than the window (refetch after a mutation)", async () => {
    const first = deferred();
    const fn = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce("fresh");
    const get = coalesce(fn);

    void get();
    vi.advanceTimersByTime(COALESCE_WINDOW_MS);
    expect(await get()).toBe("fresh");
    expect(fn).toHaveBeenCalledTimes(2);
    first.resolve("stale");
  });

  it("keeps keys separate", async () => {
    const fn = vi.fn(async (k: string) => k);
    const get = coalesceByKey(fn);
    expect(await Promise.all([get("btc"), get("eth"), get("btc")])).toEqual(["btc", "eth", "btc"]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const get = coalesce(fn);
    await expect(get()).rejects.toThrow("boom");
    expect(await get()).toBe("ok");
  });
});
