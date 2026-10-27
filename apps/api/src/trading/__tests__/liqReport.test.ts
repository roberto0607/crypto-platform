/**
 * liqReport.test.ts: pnpm leverage:liq-report (leverage PR 7).
 *
 * The report lists LOG_ONLY / SKIPPED_STALE rows with the mark, the liq price
 * and what execute would have booked. Oracle for "would have booked": an
 * actual execute at a book whose bid = ask = the row's mark books exactly the
 * same P&L, fee, returned equity and shortfall. The report is read-only.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../phase6OrderService";
import { LiquidationEngine, CONFIRM_MS, type FeedStatus } from "../liquidationEngine";
import { buildLiqReport, formatLiqReport, parseLiqReportArgs, type LiqReportArgs } from "../liqReport";

let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };
const SIZE = "0.00602409"; // $50 at 10x from 83,000: liq 75,075.38
let feed: FeedStatus = "ok";
const ALL: LiqReportArgs = { since: null, userId: null, mode: null, json: false };

function flagOn(mode: "log_only" | "execute") {
    Object.assign(config.leverage, {
        enabled: true, liquidationMode: mode, maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
    });
}

async function trader(email?: string): Promise<string> {
    const u = await createTestUser(pool, email ? { email } : {});
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", "1000.00000000");
    return u.id;
}

const open = (uid: string, side: "BUY" | "SELL") =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty: SIZE, leverage: 10 });

async function report(args: LiqReportArgs = ALL) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        const r = await buildLiqReport(client, args);
        await client.query("COMMIT");
        return r;
    } finally {
        client.release();
    }
}

/** Log-only: breach at `price` on two evaluations CONFIRM_MS apart. */
async function logOnlyAt(price: string): Promise<void> {
    const engine = new LiquidationEngine({ feedStatus: () => feed, useLeadership: false });
    seedReferenceBook(pairId, price, price);
    const t0 = Date.now();
    await engine.evaluatePair(pairId, t0);
    await engine.evaluatePair(pairId, t0 + CONFIRM_MS);
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    clearReferenceBooks();
    const assets = await createTestAssetAndPair(pool);
    pairId = assets.pair.id;
    btcAssetId = assets.btcAsset.id;
    usdAssetId = assets.usdAsset.id;
    seedReferenceBook(pairId, "83000", "83000");
    resetMarketDataPairIdCache();
    feed = "ok";
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe("leverage:liq-report", () => {
    it.each([
        ["LONG, just past liq", "BUY", "75000"],
        ["LONG, gapped past bankruptcy", "BUY", "74000"],
        ["SHORT, just past liq", "SELL", "90900"],
    ] as const)("%s: 'execute would have' equals a real execute at that mark", async (_l, side, price) => {
        flagOn("log_only");
        const u = await trader("liq-report@example.com");
        await open(u, side);
        await logOnlyAt(price);

        const rep = await report();
        expect(rep.counts).toMatchObject({ LOG_ONLY: 1, SKIPPED_STALE: 0, executed: 0, openSameEpoch: 1, inconsistent: 0 });
        const [r] = rep.rows;
        expect(r).toMatchObject({
            mode: "LOG_ONLY", userId: u, email: "liq-report@example.com", side: side === "BUY" ? "LONG" : "SHORT",
            qty: SIZE, leverage: "10.00", mark: `${price}.00000000`, now: "OPEN_SAME_EPOCH",
        });
        expect(Number(r.pastLiqPct)).toBeGreaterThan(0);

        // The oracle: execute it for real at bid = ask = the mark.
        flagOn("execute");
        const res = await placeOrderWithSnapshot(
            u, { pairId, side: side === "BUY" ? "SELL" : "BUY", type: "MARKET", qty: SIZE },
            undefined, undefined, null, null, "liquidation", { epoch: 1, side: r.side },
        );
        const l = res.liquidation!;
        expect(r.wouldExecute).toEqual({
            fillPrice: l.fillPrice, realizedPnl: l.realizedPnl, fee: l.fee,
            returnedEquity: l.returnedEquity, shortfall: l.shortfall,
        });

        // ...and now the report says it's closed, and counts the execution.
        const after = await report();
        expect(after.rows[0].now).toBe("CLOSED_OR_REOPENED");
        expect(after.counts.executed).toBe(1);
    });

    it("SKIPPED_STALE rows are listed; filters by mode, user and time", async () => {
        flagOn("log_only");
        const a = await trader();
        const b = await trader();
        await open(a, "BUY");
        await open(b, "BUY");
        // b: a stale-feed breach. a: a log-only breach.
        feed = "stale";
        seedReferenceBook(pairId, "75000", "75000");
        await new LiquidationEngine({ feedStatus: () => feed, useLeadership: false }).evaluatePair(pairId);
        feed = "ok";
        await pool.query(`DELETE FROM liquidations WHERE user_id = $1`, [a]); // keep only b's stale row
        await logOnlyAt("75000");

        const rep = await report();
        expect(rep.rows.map((r) => [r.mode, r.userId]).sort()).toEqual(
            [["LOG_ONLY", a], ["LOG_ONLY", b], ["SKIPPED_STALE", b]].sort(),
        );
        expect((await report({ ...ALL, mode: "SKIPPED_STALE" })).rows.map((r) => r.userId)).toEqual([b]);
        expect((await report({ ...ALL, userId: a })).rows.map((r) => r.mode)).toEqual(["LOG_ONLY"]);
        expect((await report({ ...ALL, since: new Date(Date.now() + 60_000) })).rows).toEqual([]);
    });

    it("writes nothing (runs in a READ ONLY transaction) and formats a readable table", async () => {
        flagOn("log_only");
        const u = await trader("reader@example.com");
        await open(u, "BUY");
        await logOnlyAt("75000");
        const before = (await pool.query(`SELECT * FROM liquidations ORDER BY id`)).rows;
        const rep = await report();
        expect((await pool.query(`SELECT * FROM liquidations ORDER BY id`)).rows).toEqual(before);
        const text = formatLiqReport(rep, ALL);
        expect(text).toContain("LOG_ONLY 1 · SKIPPED_STALE 0 · EXECUTED 0");
        expect(text).toContain("reader@example.com");
        expect(text).toContain("mark $75000.00  liq $75075.37");
        expect(text).toContain("STILL OPEN");
    });

    it("parses its arguments strictly", () => {
        expect(parseLiqReportArgs(["--since", "2026-10-26", "--mode", "log_only", "--json"])).toMatchObject({
            mode: "LOG_ONLY", json: true, since: new Date("2026-10-26"),
        });
        expect(() => parseLiqReportArgs(["--apply"])).toThrow("unknown argument");
        expect(() => parseLiqReportArgs(["--user", "nope"])).toThrow("not a uuid");
        expect(() => parseLiqReportArgs(["--since", "yesterday-ish"])).toThrow("not a date");
    });
});
