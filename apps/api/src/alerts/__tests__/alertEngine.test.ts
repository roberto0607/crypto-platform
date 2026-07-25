import { describe, it, expect } from "vitest";
import { shouldFireAlert } from "../alertEngine";
import type { AlertRow } from "../alertTypes";

function makeAlert(overrides: Partial<AlertRow> = {}): AlertRow {
    return {
        id: "a1",
        user_id: "u1",
        pair_id: "p1",
        condition_type: "CROSSING",
        target_value: "50000",
        frequency: "ONCE",
        frequency_minutes: null,
        last_fired_at: null,
        status: "ACTIVE",
        expiration: null,
        message_template: null,
        channels: ["email"],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...overrides,
    };
}

describe("shouldFireAlert", () => {
    // ── prevPrice === null (first tick this process has seen) ──

    it("never fires when prevPrice is null, regardless of condition_type", () => {
        expect(shouldFireAlert(makeAlert({ condition_type: "CROSSING" }), null, 50000)).toBe(false);
        expect(shouldFireAlert(makeAlert({ condition_type: "CROSSING_UP" }), null, 50000)).toBe(false);
        expect(shouldFireAlert(makeAlert({ condition_type: "CROSSING_DOWN" }), null, 50000)).toBe(false);
    });

    // ── CROSSING (either direction) ──

    it("CROSSING fires when price crosses upward through target", () => {
        const a = makeAlert({ condition_type: "CROSSING", target_value: "50000" });
        expect(shouldFireAlert(a, 49999, 50000)).toBe(true);
        expect(shouldFireAlert(a, 49000, 50001)).toBe(true);
    });

    it("CROSSING fires when price crosses downward through target", () => {
        const a = makeAlert({ condition_type: "CROSSING", target_value: "50000" });
        expect(shouldFireAlert(a, 50001, 50000)).toBe(true);
        expect(shouldFireAlert(a, 50001, 49999)).toBe(true);
    });

    it("CROSSING does NOT fire when price stays on the same side of target", () => {
        const a = makeAlert({ condition_type: "CROSSING", target_value: "50000" });
        expect(shouldFireAlert(a, 49000, 49500)).toBe(false);
        expect(shouldFireAlert(a, 51000, 50500)).toBe(false);
    });

    // ── CROSSING_UP ──

    it("CROSSING_UP fires only when price crosses upward through target", () => {
        const a = makeAlert({ condition_type: "CROSSING_UP", target_value: "50000" });
        expect(shouldFireAlert(a, 49999, 50000)).toBe(true);
        expect(shouldFireAlert(a, 50001, 49999)).toBe(false);
    });

    it("CROSSING_UP does NOT fire when price stays above or below target", () => {
        const a = makeAlert({ condition_type: "CROSSING_UP", target_value: "50000" });
        expect(shouldFireAlert(a, 51000, 50500)).toBe(false);
        expect(shouldFireAlert(a, 49000, 49500)).toBe(false);
    });

    // ── CROSSING_DOWN ──

    it("CROSSING_DOWN fires only when price crosses downward through target", () => {
        const a = makeAlert({ condition_type: "CROSSING_DOWN", target_value: "50000" });
        expect(shouldFireAlert(a, 50001, 50000)).toBe(true);
        expect(shouldFireAlert(a, 49999, 50001)).toBe(false);
    });

    it("CROSSING_DOWN does NOT fire when price stays above or below target", () => {
        const a = makeAlert({ condition_type: "CROSSING_DOWN", target_value: "50000" });
        expect(shouldFireAlert(a, 51000, 50500)).toBe(false);
        expect(shouldFireAlert(a, 49000, 49500)).toBe(false);
    });

    // ── boundary: exact equality counts as "reached" for both directions ──

    it("treats exact equality with target as having reached it", () => {
        const a = makeAlert({ condition_type: "CROSSING", target_value: "50000" });
        expect(shouldFireAlert(a, 49999, 50000)).toBe(true);
        expect(shouldFireAlert(a, 50001, 50000)).toBe(true);
    });
});
