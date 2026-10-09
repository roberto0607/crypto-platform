/**
 * krakenBook.ts — exact-decimal Kraken WS v2 order book + CRC32 checksum.
 *
 * Kraken sends a CRC32 `checksum` with every book snapshot/update, computed
 * over its own top-10 levels. Recomputing it over our book proves the book we
 * maintain (and the price collar / fills read) is exactly Kraken's — a missed
 * or misapplied update shows up as a mismatch on the next message.
 *
 * Exact on purpose: prices and quantities are kept as the decimal text Kraken
 * sent, never parsed to floats. Kraken sends them as JSON numbers, and book
 * quantities reach 16 significant digits (13753613.68241863 seen live) — past
 * what a double round-trips, so a float book could silently drift from the
 * checksum. Kraken's guide says the same: decode price/qty with a decimal or
 * string decoder. quoteBookNumbers() makes that possible on Node 20 (no
 * JSON.parse source-text access) by quoting the numbers before parsing.
 *
 * Checksum (docs.kraken.com, spot-ws-book-v2): top 10 asks low→high, then top
 * 10 bids high→low; per level price then qty, each formatted to the pair's
 * price_precision / qty_precision (instrument channel), "." removed, leading
 * zeros stripped; CRC32 of the concatenation as an unsigned 32-bit integer.
 */
import Decimal from "decimal.js";
import type { BookLevel } from "./orderFlowFeatures.js";

export type KrakenPrecision = { price: number; qty: number };
/** One book level as received: price/qty are the decimal text from the wire (or numbers, defensively). */
export type RawBookLevel = { price: string | number; qty: string | number };

const CHECKSUM_LEVELS = 10;

/**
 * Quote every `"price":` / `"qty":` JSON number in a raw book frame so
 * JSON.parse yields their exact decimal text instead of a lossy double.
 * Only the book channel is run through this (callers check the channel).
 */
export function quoteBookNumbers(text: string): string {
    return text.replace(/"(price|qty)":\s*(-?\d[\d.eE+-]*)/g, '"$1":"$2"');
}

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * Canonical plain decimal: no exponent, no sign, no leading zeros on the
 * integer part ("0" when empty), no trailing fractional zeros. "45281.0",
 * "45281" and 4.5281e4 all map to "45281", so a level is one Map key no matter
 * how Kraken spelled it. Throws on anything that is not a finite, non-negative
 * decimal — a malformed level must not be silently mis-keyed.
 */
export function canonicalDecimal(value: string | number): string {
    let s = typeof value === "number" ? String(value) : value.trim();
    if (!PLAIN_DECIMAL.test(s)) {
        // Exponent notation (never observed from Kraken; handled defensively)
        // or a JS-stringified tiny number like "1e-9".
        let d: Decimal;
        try {
            d = new Decimal(s);
        } catch {
            throw new Error(`kraken book: invalid decimal ${JSON.stringify(value)}`);
        }
        if (!d.isFinite() || d.isNegative()) throw new Error(`kraken book: invalid decimal ${JSON.stringify(value)}`);
        s = d.toFixed();
    }
    const dot = s.indexOf(".");
    let int = dot === -1 ? s : s.slice(0, dot);
    let frac = dot === -1 ? "" : s.slice(dot + 1);
    int = int.replace(/^0+/, "") || "0";
    frac = frac.replace(/0+$/, "");
    return frac ? `${int}.${frac}` : int;
}

/** Exact comparison of two canonical decimals (−1, 0, 1). */
export function compareDecimal(a: string, b: string): number {
    const ai = a.indexOf("."), bi = b.indexOf(".");
    const aInt = ai === -1 ? a : a.slice(0, ai);
    const bInt = bi === -1 ? b : b.slice(0, bi);
    if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
    if (aInt !== bInt) return aInt < bInt ? -1 : 1;
    const aFrac = ai === -1 ? "" : a.slice(ai + 1);
    const bFrac = bi === -1 ? "" : b.slice(bi + 1);
    const len = Math.max(aFrac.length, bFrac.length);
    const ap = aFrac.padEnd(len, "0"), bp = bFrac.padEnd(len, "0");
    return ap === bp ? 0 : ap < bp ? -1 : 1;
}

/**
 * Checksum field for one value: padded to `decimals` places, "." removed,
 * leading zeros stripped. A value with MORE decimals than the precision is
 * kept as-is (not rounded) — it means the precision we hold is wrong, and a
 * mismatch is the right outcome.
 */
export function checksumField(canonical: string, decimals: number): string {
    const dot = canonical.indexOf(".");
    const int = dot === -1 ? canonical : canonical.slice(0, dot);
    const frac = dot === -1 ? "" : canonical.slice(dot + 1);
    const digits = int + (frac.length >= decimals ? frac : frac.padEnd(decimals, "0"));
    return digits.replace(/^0+/, "");
}

// ── CRC32 (IEEE 802.3, as zlib) — own table: zlib.crc32 is not in every Node 20 ──
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/** CRC32 of an ASCII string (checksum input is digits only), as an unsigned 32-bit integer. */
export function crc32(s: string): number {
    let c = 0xffffffff;
    for (let i = 0; i < s.length; i++) c = CRC_TABLE[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

type Level = { price: string; qty: string };

/**
 * One symbol's book, truncated to the subscribed depth after every message
 * (Kraken never sends qty 0 for levels that fall out of scope). Bids are
 * kept high→low, asks low→high.
 */
export class KrakenBook {
    private bids: Level[] = [];
    private asks: Level[] = [];

    constructor(private readonly depth: number) {}

    applySnapshot(bids: readonly RawBookLevel[], asks: readonly RawBookLevel[]): void {
        this.bids = this.merge([], bids, true);
        this.asks = this.merge([], asks, false);
    }

    applyUpdate(bids: readonly RawBookLevel[], asks: readonly RawBookLevel[]): void {
        if (bids.length) this.bids = this.merge(this.bids, bids, true);
        if (asks.length) this.asks = this.merge(this.asks, asks, false);
    }

    /** Kraken's CRC32 over our top 10 asks + top 10 bids. */
    checksum(precision: KrakenPrecision): number {
        let s = "";
        for (const l of this.asks.slice(0, CHECKSUM_LEVELS)) {
            s += checksumField(l.price, precision.price) + checksumField(l.qty, precision.qty);
        }
        for (const l of this.bids.slice(0, CHECKSUM_LEVELS)) {
            s += checksumField(l.price, precision.price) + checksumField(l.qty, precision.qty);
        }
        return crc32(s);
    }

    /** The numeric view stored in orderFlowFeatures.bookSnapshots for the collar and other readers. */
    toLevels(): { bids: BookLevel[]; asks: BookLevel[] } {
        const num = (l: Level): BookLevel => ({ price: Number(l.price), qty: Number(l.qty) });
        return { bids: this.bids.map(num), asks: this.asks.map(num) };
    }

    /** Top level per side as exact text — for mismatch logs. */
    top(): { bid: Level | null; ask: Level | null } {
        return { bid: this.bids[0] ?? null, ask: this.asks[0] ?? null };
    }

    private merge(current: Level[], changes: readonly RawBookLevel[], descending: boolean): Level[] {
        const byPrice = new Map(current.map((l) => [l.price, l.qty]));
        for (const c of changes) {
            const price = canonicalDecimal(c.price);
            const qty = canonicalDecimal(c.qty);
            if (qty === "0") byPrice.delete(price);
            else byPrice.set(price, qty);
        }
        const sign = descending ? -1 : 1;
        return Array.from(byPrice, ([price, qty]) => ({ price, qty }))
            .sort((a, b) => sign * compareDecimal(a.price, b.price))
            .slice(0, this.depth);
    }
}
