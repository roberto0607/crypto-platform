import { describe, it, expect } from "vitest";
import { crc32 as zlibCrc32 } from "node:zlib";
import { readFileSync } from "node:fs";
import {
    KrakenBook,
    canonicalDecimal,
    checksumField,
    compareDecimal,
    crc32,
    quoteBookNumbers,
    type KrakenPrecision,
    type RawBookLevel,
} from "../krakenBook";

// docs.kraken.com/api/docs/guides/spot-ws-book-v2 — published example, checksum 3310070434.
const DOC_ASKS: RawBookLevel[] = [
    ["45285.2", "0.00100000"], ["45286.4", "1.54571953"], ["45286.6", "1.54571109"], ["45289.6", "1.54560911"],
    ["45290.2", "0.15890660"], ["45291.8", "1.54553491"], ["45294.7", "0.04454749"], ["45296.1", "0.35380000"],
    ["45297.5", "0.09945542"], ["45299.5", "0.18772827"],
].map(([price, qty]) => ({ price: price!, qty: qty! }));
const DOC_BIDS: RawBookLevel[] = [
    ["45283.5", "0.10000000"], ["45283.4", "1.54582015"], ["45282.1", "0.10000000"], ["45281.0", "0.10000000"],
    ["45280.3", "1.54592586"], ["45279.0", "0.07990000"], ["45277.6", "0.03310103"], ["45277.5", "0.30000000"],
    ["45277.3", "1.54602737"], ["45276.6", "0.15445238"],
].map(([price, qty]) => ({ price: price!, qty: qty! }));
const DOC_CHECKSUM = 3310070434;
const BTC: KrakenPrecision = { price: 1, qty: 8 };

/** Live frames captured from wss://ws.kraken.com/v2 (snapshot + 40 updates each), raw text as received. */
const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/krakenBookFrames.json", import.meta.url), "utf8"),
) as { precision: Record<string, KrakenPrecision>; frames: Record<string, string[]> };

function replay(frames: string[], precision: KrakenPrecision, mutate?: (entry: any, i: number) => void) {
    const book = new KrakenBook(25);
    const results: boolean[] = [];
    frames.forEach((raw, i) => {
        const msg = JSON.parse(quoteBookNumbers(raw));
        const entry = msg.data[0];
        mutate?.(entry, i);
        if (msg.type === "snapshot") book.applySnapshot(entry.bids, entry.asks);
        else book.applyUpdate(entry.bids, entry.asks);
        results.push(book.checksum(precision) === entry.checksum);
    });
    return { book, results };
}

describe("crc32", () => {
    it("matches zlib's CRC32 (the function Kraken specifies)", () => {
        for (const s of ["", "0", "4528521000004528641545719534528661545711", "x".repeat(1000)]) {
            expect(crc32(s)).toBe(zlibCrc32(s) >>> 0);
        }
    });
});

describe("Kraken's published checksum example", () => {
    it("reproduces 3310070434", () => {
        const book = new KrakenBook(25);
        book.applySnapshot(DOC_BIDS, DOC_ASKS);
        expect(book.checksum(BTC)).toBe(DOC_CHECKSUM);
    });

    it("is order-independent on input but uses only the top 10 per side", () => {
        const book = new KrakenBook(25);
        const deeperBids = [...DOC_BIDS, { price: "45200.0", qty: "9.00000000" }];
        const deeperAsks = [{ price: "45400.0", qty: "9.00000000" }, ...DOC_ASKS];
        book.applySnapshot([...deeperBids].reverse(), deeperAsks);
        expect(book.checksum(BTC)).toBe(DOC_CHECKSUM);
    });

    it("JSON numbers without trailing zeros (as JSON.parse would give) still match once padded to precision", () => {
        const book = new KrakenBook(25);
        const asNumbers = (ls: RawBookLevel[]) => ls.map((l) => ({ price: Number(l.price), qty: Number(l.qty) }));
        book.applySnapshot(asNumbers(DOC_BIDS), asNumbers(DOC_ASKS));
        expect(book.checksum(BTC)).toBe(DOC_CHECKSUM);
    });
});

describe("live Kraken frames (fixture)", () => {
    for (const symbol of ["BTC/USD", "SHIB/USD"]) {
        it(`${symbol}: snapshot + every update verifies`, () => {
            const { results } = replay(fixture.frames[symbol]!, fixture.precision[symbol]!);
            expect(results.length).toBe(41);
            expect(results.every(Boolean)).toBe(true);
        });
    }

    it("SHIB/USD precision is 9-decimal price / 5-decimal qty (the memecoin edge)", () => {
        expect(fixture.precision["SHIB/USD"]).toEqual({ price: 9, qty: 5 });
    });

    it("a deliberately corrupted delta (1 satoshi on one qty) fails on that message and stays failed", () => {
        const frames = fixture.frames["BTC/USD"]!;
        const at = frames.findIndex((f, i) => i > 0 && /"qty":[1-9]/.test(f)); // first update that sets a level
        expect(at).toBeGreaterThan(0);
        const { results } = replay(frames, BTC, (entry, i) => {
            if (i !== at) return;
            const level = [...entry.bids, ...entry.asks].find((l: any) => Number(l.qty) > 0);
            level.qty = (BigInt(level.qty.replace(".", "")) + 1n).toString().padStart(9, "0").replace(/(\d{8})$/, ".$1");
        });
        expect(results.slice(0, at).every(Boolean)).toBe(true);
        expect(results[at]).toBe(false);
    });

    it("a dropped update is detected", () => {
        const frames = fixture.frames["BTC/USD"]!;
        const skip = frames.findIndex((f, i) => i > 0 && /"qty":[1-9]/.test(f));
        const { results } = replay(frames.filter((_, i) => i !== skip), BTC);
        expect(results.slice(0, skip).every(Boolean)).toBe(true);
        expect(results.slice(skip).some((ok) => !ok)).toBe(true);
    });

    it("the float path loses nothing here — but the exact book keeps Kraken's text", () => {
        const { book } = replay(fixture.frames["SHIB/USD"]!, fixture.precision["SHIB/USD"]!);
        const top = book.top();
        expect(top.bid!.price).toMatch(/^0\.0000\d+$/); // plain decimal, never "5.29e-6"
        expect(book.toLevels().bids[0]!.price).toBeCloseTo(Number(top.bid!.price), 15);
    });
});

describe("book maintenance", () => {
    const L = (price: string, qty: string): RawBookLevel => ({ price, qty });

    it("qty 0 deletes, regardless of how the price/zero is spelled", () => {
        const book = new KrakenBook(25);
        book.applySnapshot([L("100.0", "1.0"), L("99.5", "2")], [L("101", "1")]);
        book.applyUpdate([L("100", "0.00000000")], []);
        expect(book.toLevels().bids).toEqual([{ price: 99.5, qty: 2 }]);
        book.applyUpdate([], [L("101.000", "0")]);
        expect(book.toLevels().asks).toEqual([]);
    });

    it("truncates to depth after an insert pushes a level out of scope", () => {
        const book = new KrakenBook(2);
        book.applySnapshot([L("10", "1"), L("9", "1")], [L("11", "1"), L("12", "1")]);
        book.applyUpdate([L("10.5", "1")], [L("10.75", "1")]);
        expect(book.toLevels().bids.map((l) => l.price)).toEqual([10.5, 10]);
        expect(book.toLevels().asks.map((l) => l.price)).toEqual([10.75, 11]);
    });

    it("orders exactly where doubles cannot tell prices apart", () => {
        const book = new KrakenBook(25);
        // 17 significant digits: both parse to the same double.
        expect(Number("1234567890.1234567")).toBe(Number("1234567890.1234568"));
        book.applySnapshot([L("1234567890.1234567", "1"), L("1234567890.1234568", "2")], []);
        expect(book.top().bid).toEqual({ price: "1234567890.1234568", qty: "2" });
    });
});

describe("edge-format decimals", () => {
    it("canonicalizes trailing zeros, leading zeros and integer forms to one key", () => {
        expect(canonicalDecimal("81797.0")).toBe("81797");
        expect(canonicalDecimal("0081797.500")).toBe("81797.5");
        expect(canonicalDecimal("0.000005320")).toBe("0.00000532");
        expect(canonicalDecimal("0.00000")).toBe("0");
        expect(canonicalDecimal("383320500.00000")).toBe("383320500");
        expect(canonicalDecimal(81797)).toBe("81797");
    });

    it("accepts exponent notation (never observed from Kraken) exactly", () => {
        expect(canonicalDecimal("5.32e-6")).toBe("0.00000532");
        expect(canonicalDecimal("1E-9")).toBe("0.000000001");
        expect(canonicalDecimal("4.5281e4")).toBe("45281");
        expect(canonicalDecimal(1e-9)).toBe("0.000000001"); // String(1e-9) === "1e-9"
        expect(checksumField(canonicalDecimal("5.32e-6"), 9)).toBe("5320");
    });

    it("rejects malformed and negative values instead of mis-keying them", () => {
        for (const bad of ["", "abc", "1.2.3", "-1", "NaN", "Infinity"]) {
            expect(() => canonicalDecimal(bad)).toThrow(/invalid decimal/);
        }
    });

    it("keeps very long quantities exact (past double precision)", () => {
        const long = "123456789012.12345"; // a double reads this as ...12344
        expect(Number(long).toFixed(5)).not.toBe(long);
        expect(canonicalDecimal(long)).toBe(long);
        expect(checksumField(canonicalDecimal(long), 5)).toBe("12345678901212345");
        // The longest qty seen in a 2-min live scan of all 137 pairs (16 sig digits).
        expect(checksumField(canonicalDecimal("13753613.68241863"), 8)).toBe("1375361368241863");
    });

    it("formats checksum fields: pad to precision, drop the point, strip leading zeros", () => {
        expect(checksumField("45285.2", 1)).toBe("452852");
        expect(checksumField("0.001", 8)).toBe("100000");
        expect(checksumField("0.00000532", 9)).toBe("5320");
        expect(checksumField("45281", 1)).toBe("452810");
        expect(checksumField("383320500", 5)).toBe("38332050000000");
        expect(checksumField("0.123", 2)).toBe("123"); // more decimals than precision: kept, so it mismatches
    });

    it("compares decimals exactly", () => {
        expect(compareDecimal("9.99", "10")).toBe(-1);
        expect(compareDecimal("10.1", "10.09")).toBe(1);
        expect(compareDecimal("0.000005320", "0.00000532")).toBe(0);
        expect(compareDecimal("0.00000532", "0.000005291")).toBe(1);
    });

    it("quoteBookNumbers quotes price/qty only, preserving their exact text", () => {
        const raw = '{"channel":"book","type":"update","data":[{"symbol":"SHIB/USD","bids":[{"price":0.000005320,"qty":0.00000}],"asks":[{"price":1E-9,"qty":383320500.00000}],"checksum":1245627773}]}';
        const msg = JSON.parse(quoteBookNumbers(raw));
        expect(msg.data[0].bids[0]).toEqual({ price: "0.000005320", qty: "0.00000" });
        expect(msg.data[0].asks[0]).toEqual({ price: "1E-9", qty: "383320500.00000" });
        expect(msg.data[0].checksum).toBe(1245627773);
    });
});
