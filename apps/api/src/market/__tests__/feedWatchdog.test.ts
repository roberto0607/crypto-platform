import { describe, it, expect } from "vitest";
import { StalenessTracker, ReconnectBackoff } from "../feedWatchdog";
import {
    recordKrakenReconnectAttempt,
    isKrakenReconnectBudgetExceeded,
    KRAKEN_RECONNECT_BUDGET_10M,
    __resetKrakenReconnectTrackerForTest,
} from "../krakenReconnectTracker";

const SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const T0 = 1_000_000;

function tracker() {
    const t = new StalenessTracker({ staleMs: 8_000, graceMs: 10_000, maxCheckGapMs: 3_000 });
    t.reset(T0);
    return t;
}

/** Run 1s checks from `from` to `to` (inclusive), feeding `alive` symbols every second. */
function run(t: StalenessTracker, from: number, to: number, alive: string[]) {
    const episodes = [];
    for (let now = from; now <= to; now += 1_000) {
        for (const s of alive) t.record(s, now);
        episodes.push(...t.check(SYMBOLS, now));
    }
    return episodes;
}

describe("StalenessTracker", () => {
    it("silentSince is the last message, else when the key was first expected, else null", () => {
        const t = tracker();
        expect(t.silentSince("BTC/USD")).toBeNull();
        t.check(["BTC/USD"], T0 + 1_000); // first check: BTC expected since connect
        expect(t.silentSince("BTC/USD")).toBe(T0);
        t.record("BTC/USD", T0 + 2_500);
        expect(t.silentSince("BTC/USD")).toBe(T0 + 2_500);
        t.disconnect();
        expect(t.silentSince("BTC/USD")).toBeNull();
    });

    it.each(SYMBOLS)("flags only %s when it alone goes silent", (silent) => {
        const t = tracker();
        run(t, T0, T0 + 3_000, SYMBOLS);
        const others = SYMBOLS.filter((s) => s !== silent);
        const episodes = run(t, T0 + 4_000, T0 + 20_000, others);

        expect(episodes).toHaveLength(1);
        expect(episodes[0]).toMatchObject({ key: silent, seenSinceConnect: true });
        expect(episodes[0]!.silentMs).toBe(9_000); // last seen T0+3s, first check past 8s is T0+12s
        expect(t.isStale(silent)).toBe(true);
        for (const s of others) expect(t.isStale(s)).toBe(false);
    });

    it("reports an episode once, and again only after the key recovers", () => {
        const t = tracker();
        run(t, T0, T0 + 1_000, SYMBOLS);
        expect(run(t, T0 + 2_000, T0 + 30_000, ["BTC/USD", "ETH/USD"])).toHaveLength(1);

        t.record("SOL/USD", T0 + 30_500);
        expect(t.isStale("SOL/USD")).toBe(false);
        expect(run(t, T0 + 31_000, T0 + 45_000, ["BTC/USD", "ETH/USD"])).toHaveLength(1);
    });

    it("gives a symbol the grace period after connect before its first message", () => {
        const t = tracker();
        // Nothing for SOL yet: 9s after connect is within the 10s grace even though > staleMs.
        expect(run(t, T0, T0 + 10_000, ["BTC/USD", "ETH/USD"])).toEqual([]);
        const ep = run(t, T0 + 11_000, T0 + 11_000, ["BTC/USD", "ETH/USD"]);
        expect(ep).toEqual([{ key: "SOL/USD", silentMs: 11_000, seenSinceConnect: false }]);
    });

    it("starts a symbol's clock at its first message, not at connect", () => {
        const t = tracker();
        run(t, T0, T0 + 9_000, ["BTC/USD", "ETH/USD"]);
        t.record("SOL/USD", T0 + 9_500); // slow snapshot, inside grace
        // Stale only 8s after that first message.
        expect(run(t, T0 + 10_000, T0 + 17_000, ["BTC/USD", "ETH/USD"])).toEqual([]);
        expect(run(t, T0 + 18_000, T0 + 18_000, ["BTC/USD", "ETH/USD"])).toMatchObject([{ key: "SOL/USD" }]);
    });

    it("gives a symbol added mid-connection its own grace", () => {
        const t = tracker();
        run(t, T0, T0 + 60_000, SYMBOLS);
        const withNew = [...SYMBOLS, "XRP/USD"];
        for (let now = T0 + 61_000; now <= T0 + 70_000; now += 1_000) {
            for (const s of SYMBOLS) t.record(s, now);
            expect(t.check(withNew, now)).toEqual([]);
        }
        for (const s of SYMBOLS) t.record(s, T0 + 72_000);
        expect(t.check(withNew, T0 + 72_000)).toMatchObject([{ key: "XRP/USD", seenSinceConnect: false }]);
    });

    it("forgets the previous connection on reset", () => {
        const t = tracker();
        run(t, T0, T0 + 1_000, SYMBOLS);
        run(t, T0 + 2_000, T0 + 15_000, ["BTC/USD"]);
        expect(t.isStale("SOL/USD")).toBe(true);

        t.reset(T0 + 16_000);
        expect(t.isStale("SOL/USD")).toBe(false);
        expect(t.ageOf("BTC/USD", T0 + 16_000)).toBeNull();
        expect(run(t, T0 + 16_000, T0 + 25_000, [])).toEqual([]); // grace again
    });

    it("skips a check that follows a blocked event loop instead of flagging everything", () => {
        const t = tracker();
        run(t, T0, T0 + 2_000, SYMBOLS);
        // Loop blocked 12s: buffered messages haven't been processed when this check runs.
        expect(t.check(SYMBOLS, T0 + 14_000)).toEqual([]);
        // Messages drain right after; the next on-time check sees fresh data.
        for (const s of SYMBOLS) t.record(s, T0 + 14_010);
        expect(t.check(SYMBOLS, T0 + 15_000)).toEqual([]);
    });

    it("watches nothing while disconnected", () => {
        const t = tracker();
        t.disconnect();
        expect(t.check(SYMBOLS, T0 + 60_000)).toEqual([]);
    });
});

describe("ReconnectBackoff", () => {
    const opts = { baseMs: 1_000, maxMs: 60_000, jitter: 0.2, healthyResetMs: 60_000 };

    it("doubles from 1s to the 60s cap without jitter at random=0.5", () => {
        const b = new ReconnectBackoff({ ...opts, random: () => 0.5 });
        const delays = Array.from({ length: 9 }, () => b.nextDelay());
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    });

    it("keeps jitter within ±20% and never exceeds the cap", () => {
        const lo = new ReconnectBackoff({ ...opts, random: () => 0 });
        const hi = new ReconnectBackoff({ ...opts, random: () => 0.999999 });
        for (let i = 0; i < 10; i++) {
            const raw = Math.min(60_000, 1_000 * 2 ** i);
            const l = lo.nextDelay();
            const h = hi.nextDelay();
            expect(l).toBeGreaterThanOrEqual(Math.floor(raw * 0.8));
            expect(h).toBeLessThanOrEqual(Math.min(60_000, Math.ceil(raw * 1.2)));
        }
    });

    it("does not reset on open: a connect-then-flap socket keeps backing off", () => {
        const b = new ReconnectBackoff({ ...opts, random: () => 0.5 });
        let now = T0;
        const delays: number[] = [];
        for (let i = 0; i < 5; i++) {
            const d = b.nextDelay();
            delays.push(d);
            now += d;
            b.onOpen(now);
            b.onHealthy(now + 5_000); // some data, then it drops again within 60s
            now += 5_000;
        }
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    });

    it("resets once the socket has delivered data for 60s", () => {
        const b = new ReconnectBackoff({ ...opts, random: () => 0.5 });
        b.nextDelay();
        b.nextDelay();
        b.nextDelay();
        b.onOpen(T0);
        b.onHealthy(T0 + 59_999);
        expect(b.attempts).toBe(3);
        b.onHealthy(T0 + 60_000);
        expect(b.attempts).toBe(0);
        expect(b.nextDelay()).toBe(1_000);
    });

    it("waits the cap when the shared budget is exceeded", () => {
        const b = new ReconnectBackoff({ ...opts, random: () => 0.5 });
        expect(b.nextDelay({ budgetExceeded: true })).toBe(60_000);
    });
});

describe("shared Kraken reconnect budget", () => {
    it("counts both sockets' attempts in one 10-minute window", () => {
        __resetKrakenReconnectTrackerForTest();
        let count = 0;
        for (let i = 0; i < KRAKEN_RECONNECT_BUDGET_10M; i++) {
            count = recordKrakenReconnectAttempt(T0 + i * 1_000); // alternate callers share the counter
        }
        expect(isKrakenReconnectBudgetExceeded(count)).toBe(false);
        count = recordKrakenReconnectAttempt(T0 + 30_000);
        expect(isKrakenReconnectBudgetExceeded(count)).toBe(true);
        // Ten minutes later the window has emptied.
        count = recordKrakenReconnectAttempt(T0 + 30_000 + 10 * 60_000 + 1);
        expect(count).toBe(1);
        __resetKrakenReconnectTrackerForTest();
    });
});
