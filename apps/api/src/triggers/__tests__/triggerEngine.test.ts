import { describe, it, expect } from "vitest";
import { shouldTrigger } from "../triggerEngine";
import type { TriggerOrderRow } from "../triggerTypes";

function makeTrigger(overrides: Partial<TriggerOrderRow> = {}): TriggerOrderRow {
    return {
        id: "t1",
        user_id: "u1",
        pair_id: "p1",
        kind: "STOP_MARKET",
        side: "BUY",
        trigger_price: "50000.00000000",
        limit_price: null,
        qty: "1.00000000",
        status: "ACTIVE",
        oco_group_id: null,
        derived_order_id: null,
        fail_reason: null,
        trailing_offset: null,
        trailing_high_water_mark: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

describe("shouldTrigger", () => {
    // ── STOP_MARKET ──

    it("STOP_MARKET BUY fires when last >= trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_MARKET", side: "BUY", trigger_price: "50000" });
        expect(shouldTrigger(t, { last: "50000" })).toBe(true);
        expect(shouldTrigger(t, { last: "50001" })).toBe(true);
    });

    it("STOP_MARKET BUY does NOT fire when last < trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_MARKET", side: "BUY", trigger_price: "50000" });
        expect(shouldTrigger(t, { last: "49999.99" })).toBe(false);
    });

    it("STOP_MARKET SELL fires when last <= trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_MARKET", side: "SELL", trigger_price: "50000" });
        expect(shouldTrigger(t, { last: "50000" })).toBe(true);
        expect(shouldTrigger(t, { last: "49999" })).toBe(true);
    });

    it("STOP_MARKET SELL does NOT fire when last > trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_MARKET", side: "SELL", trigger_price: "50000" });
        expect(shouldTrigger(t, { last: "50000.01" })).toBe(false);
    });

    // ── STOP_LIMIT ──

    it("STOP_LIMIT BUY fires when last >= trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_LIMIT", side: "BUY", trigger_price: "50000", limit_price: "50100" });
        expect(shouldTrigger(t, { last: "50000" })).toBe(true);
    });

    it("STOP_LIMIT SELL fires when last <= trigger_price", () => {
        const t = makeTrigger({ kind: "STOP_LIMIT", side: "SELL", trigger_price: "50000", limit_price: "49900" });
        expect(shouldTrigger(t, { last: "50000" })).toBe(true);
    });

    // ── TAKE_PROFIT_MARKET ──

    it("TAKE_PROFIT_MARKET SELL fires when last >= trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_MARKET", side: "SELL", trigger_price: "55000" });
        expect(shouldTrigger(t, { last: "55000" })).toBe(true);
        expect(shouldTrigger(t, { last: "56000" })).toBe(true);
    });

    it("TAKE_PROFIT_MARKET SELL does NOT fire when last < trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_MARKET", side: "SELL", trigger_price: "55000" });
        expect(shouldTrigger(t, { last: "54999.99" })).toBe(false);
    });

    it("TAKE_PROFIT_MARKET BUY fires when last <= trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_MARKET", side: "BUY", trigger_price: "45000" });
        expect(shouldTrigger(t, { last: "45000" })).toBe(true);
        expect(shouldTrigger(t, { last: "44000" })).toBe(true);
    });

    it("TAKE_PROFIT_MARKET BUY does NOT fire when last > trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_MARKET", side: "BUY", trigger_price: "45000" });
        expect(shouldTrigger(t, { last: "45000.01" })).toBe(false);
    });

    // ── TAKE_PROFIT_LIMIT ──

    it("TAKE_PROFIT_LIMIT SELL fires when last >= trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_LIMIT", side: "SELL", trigger_price: "55000", limit_price: "54900" });
        expect(shouldTrigger(t, { last: "55000" })).toBe(true);
    });

    it("TAKE_PROFIT_LIMIT BUY fires when last <= trigger_price", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_LIMIT", side: "BUY", trigger_price: "45000", limit_price: "45100" });
        expect(shouldTrigger(t, { last: "45000" })).toBe(true);
    });

    // ── Edge: exact boundary ──

    it("fires exactly at trigger_price boundary", () => {
        const stopBuy = makeTrigger({ kind: "STOP_MARKET", side: "BUY", trigger_price: "100.12345678" });
        expect(shouldTrigger(stopBuy, { last: "100.12345678" })).toBe(true);

        const stopSell = makeTrigger({ kind: "STOP_MARKET", side: "SELL", trigger_price: "100.12345678" });
        expect(shouldTrigger(stopSell, { last: "100.12345678" })).toBe(true);
    });

    // ── Edge: price gap past trigger ──

    it("fires on price gap past trigger (STOP_MARKET SELL)", () => {
        const t = makeTrigger({ kind: "STOP_MARKET", side: "SELL", trigger_price: "50000" });
        expect(shouldTrigger(t, { last: "48000" })).toBe(true);
    });

    it("fires on price gap past trigger (TAKE_PROFIT_MARKET SELL)", () => {
        const t = makeTrigger({ kind: "TAKE_PROFIT_MARKET", side: "SELL", trigger_price: "55000" });
        expect(shouldTrigger(t, { last: "60000" })).toBe(true);
    });
});
