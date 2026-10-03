/**
 * Test helpers for the market-order price collar (trading/priceCollar.ts).
 *
 * MARKET orders need a fresh Kraken book as their collar reference and are
 * rejected with stale_price_source without one. Tests run with the Kraken feed
 * off, so any test that places a MARKET order seeds the in-process book state
 * here — the same Map krakenWs.ts writes in production.
 */
import type { Pool } from "pg";
import { bookSnapshots } from "../market/orderFlowFeatures";
import { config } from "../config";

/** Seed a Kraken top-of-book for `pairId`, `ageMs` old (default: fresh now). */
export function seedReferenceBook(
    pairId: string,
    bid: string | number,
    ask: string | number = bid,
    ageMs = 0,
): void {
    bookSnapshots.set(pairId, {
        bids: [{ price: Number(bid), qty: 1 }],
        asks: [{ price: Number(ask), qty: 1 }],
        ts: Date.now() - ageMs,
    });
}

/** Seed a fresh book at each pair's current last_price (HTTP-level tests that create pairs via the API). */
export async function seedReferenceBooksFromLastPrice(db: Pool): Promise<void> {
    const { rows } = await db.query<{ id: string; last_price: string }>(
        `SELECT id, last_price::text FROM trading_pairs WHERE last_price IS NOT NULL`,
    );
    for (const r of rows) seedReferenceBook(r.id, r.last_price);
}

export function clearReferenceBooks(): void {
    bookSnapshots.clear();
}

/**
 * For tests about book mechanics (price-time priority, multi-level sweeps
 * across several % of price) rather than the collar: widen the collar for the
 * duration of the file. Returns a restore function for afterAll.
 */
export function widenCollarForTest(bps = 1_000): () => void {
    const saved = config.marketCollarBps;
    config.marketCollarBps = bps;
    return () => {
        config.marketCollarBps = saved;
    };
}
