/**
 * marketMakerJob.test.ts — quote hygiene (PR B3).
 *
 * The bot must never leave quotes resting on a market it can't see: it pulls
 * every quote for a pair when the Kraken snapshot goes stale (getSnapshot →
 * null, the same 10s rule the execution agent rejects on), requotes on a 10bps
 * mid move, and pulls everything on boot. Order service, snapshot store and
 * DB are mocked — these are decisions, not SQL.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getSnapshot: vi.fn(),
    placeOrderWithSnapshot: vi.fn(),
    cancelAllOrdersWithOutbox: vi.fn(),
    listActivePairs: vi.fn(),
    poolQuery: vi.fn(),
}));

vi.mock("../../../market/snapshotStore", () => ({ getSnapshot: mocks.getSnapshot }));
vi.mock("../../../trading/phase6OrderService", () => ({
    placeOrderWithSnapshot: mocks.placeOrderWithSnapshot,
    cancelAllOrdersWithOutbox: mocks.cancelAllOrdersWithOutbox,
}));
vi.mock("../../../trading/pairRepo", () => ({ listActivePairs: mocks.listActivePairs }));
vi.mock("../../../db/pool", () => ({ pool: { query: mocks.poolQuery } }));

import { marketMakerJob, REQUOTE_THRESHOLD_BPS, __resetMarketMakerForTest } from "../marketMakerJob";
import { config } from "../../../config";
import type { JobContext } from "../../jobTypes";

const BTC = { id: "pair-btc", symbol: "BTC/USD" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
const ctx = { pool: {}, logger, signal: new AbortController().signal } as unknown as JobContext;

function snap(last: string) {
    return { bid: null, ask: null, last, ts: new Date().toISOString(), source: "live" as const };
}

/** Run one job tick and report what it did to the book. */
async function tick() {
    mocks.placeOrderWithSnapshot.mockClear();
    mocks.cancelAllOrdersWithOutbox.mockClear();
    await marketMakerJob.run(ctx);
    return {
        cancels: mocks.cancelAllOrdersWithOutbox.mock.calls.map((c) => c[0]),
        places: mocks.placeOrderWithSnapshot.mock.calls.map((c) => c[1]),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    __resetMarketMakerForTest();
    mocks.listActivePairs.mockResolvedValue([BTC]);
    mocks.cancelAllOrdersWithOutbox.mockResolvedValue({ canceled: [], skipped: [] });
    mocks.placeOrderWithSnapshot.mockResolvedValue({});
    // ensureBotSetup: bot user exists, no assets to fund.
    mocks.poolQuery.mockImplementation(async (sql: string) =>
        sql.includes("FROM users") ? { rows: [{ id: config.botUserId }] } : { rows: [] },
    );
});

describe("market maker — boot", () => {
    it("cancels every bot order (all pairs) before quoting fresh on the first run", async () => {
        mocks.getSnapshot.mockResolvedValue(snap("84776.30"));
        const { cancels, places } = await tick();

        expect(cancels[0]).toEqual({ userId: config.botUserId, pairId: undefined }); // boot: all pairs
        expect(cancels[1]).toEqual({ userId: config.botUserId, pairId: BTC.id }); // then the requote
        expect(places).toHaveLength(6); // 3 levels × 2 sides
        expect(mocks.cancelAllOrdersWithOutbox.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.placeOrderWithSnapshot.mock.invocationCallOrder[0],
        );
    });

    it("still pulls everything on boot when the price is stale, and quotes nothing", async () => {
        mocks.getSnapshot.mockResolvedValue(null);
        const { cancels, places } = await tick();
        expect(cancels).toContainEqual({ userId: config.botUserId, pairId: undefined });
        expect(places).toHaveLength(0);
    });
});

describe("market maker — stale price source", () => {
    it("cancels all quotes for the pair when the snapshot goes stale, and places none", async () => {
        mocks.getSnapshot.mockResolvedValue(snap("84776.30"));
        await tick(); // boot + quote

        mocks.getSnapshot.mockResolvedValue(null);
        const { cancels, places } = await tick();

        expect(cancels).toEqual([{ userId: config.botUserId, pairId: BTC.id }]);
        expect(places).toHaveLength(0);
    });

    it("keeps not quoting while stale", async () => {
        mocks.getSnapshot.mockResolvedValue(null);
        await tick();
        const { places } = await tick();
        expect(places).toHaveLength(0);
    });

    it("requotes as soon as the price is fresh again, even if the mid barely moved", async () => {
        mocks.getSnapshot.mockResolvedValue(snap("84776.30"));
        await tick();
        mocks.getSnapshot.mockResolvedValue(null);
        await tick();

        mocks.getSnapshot.mockResolvedValue(snap("84776.31")); // ~0.001bps from the last quote
        const { places } = await tick();
        expect(places).toHaveLength(6);
    });
});

describe("market maker — requote threshold", () => {
    it("is 10bps", () => {
        expect(REQUOTE_THRESHOLD_BPS).toBe(10);
    });

    it("keeps quotes under a 10bps move and requotes at 10bps", async () => {
        mocks.getSnapshot.mockResolvedValue(snap("80000"));
        await tick();

        mocks.getSnapshot.mockResolvedValue(snap("80079.99")); // 9.999bps
        expect((await tick()).places).toHaveLength(0);

        mocks.getSnapshot.mockResolvedValue(snap("80080")); // 10bps
        const { cancels, places } = await tick();
        expect(cancels).toEqual([{ userId: config.botUserId, pairId: BTC.id }]);
        expect(places).toHaveLength(6);
    });

    it("prod fill #1: the 84776.30 quote would have been replaced long before Kraken reached 85137", async () => {
        // Kraken crossed +10bps (84861.1) within the 18:20Z bar (h 84912.1);
        // under the old 50bps threshold the quote survived to the 18:39:49Z fill.
        mocks.getSnapshot.mockResolvedValue(snap("84776.30"));
        await tick();

        mocks.getSnapshot.mockResolvedValue(snap("84912.1"));
        const { places } = await tick();
        const asks = places.filter((b) => b.side === "SELL").map((b) => b.limitPrice);
        expect(asks).not.toContain("84818.68");
        expect(asks[0]).toBe("84954.55"); // 84912.1 + 5bps (MM rounds down)
    });
});
