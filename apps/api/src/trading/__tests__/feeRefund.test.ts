/**
 * feeRefund.test.ts — the one-time pre-PR #201 taker fee overcharge refund
 * (trading/feeRefund.ts) against the real test DB.
 *
 * Pre-fix fills are seeded the way the old engine wrote them: the taker's
 * quote-wallet TRADE_BUY / TRADE_SELL entry with metadata { fee } and no
 * feeRole, at fee_bps 30. Post-fix entries carry feeRole.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair, seedTestOrder } from "../../testing/fixtures";
import { config } from "../../config";
import { D } from "../../utils/decimal";
import { planFeeRefund, applyFeeRefund, revertFeeRefund, FEE_CORRECTION_ENTRY_TYPE } from "../feeRefund";

const CUTOFF = new Date("2026-10-11T18:00:00Z");
const BEFORE = "2026-10-10T12:00:00Z";
const AFTER = "2026-10-11T19:00:00Z";

let pairId: string;
let usdAssetId: string;

async function wallet(userId: string, scope: { competitionId?: string; matchId?: string } = {}) {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO wallets (user_id, asset_id, balance, reserved, competition_id, match_id)
         VALUES ($1, $2, '100000.00000000', '0', $3, $4) RETURNING id`,
        [userId, usdAssetId, scope.competitionId ?? null, scope.matchId ?? null],
    );
    return rows[0].id;
}

/**
 * One taker fill as the ledger recorded it: a $50 trade, its fee in metadata.
 * `fee` 0.15 = 30 bps of $50, the pre-fix charge; feeRole marks a post-fix entry.
 */
async function fill(walletId: string, userId: string, at: string, opts: { fee?: string; feeRole?: string; side?: "BUY" | "SELL" } = {}) {
    const side = opts.side ?? "BUY";
    const order = await seedTestOrder(pool, userId, pairId, side, "MARKET", "0.00100000", undefined, "FILLED");
    const { rows: [trade] } = await pool.query<{ id: string }>(
        `INSERT INTO trades (pair_id, ${side === "BUY" ? "buy_order_id" : "sell_order_id"}, price, qty, quote_amount, fee_amount, executed_at)
         VALUES ($1, $2, '50000', '0.001', '50', $3, $4) RETURNING id`,
        [pairId, order.id, opts.fee ?? "0.15", at],
    );
    const metadata: Record<string, string> = { fee: opts.fee ?? "0.15000000" };
    if (opts.feeRole) metadata.feeRole = opts.feeRole;
    const fee = D(opts.fee ?? "0.15");
    const amount = side === "BUY" ? D(50).plus(fee).neg() : D(50).minus(fee);
    const { rows: [bal] } = await pool.query<{ balance: string }>(
        `UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING balance::text`, [amount.toFixed(8), walletId],
    );
    await pool.query(
        `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_id, reference_type, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, 'TRADE', $6::jsonb, $7)`,
        [walletId, side === "BUY" ? "TRADE_BUY" : "TRADE_SELL", amount.toFixed(8), bal.balance, trade.id, JSON.stringify(metadata), at],
    );
}

async function walletState() {
    const { rows } = await pool.query(`SELECT id, balance::text, reserved::text FROM wallets ORDER BY id`);
    return rows;
}

async function ledgerState() {
    const { rows } = await pool.query(
        `SELECT id, wallet_id, entry_type, amount::text, balance_after::text, metadata FROM ledger_entries ORDER BY id`,
    );
    return rows;
}

async function balance(walletId: string) {
    const { rows } = await pool.query<{ balance: string }>(`SELECT balance::text FROM wallets WHERE id = $1`, [walletId]);
    return rows[0].balance;
}

beforeAll(async () => {
    await ensureMigrations();
});

beforeEach(async () => {
    await resetTestData();
    const fx = await createTestAssetAndPair(pool);
    pairId = fx.pair.id;
    usdAssetId = fx.usdAsset.id;
    // Fixture pair is maker 2 / taker 5; the old engine charged fee_bps.
    await pool.query(`UPDATE trading_pairs SET fee_bps = 30 WHERE id = $1`, [pairId]);
});

describe("planFeeRefund", () => {
    it("refunds fee × (fee_bps − taker) / fee_bps per fill, summed per wallet", async () => {
        const alice = (await createTestUser(pool)).id;
        const w = await wallet(alice);
        await fill(w, alice, BEFORE, { side: "BUY" });                       // 0.15 → 0.125
        await fill(w, alice, "2026-10-10T12:01:00Z", { side: "SELL", fee: "0.03000000" }); // 6 bps → 0.005

        const plan = await planFeeRefund({ before: CUTOFF });
        expect(plan).toHaveLength(1);
        expect(plan[0]).toMatchObject({ wallet_id: w, user_id: alice, total: "0.13000000" });
        expect(plan[0].fills.map((f) => f.overcharge)).toEqual(["0.12500000", "0.00500000"]);
        expect(plan[0].fills[0]).toMatchObject({ charged_bps: "30.00", taker_fee_bps: 5, symbol: "BTC/USD" });
        expect(plan[0].fills[1]).toMatchObject({ charged_bps: "6.00" });
    });

    it("ignores fills at or after the cutoff and post-fix entries (feeRole set)", async () => {
        const alice = (await createTestUser(pool)).id;
        const w = await wallet(alice);
        await fill(w, alice, BEFORE);
        await fill(w, alice, AFTER);                                         // after cutoff
        await fill(w, alice, CUTOFF.toISOString());                          // exactly at cutoff
        await fill(w, alice, BEFORE, { fee: "0.02500000", feeRole: "TAKER" }); // shape of a post-fix entry

        const plan = await planFeeRefund({ before: CUTOFF });
        expect(plan[0].fills).toHaveLength(1);
        expect(plan[0].total).toBe("0.12500000");
    });

    it("skips competition and match wallets, the bots and @system.local users", async () => {
        const alice = (await createTestUser(pool)).id;
        const opponent = (await createTestUser(pool)).id;
        const free = await wallet(alice);
        await fill(free, alice, BEFORE);

        const { rows: [comp] } = await pool.query<{ id: string }>(
            `INSERT INTO competitions (name, start_at, end_at, created_by) VALUES ('c', now(), now() + interval '1 day', $1) RETURNING id`,
            [alice],
        );
        const compWallet = await wallet(alice, { competitionId: comp.id });
        await fill(compWallet, alice, BEFORE);

        const { rows: [match] } = await pool.query<{ id: string }>(
            `INSERT INTO matches (challenger_id, opponent_id, duration_hours, starting_capital, status, started_at, ends_at)
             VALUES ($1, $2, 24, '50000', 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
            [alice, opponent],
        );
        const matchWallet = await wallet(alice, { matchId: match.id });
        await fill(matchWallet, alice, BEFORE);

        for (const id of [config.botUserId, config.riskAgentBotUserId]) {
            await pool.query(
                `INSERT INTO users (id, email, email_normalized, password_hash, role)
                 VALUES ($1, $2, $2, 'x', 'USER') ON CONFLICT (id) DO NOTHING`,
                [id, `bot-${id}@test.local`],
            );
            await fill(await wallet(id), id, BEFORE);
        }
        const sys = (await createTestUser(pool, { email: "ops@system.local" })).id;
        await fill(await wallet(sys), sys, BEFORE);

        const plan = await planFeeRefund({ before: CUTOFF });
        expect(plan.map((w) => w.wallet_id)).toEqual([free]);
    });

    it("--user narrows to one user", async () => {
        const alice = (await createTestUser(pool)).id;
        const bob = (await createTestUser(pool)).id;
        await fill(await wallet(alice), alice, BEFORE);
        const bobs = await wallet(bob);
        await fill(bobs, bob, BEFORE);
        expect((await planFeeRefund({ before: CUTOFF, userId: bob })).map((w) => w.wallet_id)).toEqual([bobs]);
    });
});

describe("applyFeeRefund + revertFeeRefund", () => {
    it("credits one FEE_CORRECTION per wallet; a second run is a no-op", async () => {
        const alice = (await createTestUser(pool)).id;
        const bob = (await createTestUser(pool)).id;
        const wa = await wallet(alice);
        const wb = await wallet(bob);
        await fill(wa, alice, BEFORE);
        await fill(wa, alice, BEFORE);
        await fill(wb, bob, BEFORE);
        const balA = await balance(wa);

        const plan = await planFeeRefund({ before: CUTOFF });
        const applied = await applyFeeRefund(plan.map((w) => w.wallet_id), CUTOFF);
        expect(applied.map((r) => [r.wallet_id, r.amount, r.fills]).sort()).toEqual(
            [[wa, "0.25000000", 2], [wb, "0.12500000", 1]].sort(),
        );
        expect(await balance(wa)).toBe(D(balA).plus("0.25").toFixed(8));

        const { rows } = await pool.query(
            `SELECT amount::text, balance_after::text, metadata FROM ledger_entries WHERE wallet_id = $1 AND entry_type = $2`,
            [wa, FEE_CORRECTION_ENTRY_TYPE],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ amount: "0.25000000", balance_after: await balance(wa) });
        expect(rows[0].metadata).toMatchObject({ fills: 2, before: CUTOFF.toISOString() });

        // Second run: nothing planned, and re-applying the same wallets writes nothing.
        const wallets = await walletState();
        const ledger = await ledgerState();
        expect(await planFeeRefund({ before: CUTOFF })).toEqual([]);
        expect(await applyFeeRefund([wa, wb], CUTOFF)).toEqual([]);
        expect(await walletState()).toEqual(wallets);
        expect(await ledgerState()).toEqual(ledger);
    });

    it("the unique index blocks a second FEE_CORRECTION on a wallet", async () => {
        const alice = (await createTestUser(pool)).id;
        const w = await wallet(alice);
        const insert = () => pool.query(
            `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after) VALUES ($1, 'FEE_CORRECTION', '1', '1')`, [w],
        );
        await insert();
        await expect(insert()).rejects.toThrow(/ledger_fee_correction_once/);
    });

    it("commit then revert restores the exact wallet and ledger state", async () => {
        const alice = (await createTestUser(pool)).id;
        const bob = (await createTestUser(pool)).id;
        const wa = await wallet(alice);
        await fill(wa, alice, BEFORE);
        await fill(await wallet(bob), bob, BEFORE);
        const wallets = await walletState();
        const ledger = await ledgerState();

        const applied = await applyFeeRefund((await planFeeRefund({ before: CUTOFF })).map((w) => w.wallet_id), CUTOFF);
        expect(applied).toHaveLength(2);

        const reverted = await revertFeeRefund(applied.map((r) => r.ledger_id));
        expect(reverted.sort()).toEqual(applied.map((r) => r.ledger_id).sort());
        expect(await walletState()).toEqual(wallets);
        expect(await ledgerState()).toEqual(ledger);

        // Reverting twice changes nothing; the wallets are refundable again.
        expect(await revertFeeRefund(applied.map((r) => r.ledger_id))).toEqual([]);
        expect(await walletState()).toEqual(wallets);
        expect(await planFeeRefund({ before: CUTOFF })).toHaveLength(2);
    });

    it("revert after later activity takes the refund back and fixes later balance_after", async () => {
        const alice = (await createTestUser(pool)).id;
        const w = await wallet(alice);
        await fill(w, alice, BEFORE);
        const balBefore = await balance(w);

        const [applied] = await applyFeeRefund([w], CUTOFF);
        await fill(w, alice, new Date(Date.now() + 1000).toISOString(), { fee: "0.02500000", feeRole: "TAKER" });
        const afterTrade = await balance(w);

        await revertFeeRefund([applied.ledger_id]);
        expect(await balance(w)).toBe(D(afterTrade).minus(applied.amount).toFixed(8));
        // Running balance_after is consistent again: each entry = previous + amount.
        const { rows } = await pool.query<{ amount: string; balance_after: string }>(
            `SELECT amount::text, balance_after::text FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at`, [w],
        );
        let running = D("100000");
        for (const r of rows) {
            running = running.plus(r.amount);
            expect(r.balance_after).toBe(running.toFixed(8));
        }
        expect(D(balBefore).minus("50.025").toFixed(8)).toBe(await balance(w));
    });
});
