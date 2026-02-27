import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, parseLimit, slicePage } from "../src/http/pagination";

describe("encodeCursor / decodeCursor", () => {
    it("roundtrips an object with ca + id", () => {
        const obj = { ca: "2025-01-15T10:30:00.000Z", id: "abc-123" };
        const encoded = encodeCursor(obj);
        const decoded = decodeCursor<typeof obj>(encoded);
        expect(decoded).toEqual(obj);
    });

    it("roundtrips an object with ts", () => {
        const obj = { ts: 1700000000 };
        const encoded = encodeCursor(obj);
        const decoded = decodeCursor<typeof obj>(encoded);
        expect(decoded).toEqual(obj);
    });

    it("returns null for undefined input", () => {
        expect(decodeCursor(undefined)).toBeNull();
    });

    it("returns null for invalid base64", () => {
        expect(decodeCursor("%%%not-base64%%%")).toBeNull();
    });

    it("returns null for valid base64 but invalid JSON", () => {
        const badB64 = Buffer.from("not json", "utf8").toString("base64url");
        expect(decodeCursor(badB64)).toBeNull();
    });

    it("returns null for base64-encoded primitive (not object)", () => {
        const prim = Buffer.from(JSON.stringify(42), "utf8").toString("base64url");
        expect(decodeCursor(prim)).toBeNull();
    });
});

describe("parseLimit", () => {
    it("returns default 25 for undefined", () => {
        expect(parseLimit(undefined)).toBe(25);
    });

    it("returns default 25 for null", () => {
        expect(parseLimit(null)).toBe(25);
    });

    it("parses a valid number string", () => {
        expect(parseLimit("50")).toBe(50);
    });

    it("clamps to max 100", () => {
        expect(parseLimit("200")).toBe(100);
    });

    it("clamps to min 1 for zero", () => {
        expect(parseLimit("0")).toBe(1);
    });

    it("clamps to min 1 for negative", () => {
        expect(parseLimit("-5")).toBe(1);
    });

    it("returns default 25 for non-numeric string", () => {
        expect(parseLimit("abc")).toBe(25);
    });

    it("floors fractional values", () => {
        expect(parseLimit("10.7")).toBe(10);
    });
});

describe("slicePage", () => {
    const buildCursor = (row: { id: string; ca: string }) => ({ ca: row.ca, id: row.id });

    it("returns all rows and null cursor when under limit", () => {
        const rows = [
            { id: "1", ca: "2025-01-01" },
            { id: "2", ca: "2025-01-02" },
        ];
        const result = slicePage(rows, 5, buildCursor);
        expect(result.data).toHaveLength(2);
        expect(result.nextCursor).toBeNull();
    });

    it("returns exactly limit rows when rows === limit", () => {
        const rows = [
            { id: "1", ca: "2025-01-01" },
            { id: "2", ca: "2025-01-02" },
        ];
        const result = slicePage(rows, 2, buildCursor);
        expect(result.data).toHaveLength(2);
        expect(result.nextCursor).toBeNull();
    });

    it("slices and produces cursor when rows > limit", () => {
        const rows = [
            { id: "1", ca: "2025-01-01" },
            { id: "2", ca: "2025-01-02" },
            { id: "3", ca: "2025-01-03" },
        ];
        const result = slicePage(rows, 2, buildCursor);
        expect(result.data).toHaveLength(2);
        expect(result.nextCursor).not.toBeNull();

        const decoded = decodeCursor<{ ca: string; id: string }>(result.nextCursor!);
        expect(decoded).toEqual({ ca: "2025-01-02", id: "2" });
    });

    it("returns empty data and null cursor for empty input", () => {
        const result = slicePage([], 10, buildCursor);
        expect(result.data).toHaveLength(0);
        expect(result.nextCursor).toBeNull();
    });
});
