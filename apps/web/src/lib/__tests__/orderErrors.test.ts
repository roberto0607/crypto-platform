import { describe, it, expect } from "vitest";
import { orderErrorText, quoteReasonText, fmtCompactUsd } from "@/lib/orderErrors";

const ctx = { leveraged: false, cap: 1, available: 1234.5, maxNotional: 5_000_000, baseSymbol: "BTC" };
const fail = (status: number, data: unknown) => ({ response: { status, data } });

describe("orderErrorText", () => {
  it("reads all three error shapes", () => {
    expect(orderErrorText(fail(400, { error: "insufficient_balance" }), ctx)).toBe("Insufficient balance — $1,234.50 available");
    expect(orderErrorText(fail(400, { code: "insufficient_balance", message: "x" }), ctx)).toBe("Insufficient balance — $1,234.50 available");
    expect(orderErrorText(fail(429, { statusCode: 429, error: "Too Many Requests" }), ctx)).toBe("Too many requests — wait a moment and retry");
  });
  it("an ended competition says so", () => {
    expect(orderErrorText(fail(409, { ok: false, error: "competition_ended" }), ctx)).toBe("This competition has ended — it takes no more orders");
  });
  it("order_too_large without details falls back to the pair's cap", () => {
    expect(orderErrorText(fail(400, { error: "order_too_large" }), ctx)).toBe("Max order $5,000,000 on BTC");
  });
  it("an unknown code uses the server's message, then a generic line", () => {
    expect(orderErrorText(fail(400, { error: "new_thing", message: "Nope." }), ctx)).toBe("Nope.");
    expect(orderErrorText(fail(500, { error: "new_thing" }), ctx)).toBe("Order failed");
    expect(orderErrorText(new Error("Network Error"), ctx)).toBe("Order failed — check your connection and retry");
  });
});

describe("quoteReasonText", () => {
  it("uses the same text as the rejection", () => {
    expect(quoteReasonText("book_stale_for_size", ctx)).toBe("Price feed stale — try a smaller order or retry");
    expect(quoteReasonText("order_too_large", ctx)).toBe("Max order $5,000,000 on BTC");
  });
});

describe("fmtCompactUsd", () => {
  it.each([[992_012, "$992k"], [5_000_000, "$5.00M"], [1_234_567, "$1.23M"], [950, "$950"], [999_600, "$1.00M"]])("%d → %s", (n, s) => {
    expect(fmtCompactUsd(n)).toBe(s);
  });
});
