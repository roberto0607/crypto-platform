/**
 * fillPriceAudit.ts — diagnostic-only record of how a MARKET order was
 * priced, compared against the real exchange book the trade page displays.
 * Added for the 2026-10-01 bad-fill investigation; it never influences the
 * fill. phase6OrderService logs it as `order.fill_price_audit`.
 *
 * Since B1 (2026-10) a MARKET order sweeps the internal resting book only
 * within the collar of the real Kraken touch, then system-fills any remainder
 * from that touch (walking the book past the touch band, marketFillPrice.ts) —
 * the fresh Kraken book, else the fresh Kraken ticker bid/ask (priceCollar.getMarketReference). `reference*` records which one
 * priced the fill; the displayed book (bookSnapshots, served by
 * /market/book/:symbol) is recorded alongside so any gap between what the
 * user saw and what they got is attributable after the fact.
 */
import type { Snapshot } from "../market/snapshotStore";
import type { CollarReference } from "./priceCollar";

export interface AuditFill {
    price: string;
    qty: string;
    is_system_fill: boolean;
}

export interface AuditBook {
    bids: Array<{ price: number }>;
    asks: Array<{ price: number }>;
    ts: number;
}

/** Fills more than this far from the displayed book's touch are counted as off-book. */
export const OFF_BOOK_THRESHOLD_BPS = 25;

export interface FillPriceAudit {
    side: "BUY" | "SELL";
    snapshotSource: Snapshot["source"];
    snapshotLast: string;
    snapshotBid: string | null;
    snapshotAsk: string | null;
    /** now − snapshot.ts. NOTE: a "fallback" snapshot stamps ts = now, so it always reads ~0 here
     *  even though trading_pairs.last_price can be arbitrarily old. */
    snapshotTsAgeMs: number | null;
    /** What priced the fill: live Kraken book / ticker, or a replay session's historical price. */
    referenceSource: CollarReference["source"] | null;
    referenceBid: string | null;
    referenceAsk: string | null;
    referenceAgeMs: number | null;
    fills: Array<{ price: string; qty: string; system: boolean }>;
    avgFillPrice: number | null;
    bookBestBid: number | null;
    bookBestAsk: number | null;
    bookAgeMs: number | null;
    /** Signed: positive = filled WORSE than the displayed touch (ask for BUY, bid for SELL). */
    deviationBps: number | null;
    /** The part of deviationBps that is the intended walk past the touch band. */
    walkBps: number;
    offBook: "better" | "worse" | null;
}

export function buildFillPriceAudit(input: {
    side: "BUY" | "SELL";
    snapshot: Snapshot;
    reference: CollarReference | null;
    fills: AuditFill[];
    /** What the system fill paid past the touch, on purpose: not off-book. */
    systemFillSlippageBps?: number;
    book: AuditBook | undefined;
    now: number;
}): FillPriceAudit {
    const { side, snapshot, reference, fills, book, now, systemFillSlippageBps = 0 } = input;

    let notional = 0;
    let qtySum = 0;
    for (const f of fills) {
        const q = Number(f.qty);
        notional += Number(f.price) * q;
        qtySum += q;
    }
    const avgFillPrice = qtySum > 0 ? notional / qtySum : null;

    const bookBestBid = book?.bids[0]?.price ?? null;
    const bookBestAsk = book?.asks[0]?.price ?? null;
    const touch = side === "BUY" ? bookBestAsk : bookBestBid;

    let deviationBps: number | null = null;
    if (avgFillPrice !== null && touch !== null && touch > 0) {
        const raw = ((avgFillPrice - touch) / touch) * 10_000;
        deviationBps = Math.round((side === "BUY" ? raw : -raw) * 100) / 100;
    }
    // The share of the average that is the intended walk.
    const systemQty = fills.reduce((sum, f) => sum + (f.is_system_fill ? Number(f.qty) : 0), 0);
    const walkBps = qtySum > 0 ? systemFillSlippageBps * (systemQty / qtySum) : 0;
    const unexplainedBps = deviationBps === null ? null : deviationBps - walkBps;
    const offBook = unexplainedBps === null || Math.abs(unexplainedBps) <= OFF_BOOK_THRESHOLD_BPS
        ? null
        : unexplainedBps > 0 ? "worse" : "better";

    const snapTs = Date.parse(snapshot.ts);

    return {
        side,
        snapshotSource: snapshot.source,
        snapshotLast: snapshot.last,
        snapshotBid: snapshot.bid,
        snapshotAsk: snapshot.ask,
        snapshotTsAgeMs: Number.isFinite(snapTs) ? now - snapTs : null,
        referenceSource: reference?.source ?? null,
        referenceBid: reference?.bestBid.toString() ?? null,
        referenceAsk: reference?.bestAsk.toString() ?? null,
        referenceAgeMs: reference?.ageMs ?? null,
        fills: fills.map((f) => ({ price: f.price, qty: f.qty, system: f.is_system_fill })),
        avgFillPrice,
        bookBestBid,
        bookBestAsk,
        bookAgeMs: book ? now - book.ts : null,
        deviationBps,
        walkBps,
        offBook,
    };
}
