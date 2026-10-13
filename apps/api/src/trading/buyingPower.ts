/**
 * Buying power: the 2× rule (QA F5, 2026-10-11).
 *
 * A short sells borrowed base: the base wallet goes negative and the sale
 * proceeds land in USD. Counting those proceeds as spendable is hidden
 * leverage: short $100k, then spend the proceeds on a $100k long.
 *
 *   buyingPower = (USD balance − USD reserved)
 *               − Σ price × (2 × shortQty + openShortReserve)   over base wallets
 *
 *   shortQty         = max(0, −balance)                — an open short
 *   openShortReserve = max(0, reserved − max(0, balance)) — resting sells that
 *                      would open/extend a short (reserved beyond holdings)
 *
 * 2× = buying the short back (1×) plus margin equal to its size (1×), so a
 * short uses buying power exactly like a long of the same size: a $50 short
 * on $100k leaves 99,950, the same as a $50 long. Equivalently, buying power
 * = equity − gross notional at 1× leverage. A resting short sell counts 1×
 * (its proceeds haven't arrived yet); once it fills, it's 2× of the short
 * against the +1× of proceeds — the same net.
 *
 * Mark-to-market: a short that goes against you reduces buying power, and it
 * can go negative. Then only reduce-only orders are allowed.
 *
 * The web order panel's AVAILABLE uses the identical formula
 * (apps/web/src/lib/buyingPower.ts); both are tested on the same cases.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { D, ZERO } from "../utils/decimal";
import { pool } from "../db/pool";
import { config } from "../config";
import { getSnapshot } from "../market/snapshotStore";
import { getMarketReference } from "./priceCollar";

export type BpWallet = { assetId: string; balance: string; reserved: string };

/** Base quantity a wallet counts at: 2 × its short plus its resting short-opening sells. */
export function exposureQty(w: Pick<BpWallet, "balance" | "reserved">): Decimal {
    const balance = D(w.balance);
    const short = Decimal.max(ZERO, balance.neg());
    const openShortReserve = Decimal.max(ZERO, D(w.reserved).minus(Decimal.max(ZERO, balance)));
    return short.mul(2).plus(openShortReserve);
}

/**
 * Buying power of one wallet set. `priceOf(assetId)` marks each base asset;
 * an asset with exposure but no price makes the result null (unknown), so
 * callers can refuse to open risk rather than ignore the short.
 */
export function buyingPower(
    quoteAssetId: string,
    wallets: BpWallet[],
    priceOf: (assetId: string) => Decimal | null,
): Decimal | null {
    let bp = ZERO;
    for (const w of wallets) {
        if (w.assetId === quoteAssetId) {
            bp = bp.plus(D(w.balance).minus(D(w.reserved)));
            continue;
        }
        const qty = exposureQty(w);
        if (qty.isZero()) continue;
        const price = priceOf(w.assetId);
        if (!price) return null;
        bp = bp.minus(price.mul(qty));
    }
    return bp;
}

/**
 * Whether an order only shrinks the position in `base` (the wallet balance)
 * without flipping it. A SELL may use holdings not already committed to
 * other resting sells; a BUY may cover up to the short.
 */
export function isReduceOnly(side: "BUY" | "SELL", qty: Decimal, base: Pick<BpWallet, "balance" | "reserved">): boolean {
    const balance = D(base.balance);
    if (side === "SELL") return qty.lte(balance.minus(D(base.reserved)));
    return qty.lte(Decimal.max(ZERO, balance.neg()));
}

// ── System users ──

const systemUserCache = new Map<string, boolean>();

/**
 * The market-maker and risk-agent bots, and any @system.local account. They
 * are exempt from the buying-power check: the MM bot rests sell ladders and
 * may hold shorts, and a rejected quote empties the book (the same exclusion
 * the fee refund uses, feeRefund.ts).
 */
export async function isSystemUser(userId: string, client: PoolClient | typeof pool = pool): Promise<boolean> {
    if (userId === config.botUserId || userId === config.riskAgentBotUserId) return true;
    const cached = systemUserCache.get(userId);
    if (cached !== undefined) return cached;
    const { rows } = await client.query<{ email_normalized: string }>(
        `SELECT email_normalized FROM users WHERE id = $1`,
        [userId],
    );
    const system = rows[0]?.email_normalized.endsWith("@system.local") ?? false;
    systemUserCache.set(userId, system);
    return system;
}

// ── Marks ──

/**
 * Mark price for a pair: live Kraken mid (book, else ticker), else the last
 * cached snapshot, else trading_pairs.last_price. Null when none exists.
 */
export async function markPrice(pairId: string, symbol: string, lastPrice: string | null): Promise<Decimal | null> {
    const ref = await getMarketReference(pairId, symbol);
    if (ref) return ref.bestBid.plus(ref.bestAsk).div(2);
    const snap = await getSnapshot(symbol);
    if (snap && Number(snap.last) > 0) return D(snap.last);
    if (lastPrice && Number(lastPrice) > 0) return D(lastPrice);
    return null;
}

/**
 * Marks for every base asset in `wallets` that carries exposure, via each
 * asset's pair against `quoteAssetId`. `known` pre-seeds marks (the order's
 * own pair, already priced off its reference).
 */
export async function marksForExposure(
    client: PoolClient,
    quoteAssetId: string,
    wallets: BpWallet[],
    known: Map<string, Decimal>,
): Promise<Map<string, Decimal>> {
    const marks = new Map(known);
    const needed = wallets
        .filter((w) => w.assetId !== quoteAssetId && !marks.has(w.assetId) && !exposureQty(w).isZero())
        .map((w) => w.assetId);
    if (needed.length === 0) return marks;
    const { rows } = await client.query<{ id: string; base_asset_id: string; symbol: string; last_price: string | null }>(
        `SELECT DISTINCT ON (base_asset_id) id, base_asset_id, symbol, last_price::text
         FROM trading_pairs
         WHERE base_asset_id = ANY($1::uuid[]) AND quote_asset_id = $2
         ORDER BY base_asset_id, is_active DESC`,
        [needed, quoteAssetId],
    );
    for (const p of rows) {
        const m = await markPrice(p.id, p.symbol, p.last_price);
        if (m) marks.set(p.base_asset_id, m);
    }
    return marks;
}
