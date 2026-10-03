/**
 * restrictPairs.ts — one-time, reversible: set is_active = false on every
 * active trading pair outside MARKET_SYMBOLS (default BTC/ETH/SOL). Deletes
 * nothing. Logic + safety notes in market/restrictPairs.ts.
 *
 * Run AFTER the allowlist code is deployed (so nothing new can be placed on
 * these pairs while this runs). Usage (from apps/api, DATABASE_URL pointing
 * at the target DB):
 *
 *   pnpm pairs:restrict                       # DRY-RUN (default): plan only
 *   pnpm pairs:restrict --commit              # deactivate (skips pairs with open orders/triggers)
 *   pnpm pairs:restrict --commit --cancel-open  # cancel those first, then deactivate all
 *   pnpm pairs:restrict --revert <snapshot.json>  # undo a --commit
 *
 * --commit writes pair-restriction-<timestamp>.json (pair ids + anything it
 * canceled) to the current directory and prints the revert command. Revert
 * re-activates the pairs only — canceled orders/triggers/alerts stay canceled.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { pool } from "../db/pool";
import { planRestriction, applyRestriction, revertPairs } from "../market/restrictPairs";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function revert(file: string): Promise<void> {
    const snap = JSON.parse(readFileSync(file, "utf8")) as { deactivated: { id: string; symbol: string }[] };
    const restored = await revertPairs(snap.deactivated.map((p) => p.id));
    console.log(`Re-activated ${restored.length} of ${snap.deactivated.length} pair(s):`);
    for (const p of restored) console.log(`  ${p.symbol}`);
    console.log(`\nNote: the allowlist code still hides them unless MARKET_SYMBOLS includes them.`);
}

async function main(): Promise<void> {
    const revertFile = arg("revert");
    if (revertFile) return revert(revertFile);

    const commit = process.argv.includes("--commit");
    const cancelOpen = process.argv.includes("--cancel-open");
    const plan = await planRestriction();

    console.log(`\n=== restrictPairs [${commit ? "COMMIT" : "DRY-RUN"}] ===`);
    console.log(`allowlist (MARKET_SYMBOLS): ${plan.allowed.join(", ")}`);
    console.log(`kept active:                ${plan.keep.join(", ") || "(none!)"}`);
    if (plan.missingAllowed.length > 0) {
        console.log(`WARNING — allowlisted but not active: ${plan.missingAllowed.join(", ")}`);
    }
    console.log(`\nto deactivate: ${plan.targets.length} pair(s)`);
    console.log(`  ${"symbol".padEnd(14)}positions  orders  triggers  alerts`);
    for (const t of plan.targets) {
        console.log(
            `  ${t.symbol.padEnd(14)}${String(t.openPositions).padStart(9)}  ${String(t.openOrders).padStart(6)}`
            + `  ${String(t.activeTriggers).padStart(8)}  ${String(t.activeAlerts).padStart(6)}`,
        );
    }
    const blocking = plan.targets.filter((t) => t.openOrders > 0 || t.activeTriggers > 0);
    if (blocking.length > 0) {
        console.log(`\n${blocking.length} pair(s) hold open orders/triggers: ${cancelOpen
            ? "--cancel-open will cancel them (releasing reserved funds) first."
            : "they will be SKIPPED unless you add --cancel-open."}`);
    }
    console.log(`Open positions are left as-is (not deleted, not closed).`);

    if (!commit) {
        console.log(`\nDRY-RUN — nothing written. Re-run with --commit to apply.`);
        return;
    }
    if (plan.targets.length === 0) {
        console.log(`\nNothing to deactivate.`);
        return;
    }

    const result = await applyRestriction(plan.targets, { cancelOpen });
    const file = `pair-restriction-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));

    console.log(`\n=== done ===`);
    console.log(`deactivated: ${result.deactivated.length}  (${result.deactivated.map((p) => p.symbol).join(", ")})`);
    if (result.skipped.length > 0) {
        console.log(`skipped:     ${result.skipped.length}`);
        for (const s of result.skipped) console.log(`  ${s.symbol} — ${s.reason}`);
    }
    if (cancelOpen) {
        console.log(`canceled: ${result.canceledOrderIds.length} order(s), ${result.canceledTriggerIds.length} trigger(s), `
            + `${result.canceledAlertIds.length} alert(s)`);
    }
    console.log(`\nSnapshot: ${file}`);
    console.log(`Undo with: pnpm pairs:restrict --revert ${file}`);
}

main()
    .catch((err) => {
        console.error("restrictPairs failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
