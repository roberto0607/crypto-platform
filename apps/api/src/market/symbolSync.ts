/**
 * symbolSync.ts — shared Kraken ∩ Coinbase symbol discovery, ranking, and
 * upsert logic. Used by both the one-time backfill script
 * (scripts/backfillExchangeSymbols.ts) and the periodic refresh job
 * (jobs/definitions/symbolRefreshJob.ts) — see docs/designs/2026-07-22-
 * multi-asset-datafeed-gate1.md section 2.2/2.3 for the design.
 *
 * Only Kraken + Coinbase are sourced (Binance/Bybit ruled out — US Railway
 * geo-block, same reason Stage 2 funding/OI avoided them).
 */
import type { PoolClient } from "pg";
import WebSocket from "ws";
import { pool } from "../db/pool.js";
import { autoCreateWallets } from "../wallets/autoWallets.js";
import { logger as rootLogger } from "../observability/logContext.js";
import { config } from "../config.js";
import { isTradableSymbol } from "./marketSymbols.js";

const logger = rootLogger.child({ module: "symbolSync" });

const KRAKEN_BASE_URL = "https://api.kraken.com/0/public";
const COINBASE_BASE_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";
const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/**
 * Kraken's REST AssetPairs "wsname" field is unreliable for legacy-coded
 * assets — live-verified against wss://ws.kraken.com/v2: it rejects
 * "XBT/USD" (what wsname reports for BTC) and only accepts "BTC/USD".
 * Applied before the live-verification pass below, which catches any other
 * mismatch this table doesn't yet know about.
 */
const KRAKEN_WS_SYMBOL_OVERRIDES: Record<string, string> = {
    "XBT/USD": "BTC/USD",
};

/** Market-cap rank cutoff for pair eligibility — a Kraken ∩ Coinbase pair
 *  is synced / kept active only if its base asset sits within the top
 *  MARKET_CAP_RANK_CUTOFF by market cap (CoinGecko /coins/markets). Shared
 *  by the periodic refresh job and the one-time backfill/prune scripts so
 *  they never drift. Replaces DEFAULT_SYNC_LIMIT (the old top-75-by-24h-
 *  volume gate), which had no symmetric prune and let the active set grow
 *  without bound. */
export const MARKET_CAP_RANK_CUTOFF = 30;

/** Consecutive symbol-refresh runs (6h each) an active pair must sit
 *  outside the top MARKET_CAP_RANK_CUTOFF before prunePairs() deactivates
 *  it. 12 × 6h = 3 days — long enough that a coin hovering at the rank
 *  boundary doesn't flicker is_active on/off run to run. */
export const MCAP_PRUNE_GRACE_RUNS = 12;

/** The "this pair holds nothing a user could be stranded by" predicate —
 *  no non-zero position, no OPEN/PARTIALLY_FILLED order, no ACTIVE
 *  trigger. Shared verbatim by prunePairs()'s Layer-A nominee filter and
 *  deactivatePairsGuarded()'s Layer-B atomic guard so the two can never
 *  drift. References the `tp` alias, which both call sites use. */
export const PAIR_HOLDS_NOTHING_LIVE_SQL = `
    NOT EXISTS (SELECT 1 FROM positions p
                 WHERE p.pair_id = tp.id AND p.base_qty <> 0)
    AND NOT EXISTS (SELECT 1 FROM orders o
                     WHERE o.pair_id = tp.id
                       AND o.status IN ('OPEN', 'PARTIALLY_FILLED'))
    AND NOT EXISTS (SELECT 1 FROM trigger_orders t
                     WHERE t.pair_id = tp.id AND t.status = 'ACTIVE')`;

/** Default decimals for newly created assets — matches the existing BTC/ETH/SOL
 *  convention (assets.decimals) and wallets.balance's NUMERIC(28,8) precision.
 *  Not derived per-asset from Kraken/Coinbase (their reported decimals vary and
 *  some exceed 8), to keep wallet precision uniform across all assets. */
const DEFAULT_ASSET_DECIMALS = 8;

export interface SyncCandidate {
    ourSymbol: string;       // e.g. "BTC/USD"
    baseSymbol: string;      // "BTC"
    baseName: string;        // "Bitcoin" (display name, best-effort)
    quoteSymbol: string;     // "USD"
    volumeUsd24h: number;    // Coinbase approximate_quote_24h_volume — ranking signal
    kraken: { wsSymbol: string; restSymbol: string };
    coinbase: { wsSymbol: string; restSymbol: string };
}

interface KrakenAssetPair {
    wsname?: string;
    altname: string;
    base: string;
    quote: string;
    status: string;
}

interface KrakenCandidateRaw {
    baseSymbol: string;
    restSymbol: string;      // altname, e.g. "XBTUSD"
    wsCandidate: string;     // wsname after override, pre-live-verification
}

/** Fetch Kraken's USD-quoted, online spot pairs. Does NOT live-verify WS
 *  symbols yet — call verifyKrakenWsSymbols() on the result before trusting
 *  wsCandidate as an actual WS v2 subscribe symbol. Exported for delisting
 *  checks (checkDelistings) in addition to discoverSyncCandidates. */
export async function fetchKrakenCandidates(): Promise<KrakenCandidateRaw[]> {
    const res = await fetch(`${KRAKEN_BASE_URL}/AssetPairs`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Kraken AssetPairs HTTP ${res.status}`);
    const json = await res.json() as { error: string[]; result: Record<string, KrakenAssetPair> };
    if (json.error?.length) throw new Error(`Kraken AssetPairs error: ${json.error.join(", ")}`);

    const out: KrakenCandidateRaw[] = [];
    for (const pair of Object.values(json.result)) {
        if (pair.quote !== "ZUSD" || pair.status !== "online" || !pair.wsname) continue;
        // Derive baseSymbol from the OVERRIDE-CORRECTED symbol, not the raw
        // wsname — otherwise legacy-coded assets (e.g. wsname "XBT/USD")
        // would key against "XBT" and never intersect with Coinbase's "BTC".
        const wsCandidate = KRAKEN_WS_SYMBOL_OVERRIDES[pair.wsname] ?? pair.wsname;
        const [wsBase] = wsCandidate.split("/");
        if (!wsBase) continue;
        out.push({ baseSymbol: wsBase, restSymbol: pair.altname, wsCandidate });
    }
    return out;
}

/**
 * Live-verify a batch of candidate WS v2 symbols against Kraken's real WS
 * endpoint. Kraken evaluates each symbol in a subscribe array independently
 * (confirmed live: a mixed valid/invalid batch returns one success/error
 * frame per symbol, not an all-or-nothing rejection) — so this is a single
 * connection, single subscribe message, collecting per-symbol responses.
 * Returns the subset of symbols Kraken actually accepted.
 */
export function verifyKrakenWsSymbols(wsSymbols: string[], timeoutMs = 10_000): Promise<Set<string>> {
    return new Promise((resolve) => {
        if (wsSymbols.length === 0) {
            resolve(new Set());
            return;
        }

        const verified = new Set<string>();
        const pending = new Set(wsSymbols);
        let settled = false;

        const ws = new WebSocket(KRAKEN_WS_URL);

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws.terminate();
            resolve(verified);
        };

        const timer = setTimeout(finish, timeoutMs);

        ws.on("open", () => {
            ws.send(JSON.stringify({
                method: "subscribe",
                params: { channel: "ticker", symbol: wsSymbols },
            }));
        });

        ws.on("message", (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.method !== "subscribe") return;
                // Kraken's response shape differs by outcome: success nests
                // "symbol" inside "result", failure puts it at the top level.
                const symbol: unknown = msg.success === true ? msg.result?.symbol : msg.symbol;
                if (typeof symbol !== "string") return;
                pending.delete(symbol);
                if (msg.success === true) verified.add(symbol);
                else logger.warn({ symbol, error: msg.error }, "symbol_sync_kraken_ws_symbol_rejected");
                if (pending.size === 0) finish();
            } catch {
                // ignore heartbeats / unparseable frames
            }
        });

        ws.on("error", (err) => {
            logger.error({ err }, "symbol_sync_kraken_ws_verify_error");
            finish();
        });
    });
}

interface CoinbaseProduct {
    product_id: string;
    base_currency_id: string;
    quote_currency_id: string;
    base_name?: string;
    trading_disabled: boolean;
    status: string;
    approximate_quote_24h_volume?: string;
}

export interface CoinbaseCandidate {
    baseSymbol: string;
    baseName: string;
    productId: string;
    volumeUsd24h: number;
}

export async function fetchCoinbaseCandidates(): Promise<CoinbaseCandidate[]> {
    const res = await fetch(`${COINBASE_BASE_URL}?product_type=SPOT&limit=1000`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Coinbase products HTTP ${res.status}`);
    const json = await res.json() as { products: CoinbaseProduct[] };

    return json.products
        .filter((p) => p.quote_currency_id === "USD" && !p.trading_disabled && p.status === "online")
        .map((p) => ({
            baseSymbol: p.base_currency_id,
            baseName: p.base_name ?? p.base_currency_id,
            productId: p.product_id,
            volumeUsd24h: Number(p.approximate_quote_24h_volume ?? 0),
        }));
}

interface CoinGeckoMarketRow {
    id: string;
    symbol: string;
    name: string;
    market_cap_rank: number | null;
}

/**
 * Fetch the top `topN` coins by market cap from CoinGecko, returned as a
 * Map<UPPERCASE_SYMBOL, market_cap_rank>. This is the new pair-eligibility
 * gate for the symbol-refresh job: a Kraken INTERSECT Coinbase pair is
 * synced / kept active only if its base symbol is a key in this map (see
 * discoverSyncCandidates). Replaces the old "top 75 by Coinbase 24h
 * volume" ranking, which only ever grew the active set because nothing
 * ever pruned a pair that merely fell down the ranking.
 *
 * Keyless by default (config.coingeckoApiKey empty); a Demo key, if set,
 * is sent as x-cg-demo-api-key. One call per 6h run either way.
 *
 * FAIL-LOUD by design -- every failure mode throws:
 *   - non-2xx HTTP / network error / timeout / non-array body
 *   - fewer than `topN` well-formed rows: an empty or truncated list
 *     must NEVER be read as "nothing is eligible", because that would
 *     make the prune pass try to deactivate every active pair.
 * discoverSyncCandidates does not catch this, so a CoinGecko outage
 * fails the entire symbol-refresh run -- that run adds nothing and
 * prunes nothing, and the job retries in 6h. Deliberately safer than
 * falling back to volume ranking, which would silently re-admit
 * long-tail pairs for the duration of the outage.
 */
export async function fetchTopMarketCapSymbols(topN: number): Promise<Map<string, number>> {
    const url = `${COINGECKO_BASE_URL}/coins/markets`
        + `?vs_currency=usd&order=market_cap_desc&per_page=${topN}&page=1&sparkline=false`;

    const headers: Record<string, string> = {};
    if (config.coingeckoApiKey) headers["x-cg-demo-api-key"] = config.coingeckoApiKey;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        throw new Error(`CoinGecko coins/markets HTTP ${res.status} ${res.statusText}`);
    }

    const body = await res.json() as unknown;
    if (!Array.isArray(body)) {
        throw new Error("CoinGecko coins/markets returned a non-array body");
    }
    const rows = body as CoinGeckoMarketRow[];

    // UPPERCASE symbol -> best (lowest) market_cap_rank. Rows arrive
    // sorted by rank ascending, so the first sighting of a symbol is its
    // best rank; a later duplicate (two coins sharing a ticker) is a
    // lower-ranked impostor and is ignored. validRows counts well-formed
    // rows independently of the map so a rare top-N ticker collision
    // can't trip the truncation guard below.
    const bySymbol = new Map<string, number>();
    let validRows = 0;
    for (const row of rows) {
        if (typeof row.symbol !== "string" || typeof row.market_cap_rank !== "number") continue;
        validRows++;
        const symbol = row.symbol.toUpperCase();
        if (!bySymbol.has(symbol)) bySymbol.set(symbol, row.market_cap_rank);
    }

    if (validRows < topN) {
        throw new Error(
            `CoinGecko coins/markets returned only ${validRows} well-formed rows (expected >= ${topN}) `
            + `-- refusing to run the eligibility gate on a truncated list`,
        );
    }

    return bySymbol;
}

/**
 * Fetch Kraken + Coinbase candidates plus CoinGecko's top-`cutoff`
 * market-cap set, intersect all three on base symbol, live-verify the
 * surviving Kraken WS symbols, and return them ordered by market-cap rank
 * ascending.
 *
 * The market-cap intersection is what bounds the WS-verification round
 * trip now (~20-30 symbols) — the old "+25 buffer then slice to N" logic
 * is gone: every pair that passes Kraken ∩ Coinbase ∩ top-`cutoff` is
 * verified, and whichever verify are returned. A few WS-verification
 * failures just yield a slightly smaller set; there is deliberately no
 * back-fill from rank cutoff+1.
 *
 * volumeUsd24h is still populated on each SyncCandidate (from Coinbase)
 * but is informational only now — market-cap rank is the ranking signal.
 *
 * If fetchTopMarketCapSymbols throws (CoinGecko outage / truncated list),
 * Promise.all rejects and this function throws — the whole symbol-refresh
 * run fails, adding and pruning nothing that cycle.
 */
export async function discoverSyncCandidates(
    cutoff: number = MARKET_CAP_RANK_CUTOFF,
    allow: ReadonlySet<string> = config.marketSymbols,
): Promise<SyncCandidate[]> {
    const [krakenRaw, coinbase, mcapRank] = await Promise.all([
        fetchKrakenCandidates(),
        fetchCoinbaseCandidates(),
        fetchTopMarketCapSymbols(cutoff),
    ]);

    const coinbaseBySymbol = new Map(coinbase.map((c) => [c.baseSymbol, c]));
    const krakenBySymbol = new Map<string, KrakenCandidateRaw>();
    for (const k of krakenRaw) {
        if (coinbaseBySymbol.has(k.baseSymbol)) krakenBySymbol.set(k.baseSymbol, k);
    }

    // Kraken ∩ Coinbase ∩ top-`cutoff` by market cap, ordered by rank
    // ascending. The market-cap filter is what keeps the WS-verification
    // batch small (~20-30), so the whole eligible set is verified — no
    // pre-verification slice / buffer.
    //
    // MARKET_SYMBOLS gate: only allowlisted pairs ever become candidates, so
    // neither the refresh job nor the backfill script (the only two callers,
    // both via this function) can insert or re-activate any other pair.
    const eligible = [...krakenBySymbol.entries()]
        .filter(([baseSymbol]) => mcapRank.has(baseSymbol))
        .filter(([baseSymbol]) => isTradableSymbol(`${baseSymbol}/USD`, allow))
        .map(([baseSymbol, kraken]) => ({ baseSymbol, kraken, cb: coinbaseBySymbol.get(baseSymbol)! }))
        .sort((a, b) => mcapRank.get(a.baseSymbol)! - mcapRank.get(b.baseSymbol)!);

    const verified = await verifyKrakenWsSymbols(eligible.map((r) => r.kraken.wsCandidate));

    const intersected: SyncCandidate[] = [];
    for (const { baseSymbol, kraken, cb } of eligible) {
        if (!verified.has(kraken.wsCandidate)) continue;
        intersected.push({
            ourSymbol: `${baseSymbol}/USD`,
            baseSymbol,
            baseName: cb.baseName,
            quoteSymbol: "USD",
            volumeUsd24h: cb.volumeUsd24h,
            kraken: { wsSymbol: kraken.wsCandidate, restSymbol: kraken.restSymbol },
            coinbase: { wsSymbol: cb.productId, restSymbol: cb.productId },
        });
    }

    // Defensive only — `eligible` can't exceed `cutoff` distinct symbols
    // by construction. Kept per the "leave the final slice as-is" scope.
    return intersected.slice(0, cutoff);
}

export interface UpsertResult {
    ourSymbol: string;
    pairId: string;
    isNewPair: boolean;
    isNewBaseAsset: boolean;
    wasReactivated: boolean;
}

async function upsertAsset(client: PoolClient, symbol: string, name: string): Promise<{ id: string; isNew: boolean }> {
    const existing = await client.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = $1`, [symbol]);
    if (existing.rows.length > 0) return { id: existing.rows[0]!.id, isNew: false };

    const inserted = await client.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ($1, $2, $3)
         ON CONFLICT (symbol) DO UPDATE SET symbol = EXCLUDED.symbol
         RETURNING id`,
        [symbol, name, DEFAULT_ASSET_DECIMALS],
    );
    return { id: inserted.rows[0]!.id, isNew: true };
}

/**
 * Upsert one candidate's assets/trading_pairs/exchange_symbol_map rows, and
 * provision zero-balance free-play wallets for every existing user for any
 * newly created asset — all within the caller's transaction, before the
 * trading_pairs row is flipped to is_active = true. Reuses autoCreateWallets
 * (apps/api/src/wallets/autoWallets.ts) rather than new bulk-insert SQL — it
 * is already a set-based, idempotent, transaction-joinable per-user wallet
 * provisioner (see backfill-freeplay-capital.ts for the established pattern
 * of looping it over all existing users).
 */
export async function upsertCandidate(client: PoolClient, candidate: SyncCandidate): Promise<UpsertResult> {
    const base = await upsertAsset(client, candidate.baseSymbol, candidate.baseName);
    const quote = await upsertAsset(client, candidate.quoteSymbol, candidate.quoteSymbol === "USD" ? "US Dollar" : candidate.quoteSymbol);

    const existingPair = await client.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM trading_pairs WHERE symbol = $1`,
        [candidate.ourSymbol],
    );

    let pairId: string;
    let isNewPair: boolean;
    // A pair can already have a trading_pairs row (isNewPair = false) but
    // still need is_active flipped back to true — a prior checkDelistings()
    // run may have deactivated it, and it's now back online on both
    // exchanges. Row-existence alone (the old isNewPair-only check) missed
    // this: exchange_symbol_map rows got reactivated below but
    // trading_pairs.is_active silently never did, leaving a relisted pair
    // permanently untradeable.
    let wasReactivated = false;

    if (existingPair.rows.length > 0) {
        pairId = existingPair.rows[0]!.id;
        isNewPair = false;
        wasReactivated = existingPair.rows[0]!.is_active === false;
    } else {
        // Wallet provisioning happens BEFORE the pair goes live for trading —
        // insert with is_active = false, provision wallets for the new asset,
        // then flip is_active = true at the end of this function.
        const inserted = await client.query<{ id: string }>(
            `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active)
             VALUES ($1, $2, $3, false)
             RETURNING id`,
            [base.id, quote.id, candidate.ourSymbol],
        );
        pairId = inserted.rows[0]!.id;
        isNewPair = true;
    }

    for (const exchange of ["kraken", "coinbase"] as const) {
        const { wsSymbol, restSymbol } = candidate[exchange];
        await client.query(
            `INSERT INTO exchange_symbol_map (pair_id, exchange, ws_symbol, rest_symbol, is_active)
             VALUES ($1, $2, $3, $4, true)
             ON CONFLICT (pair_id, exchange) DO UPDATE SET
                 ws_symbol = EXCLUDED.ws_symbol,
                 rest_symbol = EXCLUDED.rest_symbol,
                 is_active = true`,
            [pairId, exchange, wsSymbol, restSymbol],
        );
    }

    if (base.isNew) {
        const { rows: users } = await client.query<{ id: string }>(`SELECT id FROM users`);
        for (const user of users) {
            await autoCreateWallets(user.id, null, client);
        }
        logger.info({ symbol: candidate.baseSymbol, usersProvisioned: users.length }, "symbol_sync_wallets_provisioned");
    }

    if (isNewPair || wasReactivated) {
        await client.query(`UPDATE trading_pairs SET is_active = true WHERE id = $1`, [pairId]);
    }

    return { ourSymbol: candidate.ourSymbol, pairId, isNewPair, isNewBaseAsset: base.isNew, wasReactivated };
}

/** Apply already-discovered candidates inside one transaction. Split from
 *  discoverSyncCandidates() so callers that want a preview (the backfill
 *  script's dry-run) can inspect candidates before deciding whether to write. */
export async function applyCandidates(candidates: SyncCandidate[]): Promise<UpsertResult[]> {
    const client = await pool.connect();
    const results: UpsertResult[] = [];
    try {
        await client.query("BEGIN");
        for (const candidate of candidates) {
            results.push(await upsertCandidate(client, candidate));
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return results;
}

/** Convenience wrapper for callers that always want to commit immediately
 *  (the periodic refresh job — see jobs/definitions/symbolRefreshJob.ts). */
export async function syncSymbols(
    cutoff: number = MARKET_CAP_RANK_CUTOFF,
): Promise<{ candidates: SyncCandidate[]; results: UpsertResult[] }> {
    const candidates = await discoverSyncCandidates(cutoff);
    const results = await applyCandidates(candidates);
    return { candidates, results };
}

export interface DelistingResult {
    exchangeRowsDeactivated: number;
    pairsDeactivated: number;
}

/**
 * Check every currently-active exchange_symbol_map row against a fresh
 * fetch of each exchange's online USD pairs. A pair merely dropping out
 * of the top-MARKET_CAP_RANK_CUTOFF eligibility ranking is NOT a delisting
 * (that's the prunePairs() grace-counter path) — this checks the full raw
 * listing (fetchKrakenCandidates/fetchCoinbaseCandidates, unfiltered by
 * intersection or rank) for each exchange independently, so a pair that's
 * merely fallen down the ranking stays mapped and tradeable.
 *
 * Deactivates one exchange's mapping row at a time — trading_pairs.is_active
 * only flips off once BOTH exchange rows are inactive, so a pair delisted on
 * one exchange but still live on the other keeps trading (the whole point of
 * dual-sourcing Kraken + Coinbase).
 *
 * NOTE: unlike prunePairs(), this has NO held-position safety gate. A
 * genuine two-exchange delisting means the asset is untradeable on any
 * venue we source, so deactivating it even with an open position is
 * correct — there is nothing left to trade against. The resulting
 * can't-close-a-stranded-position gap is pre-existing; see docs/followups.md.
 */
export async function checkDelistings(client: PoolClient): Promise<DelistingResult> {
    const [krakenRaw, coinbaseRaw] = await Promise.all([
        fetchKrakenCandidates(),
        fetchCoinbaseCandidates(),
    ]);
    const krakenOnline = new Set(krakenRaw.map((k) => k.baseSymbol));
    const coinbaseOnline = new Set(coinbaseRaw.map((c) => c.baseSymbol));

    const { rows } = await client.query<{
        id: string;
        pair_id: string;
        exchange: "kraken" | "coinbase";
        pair_symbol: string;
        base_symbol: string;
    }>(
        `SELECT esm.id, esm.pair_id, esm.exchange, tp.symbol AS pair_symbol, a.symbol AS base_symbol
         FROM exchange_symbol_map esm
         JOIN trading_pairs tp ON tp.id = esm.pair_id
         JOIN assets a ON a.id = tp.base_asset_id
         WHERE esm.is_active = true`,
    );

    let exchangeRowsDeactivated = 0;
    const touchedPairIds = new Set<string>();

    for (const row of rows) {
        const stillOnline = row.exchange === "kraken"
            ? krakenOnline.has(row.base_symbol)
            : coinbaseOnline.has(row.base_symbol);
        if (stillOnline) continue;

        await client.query(`UPDATE exchange_symbol_map SET is_active = false WHERE id = $1`, [row.id]);
        exchangeRowsDeactivated++;
        touchedPairIds.add(row.pair_id);
        logger.info({ pairSymbol: row.pair_symbol, exchange: row.exchange }, "symbol_refresh_exchange_delisted");
    }

    let pairsDeactivated = 0;
    for (const pairId of touchedPairIds) {
        const { rows: activeRows } = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM exchange_symbol_map WHERE pair_id = $1 AND is_active = true`,
            [pairId],
        );
        if (Number(activeRows[0]!.count) === 0) {
            await client.query(`UPDATE trading_pairs SET is_active = false WHERE id = $1`, [pairId]);
            pairsDeactivated++;
        }
    }

    return { exchangeRowsDeactivated, pairsDeactivated };
}

export interface PruneResult {
    missesReset: number;        // active pairs back in the top-N (counter was > 0)
    missesIncremented: number;  // active pairs outside the top-N this run
    pairsDeactivated: number;   // past the grace window AND cleared the safety gate
}

/**
 * LAYER B of the pair-deactivation safety gate. Atomically flips
 * is_active = false for exactly `pairIds`, with PAIR_HOLDS_NOTHING_LIVE_SQL
 * IN THE UPDATE's OWN WHERE clause — the check and the write are one
 * statement (no TOCTOU), and a bug in a *separate* safety query cannot
 * cause a wrong deactivation.
 *
 * Returns the IDs actually deactivated. If that is fewer than `pairIds`,
 * a caller's Layer-A filter admitted a pair that holds something live:
 * this logs the offenders and THROWS, so the caller's transaction rolls
 * back rather than half-applying. It never silently skips.
 */
export async function deactivatePairsGuarded(client: PoolClient, pairIds: string[]): Promise<string[]> {
    if (pairIds.length === 0) return [];
    const { rows } = await client.query<{ id: string }>(
        `UPDATE trading_pairs tp
            SET is_active = false
          WHERE tp.id = ANY($1::uuid[])
            AND ${PAIR_HOLDS_NOTHING_LIVE_SQL}
          RETURNING tp.id`,
        [pairIds],
    );
    if (rows.length !== pairIds.length) {
        const deactivated = new Set(rows.map((r) => r.id));
        const blocked = pairIds.filter((id) => !deactivated.has(id));
        logger.error({ blockedPairIds: blocked }, "pair_deactivation_safety_assertion_failed");
        throw new Error(
            `deactivatePairsGuarded: safety assertion failed — ${blocked.length} of ${pairIds.length} `
            + `target pair(s) hold a live position / order / trigger and were refused by the atomic `
            + `guard. Rolling back; no pairs deactivated.`,
        );
    }
    return rows.map((r) => r.id);
}

/**
 * Market-cap prune pass for the symbol-refresh job. In one transaction:
 *   1. reset mcap_rank_misses to 0 for active pairs back in the top-N
 *   2. increment it for active pairs outside the top-N
 *   3. Layer A — nominate active pairs past MCAP_PRUNE_GRACE_RUNS that
 *      hold nothing live (a held pair is never nominated)
 *   4. Layer B — deactivatePairsGuarded re-checks atomically and throws
 *      on any mismatch
 *
 * `eligibleSymbols` defaults to the current top-MARKET_CAP_RANK_CUTOFF
 * set from CoinGecko (its own fetch — one extra call per 6h run). Tests
 * and the one-time backlog script inject their own set.
 *
 * Throws (→ job run FAILED, last_error persisted) on: CoinGecko failure,
 * an empty eligible set, or a Layer-B assertion mismatch. Rolls back
 * whole on any error — never half-applies.
 */
export async function prunePairs(eligibleSymbols?: Set<string>): Promise<PruneResult> {
    const eligible = eligibleSymbols
        ?? new Set((await fetchTopMarketCapSymbols(MARKET_CAP_RANK_CUTOFF)).keys());

    // An empty set would mark every active pair as a miss and march the
    // whole book toward deactivation. fetchTopMarketCapSymbols already
    // throws on a truncated list; this guards a caller-injected set.
    if (eligible.size === 0) {
        throw new Error("prunePairs: refusing to run with an empty eligible-symbol set");
    }

    const eligibleArr = [...eligible];
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const reset = await client.query(
            `UPDATE trading_pairs tp
                SET mcap_rank_misses = 0
               FROM assets a
              WHERE a.id = tp.base_asset_id
                AND tp.is_active = true
                AND tp.mcap_rank_misses <> 0
                AND a.symbol = ANY($1::text[])`,
            [eligibleArr],
        );

        const incremented = await client.query(
            `UPDATE trading_pairs tp
                SET mcap_rank_misses = mcap_rank_misses + 1
               FROM assets a
              WHERE a.id = tp.base_asset_id
                AND tp.is_active = true
                AND NOT (a.symbol = ANY($1::text[]))`,
            [eligibleArr],
        );

        // Layer A — past the grace window AND holding nothing live.
        const { rows: nominees } = await client.query<{ id: string; symbol: string }>(
            `SELECT tp.id, tp.symbol
               FROM trading_pairs tp
              WHERE tp.is_active = true
                AND tp.mcap_rank_misses >= $1
                AND ${PAIR_HOLDS_NOTHING_LIVE_SQL}`,
            [MCAP_PRUNE_GRACE_RUNS],
        );

        // Layer B — atomic re-check + assertion.
        const deactivatedIds = await deactivatePairsGuarded(client, nominees.map((n) => n.id));
        for (const n of nominees) {
            logger.info({ pairSymbol: n.symbol, pairId: n.id }, "mcap_prune_pair_deactivated");
        }

        await client.query("COMMIT");
        return {
            missesReset: reset.rowCount ?? 0,
            missesIncremented: incremented.rowCount ?? 0,
            pairsDeactivated: deactivatedIds.length,
        };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}
