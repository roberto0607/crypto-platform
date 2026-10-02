/**
 * fillPriceAudit.ts — diagnostic-only record of how a MARKET order was
 * priced, compared against the real exchange book the trade page displays.
 * Added for the 2026-10-01 bad-fill investigation; it never influences the
 * fill. phase6OrderService logs it as `order.fill_price_audit`.
 *
 * Why this exists: the fill path and the displayed book use different
 * sources. The displayed book is Kraken's L2 book (bookSnapshots, served by
 * /market/book/:symbol). The fill sweeps the INTERNAL resting book at the
 * resting orders' limit prices, then system-fills any remainder at
 * trading_pairs.last_price — which the sim step just overwrote with
 * computeMarketExecution(snapshot.last ± synthetic spread/slippage), where
 * snapshot is the Kraken ticker snapshot (<10s) or, if that's stale, the
 * previous trading_pairs.last_price. This record captures every input so a
 * bad fill can be attributed after the fact.
 */
import type { Snapshot } from "../market/snapshotStore";

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
    simExecPrice: string | null;
    fills: Array<{ price: string; qty: string; system: boolean }>;
    avgFillPrice: number | null;
    bookBestBid: number | null;
    bookBestAsk: number | null;
    bookAgeMs: number | null;
    /** Signed: positive = filled WORSE than the displayed touch (ask for BUY, bid for SELL). */
    deviationBps: number | null;
    offBook: "better" | "worse" | null;
}

export function buildFillPriceAudit(input: {
    side: "BUY" | "SELL";
    snapshot: Snapshot;
    simExecPrice: string | null;
    fills: AuditFill[];
    book: AuditBook | undefined;
    now: number;
}): FillPriceAudit {
    const { side, snapshot, simExecPrice, fills, book, now } = input;

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
    const offBook = deviationBps === null || Math.abs(deviationBps) <= OFF_BOOK_THRESHOLD_BPS
        ? null
        : deviationBps > 0 ? "worse" : "better";

    const snapTs = Date.parse(snapshot.ts);

    return {
        side,
        snapshotSource: snapshot.source,
        snapshotLast: snapshot.last,
        snapshotBid: snapshot.bid,
        snapshotAsk: snapshot.ask,
        snapshotTsAgeMs: Number.isFinite(snapTs) ? now - snapTs : null,
        simExecPrice,
        fills: fills.map((f) => ({ price: f.price, qty: f.qty, system: f.is_system_fill })),
        avgFillPrice,
        bookBestBid,
        bookBestAsk,
        bookAgeMs: book ? now - book.ts : null,
        deviationBps,
        offBook,
    };
}
