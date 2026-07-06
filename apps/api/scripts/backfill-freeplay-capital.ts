/**
 * backfill-freeplay-capital.ts — one-off backfill of free-play starting capital
 * for users created BEFORE PR #97 (signup funding).
 *
 * PR #97 funds a new user's free-play (competition_id IS NULL) USD wallet with
 * $100K at signup via a FREE_PLAY_CREDIT ledger entry, idempotent behind a
 * check-then-insert + partial unique index (ledger_free_play_credit_once,
 * migration 070). Users who registered before #97 still sit at $0 and were
 * never granted. This backfills them by REUSING the exact signup grant —
 * autoCreateWallets(userId, null) — so behavior is identical to a fresh signup:
 * no parallel crediting path.
 *
 * Selection (the correct "was this ever granted?" signal):
 *   users with NO FREE_PLAY_CREDIT ledger entry on any free-play USD wallet.
 *   NOT `balance = 0` — a user could legitimately have traded down to ~0 after
 *   being funded; the ledger entry is what #97's idempotency guard checks.
 *   This selection also catches very old accounts that have no free-play USD
 *   wallet at all — autoCreateWallets creates the wallet, then funds it.
 *
 * Scope: identical to #97 — only the free-play USD wallet is credited. Asset
 * wallets and every competition-scoped wallet are untouched; ranked capital
 * stays governed solely by joinCompetition → COMPETITION_CREDIT.
 *
 * Idempotent overall: safe to run repeatedly. A second run selects nobody new
 * (everyone now has a FREE_PLAY_CREDIT entry); the unique index is the hard
 * backstop against any double-credit even under a concurrent retry.
 *
 * Ergonomics — PREVIEW FIRST. Dry-run is the DEFAULT (this writes money to
 * every existing account); pass --commit to actually fund.
 *
 *   Dry-run (default):  tsx scripts/backfill-freeplay-capital.ts
 *   Commit:             tsx scripts/backfill-freeplay-capital.ts --commit
 *
 * Prod is a manual step (like migration 070): run against the prod DATABASE_URL
 * only AFTER 070 has been applied there, and dry-run-preview prod first.
 */
import "dotenv/config";
import { pool } from "../src/db/pool";
import { autoCreateWallets } from "../src/wallets/autoWallets";
import { STARTING_CAPITAL_USD } from "../src/wallets/startingCapital";

type UnfundedUser = { id: string; email: string; has_usd_wallet: boolean };

/** Users missing a FREE_PLAY_CREDIT on any free-play USD wallet (i.e. never granted). */
async function findUnfundedUsers(): Promise<UnfundedUser[]> {
    const { rows } = await pool.query<UnfundedUser>(
        `SELECT u.id,
                u.email,
                EXISTS (
                    SELECT 1 FROM wallets w
                    JOIN assets a ON a.id = w.asset_id
                    WHERE w.user_id = u.id AND w.competition_id IS NULL AND a.symbol = 'USD'
                ) AS has_usd_wallet
         FROM users u
         WHERE NOT EXISTS (
             SELECT 1 FROM ledger_entries le
             JOIN wallets w ON w.id = le.wallet_id
             WHERE w.user_id = u.id
               AND w.competition_id IS NULL
               AND le.entry_type = 'FREE_PLAY_CREDIT'
         )
         ORDER BY u.created_at ASC`,
    );
    return rows;
}

/** True once the user has a FREE_PLAY_CREDIT on a free-play USD wallet. */
async function isFunded(userId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `SELECT 1 FROM ledger_entries le
         JOIN wallets w ON w.id = le.wallet_id
         WHERE w.user_id = $1 AND w.competition_id IS NULL AND le.entry_type = 'FREE_PLAY_CREDIT'
         LIMIT 1`,
        [userId],
    );
    return (rowCount ?? 0) > 0;
}

async function main() {
    const commit = process.argv.includes("--commit");
    const mode = commit ? "COMMIT" : "DRY-RUN";

    const { rows: totalRows } = await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM users");
    const totalUsers = Number(totalRows[0].n);

    const unfunded = await findUnfundedUsers();

    console.log(`\n=== backfill-freeplay-capital [${mode}] ===`);
    console.log(`grant amount:      ${STARTING_CAPITAL_USD} USD (free-play USD wallet only)`);
    console.log(`total users:       ${totalUsers}`);
    console.log(`already funded:    ${totalUsers - unfunded.length}`);
    console.log(`unfunded (target): ${unfunded.length}`);

    if (unfunded.length === 0) {
        console.log(`\nNothing to do — every user already has a FREE_PLAY_CREDIT grant.`);
        return;
    }

    console.log(`\nWould fund:`);
    for (const u of unfunded) {
        const note = u.has_usd_wallet ? "" : "  (no free-play USD wallet yet — will be created)";
        console.log(`  - ${u.email}  [${u.id}]${note}`);
    }

    if (!commit) {
        console.log(`\nDRY-RUN — no writes. Re-run with --commit to fund the ${unfunded.length} user(s) above.`);
        return;
    }

    console.log(`\nFunding ${unfunded.length} user(s)…`);
    let funded = 0;
    let skippedNoUsd = 0;
    const errors: Array<{ id: string; email: string; err: string }> = [];

    for (const u of unfunded) {
        try {
            // Exact signup grant: creates any missing free-play wallets (ON CONFLICT
            // DO NOTHING) and funds the USD wallet iff not already funded.
            await autoCreateWallets(u.id, null);
            if (await isFunded(u.id)) {
                funded++;
            } else {
                // Only reachable if the user has no free-play USD wallet AND the USD
                // asset is inactive so none could be created — not expected in prod.
                skippedNoUsd++;
                console.warn(`  SKIP (no USD wallet fundable): ${u.email} [${u.id}]`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ id: u.id, email: u.email, err: msg });
            console.error(`  ERROR funding ${u.email} [${u.id}]: ${msg}`);
        }
    }

    console.log(`\n=== summary ===`);
    console.log(`scanned (unfunded): ${unfunded.length}`);
    console.log(`funded:             ${funded}`);
    console.log(`skipped (no USD):   ${skippedNoUsd}`);
    console.log(`errors:             ${errors.length}`);
    if (errors.length > 0) {
        console.log(`error detail:`);
        for (const e of errors) console.log(`  - ${e.email} [${e.id}]: ${e.err}`);
        process.exitCode = 1;
    }
}

main()
    .catch((err) => {
        console.error("backfill-freeplay-capital failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
