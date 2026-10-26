/**
 * convertToIsolated.ts — leverage PR 5, one-time: every open SPOT position
 * of a real user (free-play + competitions) becomes a 1x ISOLATED position
 * at its entry, with equity unchanged. Logic and safety notes in
 * trading/leverageConversion.ts; runbook in docs/runbooks/leverage-convert.md.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm leverage:convert                      # DRY RUN (default): the plan, nothing written
 *   pnpm leverage:convert --user <uuid>        # dry run for one user
 *   pnpm leverage:convert --apply [--user <uuid>]   # convert, one transaction per user
 *
 * --apply also writes leverage-convert-<timestamp>.json (every user's
 * outcome and plan) to the current directory. Safe to re-run: only what is
 * still SPOT is converted. Exit code 1 if any user failed.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { pool } from "../db/pool";
import { initRedis, shutdownRedis } from "../db/redis";
import { formatRun, parseConvertArgs, runConversion } from "../trading/leverageConversion";

async function main(): Promise<void> {
    const args = parseConvertArgs(process.argv.slice(2));
    // With REDIS_URL set, wallet/order events reach the running API's SSE
    // clients (a standalone script has no Redis unless it connects itself).
    await initRedis();

    const run = await runConversion(args);
    console.log(formatRun(run));

    if (args.apply) {
        const file = `leverage-convert-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
        writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), userFilter: args.userId ?? null, ...run }, null, 2));
        console.log(`\nReport: ${file}`);
    }
    if (run.counts.failed > 0) process.exitCode = 1;
}

main()
    .catch((err) => {
        console.error("leverage:convert failed:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await shutdownRedis();
        await pool.end();
    });
