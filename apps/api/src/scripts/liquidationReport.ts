/**
 * liquidationReport.ts — leverage PR 7, READ-ONLY: the liquidations the
 * engine did not execute (LOG_ONLY, SKIPPED_STALE), with the mark, the liq
 * price and what LIQUIDATION_MODE=execute would have booked. Logic in
 * trading/liqReport.ts; runbook in docs/runbooks/leverage-liquidation-execute.md.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm leverage:liq-report                          # every LOG_ONLY / SKIPPED_STALE row
 *   pnpm leverage:liq-report --since 2026-10-26       # rows created since then
 *   pnpm leverage:liq-report --user <uuid>            # one user
 *   pnpm leverage:liq-report --mode SKIPPED_STALE     # one mode
 *   pnpm leverage:liq-report --json                   # machine-readable
 *
 * One READ ONLY transaction: it writes nothing. Exit code 1 if any row is
 * inconsistent (its mark doesn't breach its liq price).
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { buildLiqReport, formatLiqReport, parseLiqReportArgs } from "../trading/liqReport";

async function main(): Promise<void> {
    const args = parseLiqReportArgs(process.argv.slice(2));
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        const report = await buildLiqReport(client, args);
        await client.query("COMMIT");
        console.log(args.json ? JSON.stringify(report, null, 2) : formatLiqReport(report, args));
        if (report.counts.inconsistent > 0) process.exitCode = 1;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

main()
    .catch((err) => {
        console.error("leverage:liq-report failed:", err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
