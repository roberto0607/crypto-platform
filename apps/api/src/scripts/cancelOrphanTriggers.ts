/**
 * cancelOrphanTriggers.ts — one-time, reversible: cancel ACTIVE triggers whose
 * position is gone (left behind before the position-close fix). Deletes
 * nothing. Logic + safety notes in triggers/cancelOrphans.ts; runbook in
 * docs/runbooks/cancel-orphan-triggers.md.
 *
 * Run AFTER the fix is deployed (so no new orphans appear behind it). Usage
 * (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm triggers:cancel-orphans                         # DRY-RUN (default): list only
 *   pnpm triggers:cancel-orphans --user <uuid>           # dry run for one user
 *   pnpm triggers:cancel-orphans --commit [--user <uuid>]  # cancel them
 *   pnpm triggers:cancel-orphans --revert <snapshot.json>  # undo a --commit
 *
 * --commit writes orphan-triggers-<timestamp>.json (every canceled row, in
 * full) to the current directory and prints the revert command.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/pool";
import {
    planOrphanCleanup,
    applyOrphanCleanup,
    revertOrphanCleanup,
    distancePct,
    type OrphanTrigger,
} from "../triggers/cancelOrphans";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function printTable(rows: OrphanTrigger[]): void {
    console.log(`  ${"pair".padEnd(10)}${"user".padEnd(30)}${"kind".padEnd(22)}side  ${"trigger".padStart(14)}  ${"qty".padStart(12)}  ${"vs last".padStart(8)}  oco  created`);
    for (const o of rows) {
        const d = distancePct(o);
        console.log(
            `  ${o.symbol.padEnd(10)}${(o.email ?? o.user_id).slice(0, 29).padEnd(30)}${o.kind.padEnd(22)}${o.side.padEnd(4)}  `
            + `${Number(o.trigger_price).toFixed(2).padStart(14)}  ${o.qty.padStart(12)}  `
            + `${(d === null ? "?" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`).padStart(8)}  ${o.oco_group_id ? "yes" : " - "}  ${o.created_at.slice(0, 16)}`,
        );
    }
}

async function revert(file: string): Promise<void> {
    const snap = JSON.parse(readFileSync(file, "utf8")) as { canceled: OrphanTrigger[] };
    const restored = await revertOrphanCleanup(snap.canceled.map((t) => t.id));
    console.log(`Re-activated ${restored.length} of ${snap.canceled.length} trigger(s).`);
    if (restored.length < snap.canceled.length) {
        console.log(`The rest were changed since the commit (no longer CANCELED by this cleanup) and were left alone.`);
    }
    console.log(`Note: triggers are reduce-only at fire time — a re-activated one with no position cancels itself (no_position).`);
}

async function main(): Promise<void> {
    const revertFile = arg("revert");
    if (revertFile) return revert(revertFile);

    const commit = process.argv.includes("--commit");
    const userId = arg("user");
    const plan = await planOrphanCleanup({ userId });

    console.log(`\n=== cancelOrphanTriggers [${commit ? "COMMIT" : "DRY-RUN"}]${userId ? ` user=${userId}` : ""} ===`);
    console.log(`orphaned ACTIVE triggers (no position on that side, in any scope): ${plan.length}`);
    if (plan.length === 0) {
        console.log(`Nothing to do.`);
        return;
    }

    const byPair = new Map<string, number>();
    for (const o of plan) byPair.set(o.symbol, (byPair.get(o.symbol) ?? 0) + 1);
    console.log(`by pair: ${[...byPair].map(([s, n]) => `${s}=${n}`).join("  ")}`);
    console.log(`users:   ${new Set(plan.map((o) => o.user_id)).size}\n`);
    printTable(plan);

    if (!commit) {
        console.log(`\nDRY-RUN — nothing written. Re-run with --commit to cancel these.`);
        return;
    }

    const canceled = await applyOrphanCleanup(plan.map((o) => o.id));
    const file = `orphan-triggers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), userFilter: userId ?? null, canceled }, null, 2));

    console.log(`\n=== done ===`);
    console.log(`canceled: ${canceled.length} of ${plan.length}`);
    if (canceled.length < plan.length) {
        console.log(`(${plan.length - canceled.length} stopped being orphans between plan and commit and were left ACTIVE)`);
    }
    console.log(`\nSnapshot: ${file}`);
    console.log(`Undo with: pnpm triggers:cancel-orphans --revert ${file}`);
}

main()
    .catch((err) => {
        console.error("cancelOrphanTriggers failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
