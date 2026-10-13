/**
 * refundFeeOvercharge.ts — one-time, reversible: refund the taker fee
 * overcharge (fee_bps, 30, charged instead of taker_fee_bps, 5) on free-play
 * fills from before PR #201. Logic + safety notes in trading/feeRefund.ts;
 * runbook in docs/runbooks/refund-fee-overcharge.md.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm fees:refund-overcharge --before <ISO>                  # DRY-RUN (default): list only
 *   pnpm fees:refund-overcharge --before <ISO> --user <uuid>    # dry run for one user
 *   pnpm fees:refund-overcharge --before <ISO> --commit [--user <uuid>]  # credit the refunds
 *   pnpm fees:refund-overcharge --revert <snapshot.json>        # undo a --commit
 *
 * --before is required: PR #201's deploy time. Only ledger entries created
 * strictly before it are considered.
 *
 * --commit writes fee-refund-<timestamp>.json (every FEE_CORRECTION entry it
 * wrote) to the current directory and prints the revert command.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/pool";
import { D } from "../utils/decimal";
import { planFeeRefund, firstPostFixFeeAt, applyFeeRefund, revertFeeRefund, type AppliedRefund, type WalletRefund } from "../trading/feeRefund";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseBefore(raw: string | undefined): Date {
    // Require an explicit date + time + zone so a bare date can't silently mean local midnight.
    if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
        throw new Error(`--before <ISO timestamp with zone> is required, e.g. --before 2026-10-11T18:05:00Z (PR #201's deploy time)`);
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`--before: not a valid timestamp: ${raw}`);
    if (d.getTime() > Date.now()) throw new Error(`--before is in the future: ${raw}`);
    return d;
}

function printPlan(plan: WalletRefund[]): void {
    for (const w of plan) {
        console.log(`\n  ${w.email}  (user ${w.user_id}, wallet ${w.wallet_id})`);
        console.log(`    ${"time (UTC)".padEnd(22)}${"pair".padEnd(10)}${"entry".padEnd(12)}${"quote".padStart(14)}${"fee".padStart(14)}  ${"bps paid→taker".padEnd(15)}${"overcharge".padStart(14)}`);
        for (const f of w.fills) {
            console.log(
                `    ${f.created_at.padEnd(22)}${f.symbol.padEnd(10)}${f.entry_type.padEnd(12)}${Number(f.quote_amount).toFixed(2).padStart(14)}${f.fee.padStart(14)}  `
                + `${`${f.charged_bps}→${f.taker_fee_bps}`.padEnd(15)}${f.overcharge.padStart(14)}`,
            );
        }
        console.log(`    ${"refund".padEnd(87)}${w.total.padStart(14)}`);
    }
}

async function revert(file: string): Promise<void> {
    const snap = JSON.parse(readFileSync(file, "utf8")) as { refunds: AppliedRefund[] };
    const reverted = await revertFeeRefund(snap.refunds.map((r) => r.ledger_id));
    const total = snap.refunds
        .filter((r) => reverted.includes(r.ledger_id))
        .reduce((s, r) => s.plus(D(r.amount)), D(0));
    console.log(`Reverted ${reverted.length} of ${snap.refunds.length} FEE_CORRECTION entr(ies), ${total.toFixed(8)} USD taken back.`);
    if (reverted.length < snap.refunds.length) {
        console.log(`The rest were no longer in the ledger (already reverted?) and were left alone.`);
    }
}

async function main(): Promise<void> {
    const revertFile = arg("revert");
    if (revertFile) return revert(revertFile);

    const before = parseBefore(arg("before"));
    const commit = process.argv.includes("--commit");
    const userId = arg("user");
    const plan = await planFeeRefund({ before, userId });

    console.log(`\n=== refundFeeOvercharge [${commit ? "COMMIT" : "DRY-RUN"}]${userId ? ` user=${userId}` : ""} ===`);
    console.log(`cutoff (--before): ${before.toISOString()}`);
    const firstFixed = await firstPostFixFeeAt();
    console.log(`first post-fix fee entry (has feeRole): ${firstFixed ?? "none yet"}`);
    if (firstFixed && before.getTime() > new Date(firstFixed).getTime()) {
        console.log(`  note: the cutoff is after the first post-fix fill. Still safe — entries with feeRole are never refunded — but check --before is the deploy time.`);
    }
    console.log(`scope: free-play wallets only; bots/@system.local users and wallets already refunded are skipped`);

    const fills = plan.reduce((n, w) => n + w.fills.length, 0);
    const total = plan.reduce((s, w) => s.plus(D(w.total)), D(0));
    console.log(`wallets: ${plan.length}   users: ${new Set(plan.map((w) => w.user_id)).size}   fills: ${fills}   total: ${total.toFixed(8)} USD`);
    if (plan.length === 0) {
        console.log(`Nothing to do.`);
        return;
    }
    printPlan(plan);

    if (!commit) {
        console.log(`\nDRY-RUN — nothing written. Re-run with --commit to credit these.`);
        return;
    }

    const applied = await applyFeeRefund(plan.map((w) => w.wallet_id), before);
    const file = `fee-refund-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), before: before.toISOString(), userFilter: userId ?? null, refunds: applied }, null, 2));

    const appliedTotal = applied.reduce((s, r) => s.plus(D(r.amount)), D(0));
    console.log(`\n=== done ===`);
    console.log(`credited: ${applied.length} of ${plan.length} wallet(s), ${appliedTotal.toFixed(8)} USD`);
    if (applied.length < plan.length) {
        console.log(`(${plan.length - applied.length} no longer qualified at commit time — e.g. refunded by another run — and were skipped)`);
    }
    console.log(`\nSnapshot: ${file}`);
    console.log(`Undo with: pnpm fees:refund-overcharge --revert ${file}`);
}

main()
    .catch((err) => {
        console.error("refundFeeOvercharge failed:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
