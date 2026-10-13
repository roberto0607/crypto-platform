/**
 * matchesLegacyReport.ts — READ-ONLY: what each ended match left in its
 * players' free-play wallets before per-match wallets (migration 095).
 * Logic in competitions/matchLegacyReport.ts. It writes nothing.
 *
 * Usage (from apps/api, DATABASE_URL pointing at the target DB):
 *
 *   pnpm matches:legacy-report                 # every ended match
 *   pnpm matches:legacy-report --match <uuid>  # one match
 *   pnpm matches:legacy-report --json          # machine-readable
 */
import "dotenv/config";
import { pool } from "../db/pool";
import { legacyFootprintRows, summarizeFootprint, footprintTotal } from "../competitions/matchLegacyReport";

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
    const matchId = arg("match") ?? null;
    if (matchId && !/^[0-9a-f-]{36}$/i.test(matchId)) throw new Error(`--match: not a uuid: ${matchId}`);

    // Read-only by construction: one READ ONLY transaction.
    const client = await pool.connect();
    try {
        await client.query("BEGIN READ ONLY");
        const footprints = summarizeFootprint(await legacyFootprintRows(client, matchId));
        await client.query("COMMIT");

        if (process.argv.includes("--json")) {
            console.log(JSON.stringify({ footprints, total_value_usd: footprintTotal(footprints) }, null, 2));
            return;
        }

        console.log(`Legacy match footprint in free-play wallets (read-only)${matchId ? ` — match ${matchId}` : ""}`);
        console.log(`Net ledger movement on each player's FREE-PLAY wallets from trades of their own match orders.`);
        console.log(`Positive = the match left value in free-play; negative = it took value out. Valued at today's last_price.\n`);
        if (footprints.length === 0) {
            console.log("No ended match left anything in free-play.");
            return;
        }
        let lastMatch = "";
        for (const f of footprints) {
            if (f.match_id !== lastMatch) {
                console.log(`match ${f.match_id}  ${f.status}  ended ${f.completed_at ?? "?"}`);
                lastMatch = f.match_id;
            }
            const assets = f.assets.map((a) => `${a.asset} ${a.net}${a.asset !== "USD" && a.value_usd !== null ? ` (≈$${Number(a.value_usd).toFixed(2)})` : ""}`).join(", ");
            console.log(`  ${f.email.padEnd(32)} ${assets}  →  ≈$${Number(f.total_value_usd).toFixed(2)}${f.unpriced_assets.length ? `  (unpriced: ${f.unpriced_assets.join(", ")})` : ""}`);
        }
        const users = new Set(footprints.map((f) => f.user_id)).size;
        const matches = new Set(footprints.map((f) => f.match_id)).size;
        console.log(`\n${matches} match(es), ${users} player(s); total ≈$${Number(footprintTotal(footprints)).toFixed(2)} at today's prices. Nothing was changed.`);
    } finally {
        client.release();
    }
}

main()
    .then(() => pool.end())
    .catch(async (err) => {
        console.error(err instanceof Error ? err.message : err);
        await pool.end().catch(() => {});
        process.exit(1);
    });
