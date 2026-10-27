/**
 * journalLeverage.test.ts: the journal and its CSV carry leverage, margin,
 * close_reason and return on margin (leverage PR 7; columns from migration
 * 096, docs/designs/2026-10-13-leverage-design.md §4 "Journal / CSV").
 *
 * An ISOLATED close writes each closed_trades row with the position's
 * leverage, the margin that row's share of the close released, and
 * return_on_margin_pct = (booked P&L − booked closing fee) / that margin:
 * the loss-capped numbers the wallet got, so never below −100%. A SPOT close keeps the
 * column defaults (leverage 1, margin and return on margin NULL).
 * GET /v1/trades/journal/export appends the four columns.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import Decimal from "decimal.js";
import { buildApp } from "../../app";
import { pool } from "../../db/pool";
import { config } from "../../config";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, createTestWallets } from "../../testing/fixtures";
import { seedReferenceBook, clearReferenceBooks } from "../../testing/referenceBook";
import { resetMarketDataPairIdCache } from "../../market/marketSymbols";
import { placeOrderWithSnapshot } from "../../trading/phase6OrderService";

let app: FastifyInstance;
let pairId: string;
let btcAssetId: string;
let usdAssetId: string;
const saved = { ...config.leverage };
const SIZE = "0.00602409"; // $50 margin at 10x from 83,000

const flagOn = () => Object.assign(config.leverage, {
    enabled: true, liquidationMode: "execute", maxFreePlay: 10, maxMatch: 5, maxCompetition: 1, allowlist: [],
});

async function trader(usd = "1000.00000000"): Promise<string> {
    const u = await createTestUser(pool);
    await createTestWallets(pool, u.id, btcAssetId, usdAssetId, "0.00000000", usd);
    return u.id;
}

const market = (uid: string, side: "BUY" | "SELL", qty: string, leverage?: number) =>
    placeOrderWithSnapshot(uid, { pairId, side, type: "MARKET", qty, leverage });

type Row = { leverage: string; margin: string | null; close_reason: string | null; return_on_margin_pct: string | null; net_pnl: string };
async function rows(uid: string): Promise<Row[]> {
    const { rows: r } = await pool.query<Row>(
        `SELECT leverage::text, margin::text, close_reason, return_on_margin_pct::text, net_pnl::text
         FROM closed_trades WHERE user_id = $1 ORDER BY exit_at, id`, [uid]);
    return r;
}

async function lockedMargin(uid: string): Promise<string> {
    const { rows: r } = await pool.query<{ isolated_margin: string }>(
        `SELECT isolated_margin::text FROM positions WHERE user_id = $1 AND pair_id = $2`, [uid, pairId]);
    return r[0].isolated_margin;
}

/** (booked P&L − closing fee) / margin, for a close of `qty` from `entry` at `exit` (no loss cap hit). */
const rom = (qty: string, entry: number, exit: number, margin: string, side: "LONG" | "SHORT" = "LONG") => {
    const q = new Decimal(qty);
    const pnl = q.mul(side === "LONG" ? exit - entry : entry - exit);
    const fee = q.mul(exit).toDecimalPlaces(8).mul(5).div(10000);
    return pnl.minus(fee).div(margin).mul(100).toNumber();
};

beforeAll(async () => {
    await ensureMigrations();
    app = await buildApp({
        logger: false, disableKrakenFeed: true, disableTriggerEngine: true, disableJobRunner: true,
        disableOutboxWorker: true, disableLockSampler: true, disableOrchestrator: true,
    });
    await app.ready();
});

afterAll(async () => {
    await app.close();
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
});

afterEach(() => {
    Object.assign(config.leverage, saved, { allowlist: [...saved.allowlist] });
});

describe("closed_trades: leverage, margin, return on margin", () => {
    it("a 10x close: the position's leverage, its margin, net P&L / margin", async () => {
        flagOn();
        const u = await trader();
        await market(u, "BUY", SIZE, 10);
        const margin = await lockedMargin(u);
        seedReferenceBook(pairId, "84000", "84000");
        await market(u, "SELL", SIZE);
        const [r] = await rows(u);
        expect(r.leverage).toBe("10.00");
        expect(r.margin).toBe(margin);
        expect(r.close_reason).toBe("MANUAL");
        expect(Number(r.return_on_margin_pct)).toBeCloseTo(rom(SIZE, 83000, 84000, margin), 3);
        expect(Number(r.return_on_margin_pct)).toBeGreaterThan(11); // +1.2% move at 10x, less the closing fee
    });

    it("a partial close records the margin that part released", async () => {
        flagOn();
        const u = await trader();
        await market(u, "BUY", "0.01000000", 5);
        const margin = new Decimal(await lockedMargin(u));
        await market(u, "SELL", "0.00400000");
        await market(u, "SELL", "0.00600000");
        const [a, b] = await rows(u);
        expect(Number(a.margin)).toBeCloseTo(margin.mul(0.4).toNumber(), 6);
        expect(Number(b.margin)).toBeCloseTo(margin.mul(0.6).toNumber(), 6);
        expect(new Decimal(a.margin!).plus(b.margin!).toNumber()).toBeCloseTo(margin.toNumber(), 7);
        expect(a.leverage).toBe("5.00");
    });

    it("a gap past bankruptcy: the loss is capped, so return on margin is exactly −100% (not below)", async () => {
        flagOn();
        const u = await trader();
        await market(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "70000", "70000"); // bankruptcy ≈ 74,700: far past it
        await market(u, "SELL", SIZE);
        const [r] = await rows(u);
        expect(r.return_on_margin_pct).toBe("-100.0000");
        expect(Number(r.net_pnl)).toBeLessThan(-Number(r.margin)); // the journal's own FIFO P&L isn't capped
    });

    it("a liquidation: LIQUIDATION, the whole margin", async () => {
        flagOn();
        const u = await trader();
        await market(u, "BUY", SIZE, 10);
        const margin = await lockedMargin(u);
        seedReferenceBook(pairId, "75000", "75000");
        await placeOrderWithSnapshot(
            u, { pairId, side: "SELL", type: "MARKET", qty: SIZE },
            undefined, undefined, null, null, "liquidation", { epoch: 1, side: "LONG" },
        );
        const [r] = await rows(u);
        expect(r).toMatchObject({ leverage: "10.00", margin, close_reason: "LIQUIDATION" });
        expect(Number(r.return_on_margin_pct)).toBeLessThan(-90);
        expect(Number(r.return_on_margin_pct)).toBeGreaterThanOrEqual(-100);
    });

    it("SPOT (flag off): leverage 1, no margin, no return on margin", async () => {
        const u = await trader("10000.00000000");
        await market(u, "BUY", "0.01000000");
        await market(u, "SELL", "0.01000000");
        expect(await rows(u)).toMatchObject([{ leverage: "1.00", margin: null, return_on_margin_pct: null, close_reason: "MANUAL" }]);
    });
});

describe("GET /v1/trades/journal/export", () => {
    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

    it("appends Leverage, Margin, Close Reason, Return on Margin %", async () => {
        const u = await trader();
        await market(u, "BUY", "0.00100000"); // SPOT first (flag off)
        await market(u, "SELL", "0.00100000");
        flagOn();
        await market(u, "BUY", SIZE, 10);
        seedReferenceBook(pairId, "84000", "84000");
        await market(u, "SELL", SIZE);

        const res = await app.inject({ method: "GET", url: "/v1/trades/journal/export", headers: auth(u) });
        expect(res.statusCode).toBe(200);
        const [header, ...lines] = res.body.split("\n");
        expect(header).toBe(
            "Date,Pair,Direction,Entry Price,Exit Price,Qty,Gross P&L,Fees,Net P&L,Return %,Hold Time (s)," +
            "Leverage,Margin,Close Reason,Return on Margin %",
        );
        const [iso, spot] = lines.map((l) => l.split(",")); // newest first
        const r = (await rows(u))[1];
        expect(iso.slice(11)).toEqual(["10.00", r.margin, "MANUAL", r.return_on_margin_pct]);
        expect(spot.slice(11)).toEqual(["1.00", "", "MANUAL", ""]);
    });
});

describe("export size", () => {
    const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, role: "USER" }, { expiresIn: 3600 })}` });

    it("exports every trade (the route asks for up to 10,000; the paged list stays capped at 100)", async () => {
        const u = await trader();
        await pool.query(
            `INSERT INTO closed_trades
                (user_id, pair_id, competition_id, direction, entry_fill_ids, entry_qty, entry_avg_price, entry_fees, entry_at,
                 exit_fill_ids, exit_qty, exit_avg_price, exit_fees, exit_at, gross_pnl, total_fees, net_pnl, return_pct,
                 holding_seconds, close_reason)
             SELECT $1, $2, NULL, 'LONG', ARRAY[gen_random_uuid()], 0.001, 83000, 0.04, now() - (g || ' minutes')::interval,
                    ARRAY[gen_random_uuid()], 0.001, 83100, 0.04, now() - (g || ' minutes')::interval + interval '30 seconds',
                    0.1, 0.08, 0.02, 0.0241, 30, 'MANUAL'
             FROM generate_series(1, 130) g`,
            [u, pairId],
        );
        const res = await app.inject({ method: "GET", url: "/v1/trades/journal/export", headers: auth(u) });
        expect(res.statusCode).toBe(200);
        expect(res.body.split("\n").length - 1).toBe(130); // minus the header

        const page = await app.inject({ method: "GET", url: "/v1/trades/journal?limit=100", headers: auth(u) });
        expect(page.json().trades).toHaveLength(100);
    });
});
