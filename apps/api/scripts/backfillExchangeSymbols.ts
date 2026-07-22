/**
 * backfillExchangeSymbols.ts — one-time backfill of the curated Kraken ∩
 * Coinbase USD-pair universe into trading_pairs/assets/exchange_symbol_map,
 * expanding TRADR from 3 hardcoded pairs (BTC/ETH/SOL) to the top ~50-75
 * pairs by Coinbase 24h USD volume.
 *
 * Discovery/ranking/upsert logic lives in src/market/symbolSync.ts, shared
 * with the periodic refresh job (jobs/definitions/symbolRefreshJob.ts) so
 * this script and the job never duplicate the fetch/intersect/upsert code.
 *
 * Wallet provisioning: for every NEWLY inserted base asset, a zero-balance
 * free-play wallet is created for every existing user (autoCreateWallets,
 * reused from apps/api/src/wallets/autoWallets.ts) in the SAME transaction
 * as the trading_pairs/exchange_symbol_map upserts, BEFORE the pair is
 * flipped to is_active = true — see docs/designs/2026-07-22-multi-asset-
 * datafeed-gate1.md section 2.2.1. Without this, existing users would hit
 * wallet_not_found on any newly added pair (matchingEngine.ts throws hard,
 * no lazy-create fallback).
 *
 * Ergonomics — PREVIEW FIRST, same pattern as backfill-freeplay-capital.ts.
 * Dry-run is the DEFAULT (this creates trading pairs, assets, and wallet
 * rows for every existing user); pass --commit to actually write.
 *
 *   Dry-run (default):  tsx scripts/backfillExchangeSymbols.ts
 *   Commit:             tsx scripts/backfillExchangeSymbols.ts --commit
 *   Custom universe size: tsx scripts/backfillExchangeSymbols.ts --limit 60
 *
 * Prod is a manual step: run against the prod DATABASE_URL only after this
 * migration/code is deployed, and dry-run-preview prod first.
 */
import "dotenv/config";
import { pool } from "../src/db/pool";
import { discoverSyncCandidates, applyCandidates, type SyncCandidate } from "../src/market/symbolSync";

const DEFAULT_LIMIT = 75;

function parseLimit(): number {
    const idx = process.argv.indexOf("--limit");
    if (idx === -1) return DEFAULT_LIMIT;
    const val = Number(process.argv[idx + 1]);
    return Number.isFinite(val) && val > 0 ? val : DEFAULT_LIMIT;
}

async function findAlreadyMappedSymbols(symbols: string[]): Promise<Set<string>> {
    if (symbols.length === 0) return new Set();
    const { rows } = await pool.query<{ symbol: string }>(
        `SELECT tp.symbol
         FROM trading_pairs tp
         WHERE tp.symbol = ANY($1)
           AND EXISTS (
               SELECT 1 FROM exchange_symbol_map esm
               WHERE esm.pair_id = tp.id AND esm.exchange = 'kraken' AND esm.is_active = true
           )
           AND EXISTS (
               SELECT 1 FROM exchange_symbol_map esm
               WHERE esm.pair_id = tp.id AND esm.exchange = 'coinbase' AND esm.is_active = true
           )`,
        [symbols],
    );
    return new Set(rows.map((r) => r.symbol));
}

function printCandidate(c: SyncCandidate, alreadyMapped: Set<string>): void {
    const tag = alreadyMapped.has(c.ourSymbol) ? "" : "  (new)";
    const vol = c.volumeUsd24h.toLocaleString("en-US", { maximumFractionDigits: 0 });
    console.log(`  ${c.ourSymbol.padEnd(10)} vol24h=$${vol.padStart(14)}  kraken=${c.kraken.wsSymbol}  coinbase=${c.coinbase.wsSymbol}${tag}`);
}

async function main() {
    const commit = process.argv.includes("--commit");
    const mode = commit ? "COMMIT" : "DRY-RUN";
    const limit = parseLimit();

    console.log(`\n=== backfillExchangeSymbols [${mode}] (top ${limit} by Coinbase 24h USD volume) ===`);
    console.log(`Fetching Kraken AssetPairs + Coinbase products, live-verifying Kraken WS v2 symbols...`);

    const candidates = await discoverSyncCandidates(limit);
    const alreadyMapped = await findAlreadyMappedSymbols(candidates.map((c) => c.ourSymbol));

    console.log(`\ncandidates discovered: ${candidates.length}`);
    console.log(`already mapped:        ${alreadyMapped.size}`);
    console.log(`new:                   ${candidates.length - alreadyMapped.size}\n`);

    for (const c of candidates) printCandidate(c, alreadyMapped);

    if (!commit) {
        console.log(`\nDRY-RUN — no writes. Re-run with --commit to apply the above.`);
        return;
    }

    console.log(`\nApplying ${candidates.length} candidate(s)...`);
    const results = await applyCandidates(candidates);

    const newPairs = results.filter((r) => r.isNewPair).length;
    const newAssets = results.filter((r) => r.isNewBaseAsset).length;
    console.log(`\n=== summary ===`);
    console.log(`pairs upserted:     ${results.length}`);
    console.log(`new pairs:          ${newPairs}`);
    console.log(`new base assets:    ${newAssets} (wallets provisioned for every existing user on each)`);
}

main()
    .catch((err) => {
        console.error("backfillExchangeSymbols failed:", err);
        process.exitCode = 1;
    })
    .finally(async () => {
        await pool.end();
    });
