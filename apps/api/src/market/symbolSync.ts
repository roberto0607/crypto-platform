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

const logger = rootLogger.child({ module: "symbolSync" });

const KRAKEN_BASE_URL = "https://api.kraken.com/0/public";
const COINBASE_BASE_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";
const KRAKEN_WS_URL = "wss://ws.kraken.com/v2";

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
 *  wsCandidate as an actual WS v2 subscribe symbol. */
async function fetchKrakenCandidates(): Promise<KrakenCandidateRaw[]> {
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

async function fetchCoinbaseCandidates(): Promise<CoinbaseCandidate[]> {
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

/**
 * Fetch Kraken + Coinbase candidates, intersect on base symbol, live-verify
 * Kraken WS symbols, and rank by Coinbase's approximate_quote_24h_volume
 * (already USD-denominated; Kraken's AssetPairs has no volume field, and
 * ranking only needs to apply within the already-intersected set).
 */
export async function discoverSyncCandidates(limit: number): Promise<SyncCandidate[]> {
    const [krakenRaw, coinbase] = await Promise.all([
        fetchKrakenCandidates(),
        fetchCoinbaseCandidates(),
    ]);

    const coinbaseBySymbol = new Map(coinbase.map((c) => [c.baseSymbol, c]));
    const krakenBySymbol = new Map<string, KrakenCandidateRaw>();
    for (const k of krakenRaw) {
        if (coinbaseBySymbol.has(k.baseSymbol)) krakenBySymbol.set(k.baseSymbol, k);
    }

    // Rank by volume BEFORE live-verifying — only the top `limit` (plus a
    // buffer, since a few may fail verification) need a real WS round trip,
    // not the entire ~300-pair intersection.
    const ranked = [...krakenBySymbol.entries()]
        .map(([baseSymbol, kraken]) => ({ baseSymbol, kraken, cb: coinbaseBySymbol.get(baseSymbol)! }))
        .sort((a, b) => b.cb.volumeUsd24h - a.cb.volumeUsd24h)
        .slice(0, limit + 25);

    const verified = await verifyKrakenWsSymbols(ranked.map((r) => r.kraken.wsCandidate));

    const intersected: SyncCandidate[] = [];
    for (const { baseSymbol, kraken, cb } of ranked) {
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

    return intersected.slice(0, limit);
}

export interface UpsertResult {
    ourSymbol: string;
    pairId: string;
    isNewPair: boolean;
    isNewBaseAsset: boolean;
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

    const existingPair = await client.query<{ id: string }>(
        `SELECT id FROM trading_pairs WHERE symbol = $1`,
        [candidate.ourSymbol],
    );

    let pairId: string;
    let isNewPair: boolean;

    if (existingPair.rows.length > 0) {
        pairId = existingPair.rows[0]!.id;
        isNewPair = false;
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

    if (isNewPair) {
        await client.query(`UPDATE trading_pairs SET is_active = true WHERE id = $1`, [pairId]);
    }

    return { ourSymbol: candidate.ourSymbol, pairId, isNewPair, isNewBaseAsset: base.isNew };
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
export async function syncSymbols(limit: number): Promise<{ candidates: SyncCandidate[]; results: UpsertResult[] }> {
    const candidates = await discoverSyncCandidates(limit);
    const results = await applyCandidates(candidates);
    return { candidates, results };
}
