import { describe, it, expect, vi, beforeEach } from "vitest";

const getCandles = vi.fn();
vi.mock("@/api/endpoints/candles", () => ({ getCandles: (...a: unknown[]) => getCandles(...a) }));

import { peekHtfCandles, __resetHtfCache } from "@/lib/htfCandleCache";

const DAY_MS = 86_400_000;
const T0 = Date.parse("2026-11-10T00:00:00Z"); // the forming day
const day = (i: number, partial = false) => ({
    ts: new Date(T0 - i * DAY_MS).toISOString(), open: "1", high: "1", low: "1", close: String(i), volume: "1",
    ...(partial ? { partial: true } : {}),
});
/** The API's latest page: `n` closed days ascending, then the forming one. */
const page = (n: number) => ({ data: { candles: [...Array.from({ length: n }, (_, k) => day(n - k)), day(0, true)] } });
const flush = () => new Promise((r) => setTimeout(r, 0));
const NOW = T0 + 3_600_000;

beforeEach(() => {
    __resetHtfCache();
    getCandles.mockReset();
});

describe("HTF candle cache", () => {
    it("answers null at first, fetches once in the background, then serves closed bars only", async () => {
        getCandles.mockResolvedValue(page(400));
        const onLoad = vi.fn();
        expect(peekHtfCandles("p", "1d", 325, onLoad, NOW)).toBeNull();
        expect(peekHtfCandles("p", "1d", 325, onLoad, NOW)).toBeNull(); // same ask while in flight: no second request
        expect(getCandles).toHaveBeenCalledTimes(1);
        expect(getCandles).toHaveBeenCalledWith("p", { timeframe: "1d", limit: 326 });
        await flush();
        expect(onLoad).toHaveBeenCalledTimes(1);
        const got = peekHtfCandles("p", "1d", 325, onLoad, NOW)!;
        expect(got).toHaveLength(400);
        expect(got.some((c) => c.partial)).toBe(false);
        expect(getCandles).toHaveBeenCalledTimes(1);
    });

    it("a bigger warm-up refetches with the bigger limit; a smaller one reuses the cache", async () => {
        getCandles.mockResolvedValue(page(326));
        peekHtfCandles("p", "1d", 325, () => {}, NOW);
        await flush();
        peekHtfCandles("p", "1d", 100, () => {}, NOW);
        expect(getCandles).toHaveBeenCalledTimes(1);
        getCandles.mockResolvedValue(page(900));
        expect(peekHtfCandles("p", "1d", 800, () => {}, NOW)).toHaveLength(326); // still shown while it loads
        expect(getCandles).toHaveBeenLastCalledWith("p", { timeframe: "1d", limit: 801 });
    });

    it("all the history there is: no refetch for more", async () => {
        getCandles.mockResolvedValue(page(90));
        peekHtfCandles("p", "1d", 325, () => {}, NOW);
        await flush();
        peekHtfCandles("p", "1d", 600, () => {}, NOW);
        expect(getCandles).toHaveBeenCalledTimes(1);
    });

    it("refreshes once the next HTF bar has closed, not before", async () => {
        getCandles.mockResolvedValue(page(400));
        peekHtfCandles("p", "1d", 325, () => {}, NOW);
        await flush();
        peekHtfCandles("p", "1d", 325, () => {}, T0 + DAY_MS - 1); // the forming day hasn't closed
        expect(getCandles).toHaveBeenCalledTimes(1);
        peekHtfCandles("p", "1d", 325, () => {}, T0 + DAY_MS + 61_000);
        expect(getCandles).toHaveBeenCalledTimes(2);
    });

    it("per pair and timeframe; a failure waits 30 s before retrying", async () => {
        getCandles.mockRejectedValue(new Error("boom"));
        peekHtfCandles("p", "1d", 10, () => {}, NOW);
        await flush();
        peekHtfCandles("p", "1d", 10, () => {}, NOW + 29_000);
        expect(getCandles).toHaveBeenCalledTimes(1);
        peekHtfCandles("q", "1d", 10, () => {}, NOW);
        peekHtfCandles("p", "1w", 10, () => {}, NOW);
        expect(getCandles).toHaveBeenCalledTimes(3);
        peekHtfCandles("p", "1d", 10, () => {}, NOW + 31_000);
        expect(getCandles).toHaveBeenCalledTimes(4);
    });
});
