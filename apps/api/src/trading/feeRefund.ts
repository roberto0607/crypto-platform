/**
 * feeRefund.ts — one-time refund of the taker fee overcharge from before
 * PR #201. Driven by src/scripts/refundFeeOvercharge.ts; runbook in
 * docs/runbooks/refund-fee-overcharge.md.
 *
 * Before #201 the matching engine charged the deprecated trading_pairs.fee_bps
 * (30) on every taker fill instead of taker_fee_bps (5). Those fills are easy
 * to find: the taker's quote-wallet TRADE_BUY / TRADE_SELL entry carries
 * metadata.fee but no metadata.feeRole (#201 added feeRole to every fee it
 * writes; pre-fix maker entries carried no fee at all).
 *
 *   overcharge per fill = fee × (fee_bps − taker_fee_bps) / fee_bps
 *                       = fee − quote_amount × taker_fee_bps / 10000
 *
 * fee_bps here is the rate that fill was actually charged (fee / the trade's
 * quote_amount), not today's trading_pairs.fee_bps: the column can have been
 * edited since the fill, and the effective rate is exact either way.
 *
 * Scope and safety:
 * - free-play wallets only (competition_id IS NULL AND match_id IS NULL)
 * - never the market-maker / risk-agent bots or any @system.local user
 * - only entries strictly before the `before` cutoff (PR #201's deploy time),
 *   on top of the no-feeRole test, so a post-fix fill can never be refunded
 * - one FEE_CORRECTION credit per wallet; a wallet that already has one is
 *   skipped, and the ledger_fee_correction_once index (migration 093) makes a
 *   second credit impossible even if two runs overlap
 * - apply re-plans inside its transaction with the wallets locked, so the
 *   amount written is what the ledger says at commit time
 * - revert removes exactly the snapshot's FEE_CORRECTION rows, takes the
 *   amount back off the balance, and shifts balance_after on any later entry
 *   of that wallet, leaving the ledger as if the refund never happened
 */
import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { config } from "../config";
import { D } from "../utils/decimal";

export const FEE_CORRECTION_ENTRY_TYPE = "FEE_CORRECTION";
export const FEE_CORRECTION_REASON = "taker_fee_overcharge_pre_pr201";

export interface OverchargedFill {
    ledger_id: string;
    wallet_id: string;
    user_id: string;
    email: string;
    symbol: string;
    entry_type: string;
    created_at: string;
    quote_amount: string;
    fee: string;
    /** Rate this fill was actually charged, in bps (fee / quote_amount). */
    charged_bps: string;
    taker_fee_bps: number;
    overcharge: string;
}

export interface WalletRefund {
    wallet_id: string;
    user_id: string;
    email: string;
    fills: OverchargedFill[];
    /** Sum of the per-fill overcharges, 8 dp. */
    total: string;
}

export interface AppliedRefund {
    ledger_id: string;
    wallet_id: string;
    user_id: string;
    email: string;
    amount: string;
    fills: number;
}

export interface PlanOptions {
    /** Cutoff: only ledger entries created strictly before this instant. */
    before: Date;
    userId?: string;
    /** Restrict to these wallets (used by apply's in-transaction re-plan). */
    walletIds?: string[];
}

function excludedUserIds(): string[] {
    return [config.botUserId, config.riskAgentBotUserId];
}

async function queryFills(db: PoolClient | typeof pool, opts: PlanOptions): Promise<OverchargedFill[]> {
    const { rows } = await db.query<OverchargedFill>(
        `SELECT le.id AS ledger_id, le.wallet_id, w.user_id, u.email, tp.symbol, le.entry_type,
                to_char(le.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                t.quote_amount::text, ((le.metadata->>'fee')::numeric)::text AS fee,
                round((le.metadata->>'fee')::numeric * 10000 / t.quote_amount, 2)::text AS charged_bps,
                tp.taker_fee_bps,
                round((le.metadata->>'fee')::numeric - t.quote_amount * tp.taker_fee_bps / 10000, 8)::text AS overcharge
           FROM ledger_entries le
           JOIN wallets w        ON w.id = le.wallet_id
           JOIN users u          ON u.id = w.user_id
           JOIN trades t         ON t.id = le.reference_id
           JOIN trading_pairs tp ON tp.id = t.pair_id
          WHERE le.entry_type IN ('TRADE_BUY', 'TRADE_SELL')
            AND le.reference_type = 'TRADE'
            AND le.metadata ? 'fee'
            AND NOT le.metadata ? 'feeRole'
            AND (le.metadata->>'fee')::numeric > 0
            AND le.created_at < $1
            AND w.competition_id IS NULL
            AND w.match_id IS NULL
            AND w.user_id <> ALL($2::uuid[])
            AND u.email_normalized NOT LIKE '%@system.local'
            AND round((le.metadata->>'fee')::numeric - t.quote_amount * tp.taker_fee_bps / 10000, 8) > 0
            AND NOT EXISTS (
                SELECT 1 FROM ledger_entries c
                 WHERE c.wallet_id = le.wallet_id AND c.entry_type = '${FEE_CORRECTION_ENTRY_TYPE}'
            )
            AND ($3::uuid IS NULL OR w.user_id = $3)
            AND ($4::uuid[] IS NULL OR le.wallet_id = ANY($4::uuid[]))
          ORDER BY u.email, le.wallet_id, le.created_at, le.id`,
        [opts.before.toISOString(), excludedUserIds(), opts.userId ?? null, opts.walletIds ?? null],
    );
    return rows;
}

function groupByWallet(fills: OverchargedFill[]): WalletRefund[] {
    const byWallet = new Map<string, WalletRefund>();
    for (const f of fills) {
        let w = byWallet.get(f.wallet_id);
        if (!w) {
            w = { wallet_id: f.wallet_id, user_id: f.user_id, email: f.email, fills: [], total: "0" };
            byWallet.set(f.wallet_id, w);
        }
        w.fills.push(f);
        w.total = D(w.total).plus(D(f.overcharge)).toFixed(8);
    }
    return [...byWallet.values()].filter((w) => D(w.total).gt(0));
}

/**
 * When the first post-fix fee entry (one carrying feeRole) was written — i.e.
 * roughly when PR #201 went live. A sanity anchor for the --before cutoff.
 */
export async function firstPostFixFeeAt(): Promise<string | null> {
    const { rows } = await pool.query<{ at: string | null }>(
        `SELECT to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
           FROM ledger_entries WHERE metadata ? 'feeRole'`,
    );
    return rows[0].at;
}

/** Read-only: every wallet owed a refund, with its fills. Writes nothing. */
export async function planFeeRefund(opts: PlanOptions): Promise<WalletRefund[]> {
    return groupByWallet(await queryFills(pool, opts));
}

/**
 * Credit one FEE_CORRECTION per wallet in `walletIds`, in a single
 * transaction. Amounts are recomputed under lock, so a wallet refunded by a
 * concurrent run (or that no longer qualifies) is skipped.
 */
export async function applyFeeRefund(walletIds: string[], before: Date): Promise<AppliedRefund[]> {
    if (walletIds.length === 0) return [];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM wallets WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [walletIds]);
        const plan = groupByWallet(await queryFills(client, { before, walletIds }));

        const applied: AppliedRefund[] = [];
        for (const w of plan) {
            const { rows: [bal] } = await client.query<{ balance: string }>(
                `UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING balance::text`,
                [w.total, w.wallet_id],
            );
            const { rows: [entry] } = await client.query<{ id: string }>(
                `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, reference_type, metadata)
                 VALUES ($1, $2, $3, $4, 'FEE_CORRECTION', $5::jsonb)
                 RETURNING id`,
                [
                    w.wallet_id, FEE_CORRECTION_ENTRY_TYPE, w.total, bal.balance,
                    JSON.stringify({
                        reason: FEE_CORRECTION_REASON,
                        before: before.toISOString(),
                        fills: w.fills.length,
                        ledgerIds: w.fills.map((f) => f.ledger_id),
                    }),
                ],
            );
            applied.push({
                ledger_id: entry.id, wallet_id: w.wallet_id, user_id: w.user_id,
                email: w.email, amount: w.total, fills: w.fills.length,
            });
        }
        await client.query("COMMIT");
        return applied;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Undo an apply: delete the given FEE_CORRECTION entries (only if they are
 * still FEE_CORRECTION rows), debit their amount back and shift balance_after
 * on later entries of the same wallet. One transaction. Returns the ledger ids
 * actually reverted.
 */
export async function revertFeeRefund(ledgerIds: string[]): Promise<string[]> {
    if (ledgerIds.length === 0) return [];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const reverted: string[] = [];
        for (const id of ledgerIds) {
            // One statement, so created_at is compared at full microsecond precision.
            const { rowCount } = await client.query(
                `WITH gone AS (
                     DELETE FROM ledger_entries WHERE id = $1 AND entry_type = $2
                     RETURNING wallet_id, amount, created_at
                 ), wallet AS (
                     UPDATE wallets w SET balance = w.balance - gone.amount
                       FROM gone WHERE w.id = gone.wallet_id
                 ), later AS (
                     UPDATE ledger_entries le SET balance_after = le.balance_after - gone.amount
                       FROM gone WHERE le.wallet_id = gone.wallet_id AND le.created_at > gone.created_at
                 )
                 SELECT 1 FROM gone`,
                [id, FEE_CORRECTION_ENTRY_TYPE],
            );
            if (rowCount) reverted.push(id);
        }
        await client.query("COMMIT");
        return reverted;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}
