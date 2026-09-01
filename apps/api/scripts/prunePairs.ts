/**
 * prunePairs.ts — one-time deliberate backlog prune: deactivates every
 * currently-active trading pair whose base asset is NOT in the current
 * Kraken ∩ Coinbase ∩ top-MARKET_CAP_RANK_CUTOFF eligible set.
 *
 * Distinct from the symbol-refresh job's ongoing prunePairs() (same name
 * on the market/symbolSync.ts side — imported aliased below to avoid
 * confusion): the job waits MCAP_PRUNE_GRACE_RUNS (3 days) per pair
 * before acting, to smooth out rank-boundary noise on a coin that's
 * freshly in/out. This script has NO grace period — it's meant to run
 * ONCE, deliberately, right after the eligibility gate ships, to clear
 * the ~180-pair backlog that accumulated under the old unbounded
 * volume-ranking gate, BEFORE MCAP_PRUNE_ENABLED is flipped on. After
 * this runs, the job's grace-period prune only ever has to handle the
 * ~0-2 pairs/run steady state of coins crossing the rank-30 boundary.
 *
 * Same two-layer safety gate as the job's prune pass, reusing the exact
 * SAME primitives from symbolSync.ts (not reimplemented here):
 *   - PAIR_HOLDS_NOTHING_LIVE_SQL for the authoritative "is this pair
 *     held" decision (Layer A)
 *   - deactivatePairsGuarded() for the atomic re-check + assertion
 *     (Layer B) — a pair holding a live position / open order / active
 *     trigger is NEVER deactivated by this script, full stop.
 * The three per-reason EXISTS columns in fetchActivePairs() below are
 * informational only (nicer console output); they do not gate anything.
 *
 * PREVIEW FIRST, same pattern as backfillExchangeSymbols.ts. Dry-run is
 * the DEFAULT (this deactivates trading pairs); pass --commit to write.
 *
 *   Dry-run (default):    tsx scripts/prunePairs.ts
 *   Commit:                tsx scripts/prunePairs.ts --commit
 *   Custom cutoff:         tsx scripts/prunePairs.ts --cutoff 40
 *
 * Prod is a manual step: dry-run-preview prod first, review the list,
 * THEN --commit. Only flip MCAP_PRUNE_ENABLED=true after this has run
 * with --commit in each environment.
 */
import "dotenv/config";
import { pool } from "../src/db/pool";
import {
    fetchTopMarketCapSymbols,
    deactivatePairsGuarded,
    PAIR_HOLDS_NOTHING_LIVE_SQL,
    MARKET_CAP_RANK_CUTOFF,
} from "../src/market/symbolSync";

function parseCutoff(): number {
    const idx = process.argv.indexOf("--cutoff");
    if (idx === -1) return MARKET_CAP_RANK_CUTOFF;
    const val = Number(process.argv[idx + 1]);
    return Number.isFinite(val) && val > 0 ? val : MARKET_CAP_RANK_CUTOFF;
}

interface ActivePairRow {
    id: string;
    symbol: string;
    base_symbol: string;
    is_held: boolean;            // authoritative — same predicate as the job's gate
    holds_position: boolean;     // informational, for the printed reason
    holds_open_order: boolean;   // informational
    holds_active_trigger: boolean; // informational
}

async function fetchActivePairs(): Promise<ActivePairRow[]> {
    const { rows } = await pool.query<ActivePairRow>(
        `SELECT tp.id, tp.symbol, a.symbol AS base_symbol,
                NOT (${PAIR_HOLDS_NOTHING_LIVE_SQL}) AS is_held,
                EXISTS (SELECT 1 FROM positions p WHERE p.pair_id = tp.id AND p.base_qty <> 0) AS holds_position,
                EXISTS (SELECT 1 FROM orders o WHERE o.pair_id = tp.id AND o.status IN ('OPEN', 'PARTIALLY_FILLED')) AS holds_open_order,
                EXISTS (SELECT 1 FROM trigger_orders t WHERE t.pair_id = tp.id AND t.status = 'ACTIVE') AS holds_active_trigger
           FROM trading_pairs tp
           JOIN assets a ON a.id = tp.base_asset_id
          WHERE tp.is_active = true
          ORDER BY tp.symbol`,
    );
    return rows;
}

function heldReasons(p: ActivePairRow): string {
    return [
        p.holds_position && "open position",
        p.holds_open_order && "open order",
        p.holds_active_trigger && "active trigger",
    ].filter(Boolean).join(", ");
}

async function main() {
    const commit = process.argv.includes("--commit");
    const mode = commit ? "COMMIT" : "DRY-RUN";
    const cutoff = parseCutoff();

    console.log(`\n=== prunePairs [${mode}] (eligible = Kraken ∩ Coinbase ∩ top ${cutoff} by market cap) ===`);
    console.log(`Fetching the current top-${cutoff} market-cap set from CoinGecko...`);
    const mcapRank = await fetchTopMarketCapSymbols(cutoff);
    const eligible = new Set(mcapRank.keys());

    console.log(`Fetching all currently-active trading pairs...`);
    const activePairs = await fetchActivePairs();

    const keep = activePairs.filter((p) => eligible.has(p.base_symbol));
    const outsideTop = activePairs.filter((p) => !eligible.has(p.base_symbol));
    const held = outsideTop.filter((p) => p.is_held);
    const nominees = outsideTop.filter((p) => !p.is_held);

    console.log(`\nactive pairs total:            ${activePairs.length}`);
    console.log(`  in top ${cutoff} (kept):            ${keep.length}`);
    console.log(`  outside top ${cutoff}:              ${outsideTop.length}`);
    console.log(`    held — NEVER touched:      ${held.length}`);
    console.log(`    eligible for deactivation: ${nominees.length}\n`);

    if (held.length > 0) {
        console.log(`Held pairs outside the top ${cutoff} — this script will NEVER deactivate these:`);
        for (const p of held) console.log(`  ${p.symbol.padEnd(12)} (${heldReasons(p)})`);
        console.log();
    }

    console.log(nominees.length > 0 ? `Pairs that WOULD be deactivated:` : `No pairs to deactivate.`);
    for (const p of nominees) console.log(`  ${p.symbol}`);

    if (!commit) {
        console.log(`\nDRY-RUN — no writes. Re-run with --commit to apply the above.`);
        return;
    }

    if (nominees.length === 0) {
        console.log(`\nNothing to deactivate.`);
        return;
    }

    console.log(`\nDeactivating ${nominees.length} pair(s)...`);
    const client = await pool.connect();
    let deactivatedIds: string[];
    try {
        await client.query("BEGIN");
        // Layer B — atomic re-check + assertion. Should always match
        // `nominees` exactly (Layer A above already excluded held pairs
        // via the same predicate); a mismatch here means something
        // changed between the SELECT above and now, or a bug — it
        // throws and rolls back rather than half-applying.
        deactivatedIds = await deactivatePairsGuarded(client, nominees.map((p) => p.id));
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }

    console.log(`\n=== summary ===`);
    console.log(`pairs deactivated:        ${deactivatedIds.length}`);
    console.log(`pairs kept (in top ${cutoff}):   ${keep.length}`);
    console.log(`pairs skipped (held):     ${held.length}`);
    console.log(`\nNext step: once satisfied, set MCAP_PRUNE_ENABLED=true so the symbol-refresh`);
    console.log(`job maintains steady state (grace-period prune of future rank-boundary crossers).`);
}

main()
    .catch((err) => {
        console.error("prunePairs failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
