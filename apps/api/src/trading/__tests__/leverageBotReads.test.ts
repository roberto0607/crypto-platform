/**
 * leverageBotReads.test.ts: the ISOLATED path's per-order reads (the user's
 * position row and their open orders on the pair) are skipped for the
 * market maker and @system.local users. Their orders resolve SPOT before
 * either query runs (isolatedSettlement.resolveTakerMargin).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const labels: string[] = [];
vi.mock("../../observability/dbTiming", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../observability/dbTiming")>();
    return {
        ...actual,
        timedQuery: (client: unknown, label: string, ...rest: unknown[]) => {
            labels.push(label);
            return (actual.timedQuery as (...a: unknown[]) => unknown)(client, label, ...rest);
        },
    };
});

import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { placeOrderWithSnapshot } from "../phase6OrderService";

const PER_ORDER_READS = ["isolatedSettlement.readPosition", "isolatedSettlement.restingOrders"];
const saved = { ...config.leverage };
let pairId: string;
let btc: string;
let usd: string;

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const a = await createTestAssetAndPair(pool);
    pairId = a.pair.id;
    btc = a.btcAsset.id;
    usd = a.usdAsset.id;
    seedReferenceBook(pairId, "83000", "83000");
    Object.assign(config.leverage, { enabled: true, allowlist: [] });
    labels.length = 0;
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

async function trade(email: string) {
    const id = (await createTestUser(pool, { email })).id;
    await createTestWallets(pool, id, btc, usd, "1.00000000", "100000.00000000");
    labels.length = 0;
    await placeOrderWithSnapshot(id, { pairId, side: "BUY", type: "MARKET", qty: "0.00100000" });
    await placeOrderWithSnapshot(id, { pairId, side: "SELL", type: "LIMIT", qty: "0.00100000", limitPrice: "90000" });
    return labels.filter((l) => PER_ORDER_READS.includes(l));
}

describe("per-order ISOLATED reads", () => {
    it("are skipped for the market maker and @system.local users (flag on)", async () => {
        expect(await trade("mmbot@system.local")).toEqual([]);
        expect(await trade("ops@system.local")).toEqual([]);
    });

    it("run for a real user (the control)", async () => {
        expect(await trade("alice@test.local")).toEqual(expect.arrayContaining(PER_ORDER_READS));
    });
});
