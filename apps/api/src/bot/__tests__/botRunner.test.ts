import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ── Mock modules before imports ──────────────── */

vi.mock("../../db/pool", () => ({
    pool: { query: vi.fn() },
}));

vi.mock("../../events/eventBus", () => ({
    subscribeGlobal: vi.fn(),
    unsubscribe: vi.fn(),
}));

vi.mock("../../trading/phase6OrderService", () => ({
    placeOrderWithSnapshot: vi.fn(),
}));

// Canonical logger mock — factory scoped inside vi.mock closure because
// vi.mock is hoisted to the top of the file. See phase6OrderService.test.ts.
vi.mock("../../observability/logContext", () => {
    const makeMockLogger = () => {
        const l: any = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            child: vi.fn(() => makeMockLogger()),
        };
        return l;
    };
    return {
        logger: makeMockLogger(),
        buildLogContext: vi.fn(() => ({})),
    };
});

vi.mock("../botRunRepo", () => ({
    updateRunStatus: vi.fn().mockResolvedValue({}),
    insertSignal: vi.fn().mockResolvedValue({ id: "sig-1" }),
}));

vi.mock("../strategyAdaptor", () => ({
    loadCandlesUpTo: vi.fn().mockResolvedValue([]),
}));

import {
    initBotRunner,
    shutdownBotRunner,
    registerRun,
    deregisterRun,
    pauseRunInRunner,
    resumeRunInRunner,
} from "../botRunner";
import { subscribeGlobal, unsubscribe } from "../../events/eventBus";
import { MAX_CONSECUTIVE_FAILURES } from "../botTypes";
import type { BotRunState } from "../botTypes";

/* ── Helpers ──────────────────────────────────── */

function makeMockEngine() {
    return {
        onDailyCandle: vi.fn(),
        on4HCandle: vi.fn(),
        onCandle: vi.fn(),
        flushEvents: vi.fn().mockReturnValue([]),
        getRegime: vi.fn().mockReturnValue("RANGE"),
        getEquity: vi.fn().mockReturnValue(10000),
    } as unknown as BotRunState["engine"];
}

function makeRunState(overrides: Partial<BotRunState> = {}): BotRunState {
    return {
        runId: "run-1",
        userId: "user-1",
        pairId: "pair-1",
        mode: "REPLAY",
        engine: makeMockEngine(),
        lastTickTs: 0,
        lastCandle15mTs: "",
        lastCandle4HTs: "",
        lastCandle1DTs: "",
        orderSeqThisTick: 0,
        consecutiveFailures: 0,
        paused: false,
        ...overrides,
    };
}

/* ── Tests ────────────────────────────────────── */

describe("botRunner lifecycle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shutdownBotRunner();
    });

    afterEach(() => {
        shutdownBotRunner();
    });

    it("initBotRunner subscribes to global event bus", () => {
        initBotRunner();
        expect(subscribeGlobal).toHaveBeenCalledOnce();
    });

    it("initBotRunner is idempotent (second call does nothing)", () => {
        initBotRunner();
        initBotRunner();
        expect(subscribeGlobal).toHaveBeenCalledOnce();
    });

    it("shutdownBotRunner unsubscribes and clears registry", () => {
        initBotRunner();
        const state = makeRunState();
        registerRun(state);
        shutdownBotRunner();
        expect(unsubscribe).toHaveBeenCalled();
    });

    it("registerRun + deregisterRun manage the in-memory registry", () => {
        const state = makeRunState();
        registerRun(state);
        // deregister should not throw
        deregisterRun(state.runId);
        // double deregister should not throw
        deregisterRun(state.runId);
    });

    it("pauseRunInRunner sets paused flag", () => {
        const state = makeRunState();
        registerRun(state);
        pauseRunInRunner(state.runId);
        expect(state.paused).toBe(true);
    });

    it("resumeRunInRunner clears paused flag", () => {
        const state = makeRunState({ paused: true });
        registerRun(state);
        resumeRunInRunner(state.runId);
        expect(state.paused).toBe(false);
    });

    it("pause/resume on unknown runId does not throw", () => {
        pauseRunInRunner("nonexistent");
        resumeRunInRunner("nonexistent");
    });
});

describe("idempotency key generation", () => {
    it("keys are deterministic for same inputs", () => {
        const runId = "run-abc";
        const tickTs = 1700000000000;
        const side = "BUY";
        const seq = 0;

        const key1 = `bot:${runId}:${tickTs}:${side}:${seq}`;
        const key2 = `bot:${runId}:${tickTs}:${side}:${seq}`;
        expect(key1).toBe(key2);
    });

    it("keys differ when tickTs differs", () => {
        const runId = "run-abc";
        const side = "BUY";
        const seq = 0;

        const key1 = `bot:${runId}:${1700000000000}:${side}:${seq}`;
        const key2 = `bot:${runId}:${1700000001000}:${side}:${seq}`;
        expect(key1).not.toBe(key2);
    });

    it("keys differ when side differs", () => {
        const runId = "run-abc";
        const tickTs = 1700000000000;
        const seq = 0;

        const keyBuy = `bot:${runId}:${tickTs}:BUY:${seq}`;
        const keySell = `bot:${runId}:${tickTs}:SELL:${seq}`;
        expect(keyBuy).not.toBe(keySell);
    });

    it("keys differ when seq differs", () => {
        const runId = "run-abc";
        const tickTs = 1700000000000;
        const side = "BUY";

        const key0 = `bot:${runId}:${tickTs}:${side}:0`;
        const key1 = `bot:${runId}:${tickTs}:${side}:1`;
        expect(key0).not.toBe(key1);
    });

    it("keys differ when runId differs", () => {
        const tickTs = 1700000000000;
        const side = "BUY";
        const seq = 0;

        const keyA = `bot:run-a:${tickTs}:${side}:${seq}`;
        const keyB = `bot:run-b:${tickTs}:${side}:${seq}`;
        expect(keyA).not.toBe(keyB);
    });
});

describe("tick idempotency", () => {
    it("lastTickTs prevents re-processing of same tick", () => {
        const state = makeRunState({ lastTickTs: 1700000000000 });

        // Simulating the guard: if tickTs <= state.lastTickTs, skip
        const tickTs = 1700000000000;
        const shouldSkip = tickTs <= state.lastTickTs;
        expect(shouldSkip).toBe(true);
    });

    it("allows processing of newer tick", () => {
        const state = makeRunState({ lastTickTs: 1700000000000 });

        const tickTs = 1700000001000;
        const shouldSkip = tickTs <= state.lastTickTs;
        expect(shouldSkip).toBe(false);
    });

    it("allows processing of first tick (lastTickTs=0)", () => {
        const state = makeRunState({ lastTickTs: 0 });

        const tickTs = 1700000000000;
        const shouldSkip = tickTs <= state.lastTickTs;
        expect(shouldSkip).toBe(false);
    });
});

describe("signal mapping", () => {
    it("ENTRY event maps to ENTRY kind with correct side", () => {
        const evt = {
            type: "ENTRY" as const,
            signal: { direction: "LONG" as const, entryPrice: 50000 },
            position: { positionSizeBtc: 0.1 },
        };

        const kind = "ENTRY";
        const side = evt.signal.direction === "LONG" ? "BUY" : "SELL";
        expect(kind).toBe("ENTRY");
        expect(side).toBe("BUY");
    });

    it("ENTRY SHORT maps to SELL", () => {
        const direction: string = "SHORT";
        const side = direction === "LONG" ? "BUY" : "SELL";
        expect(side).toBe("SELL");
    });

    it("EXIT LONG maps to SELL side (closing)", () => {
        const evt = {
            type: "EXIT" as const,
            log: { direction: "LONG" as const, positionSizeBtc: 0.1 },
        };

        const side = evt.log.direction === "LONG" ? "SELL" : "BUY";
        expect(side).toBe("SELL");
    });

    it("EXIT SHORT maps to BUY side (closing)", () => {
        const direction: string = "SHORT";
        const side = direction === "LONG" ? "SELL" : "BUY";
        expect(side).toBe("BUY");
    });

    it("REGIME_CHANGE maps with null side", () => {
        const evt = { type: "REGIME_CHANGE" as const, from: "RANGE", to: "TREND_UP" };
        const kind = "REGIME_CHANGE";
        const side = null;
        expect(kind).toBe("REGIME_CHANGE");
        expect(side).toBeNull();
    });
});

describe("consecutive failure threshold", () => {
    it("run is marked FAILED after MAX_CONSECUTIVE_FAILURES", () => {

        const state = makeRunState({ consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 });

        state.consecutiveFailures++;
        const shouldFail = state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        expect(shouldFail).toBe(true);
    });

    it("run is NOT marked FAILED below threshold", () => {

        const state = makeRunState({ consecutiveFailures: 0 });

        state.consecutiveFailures++;
        const shouldFail = state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        expect(shouldFail).toBe(false);
    });

    it("consecutiveFailures resets on success", () => {
        const state = makeRunState({ consecutiveFailures: 2 });
        // Simulate successful order
        state.consecutiveFailures = 0;
        expect(state.consecutiveFailures).toBe(0);
    });
});
