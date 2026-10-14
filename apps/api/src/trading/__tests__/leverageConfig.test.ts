/**
 * leverageConfig.test.ts — the leverage flags parse safely (dark by default,
 * malformed values fail boot) and leverageCap() applies them.
 */
import { describe, it, expect } from "vitest";
import { config } from "../../config";
import { leverageCap, parseLeverageConfig, type LeverageConfig } from "../leverageConfig";

const ALICE = "5b44aeb6-81c4-4131-bd06-b87e6fe89f11";
const BOB = "338d993f-0444-4a0a-b463-d3cb6ce0d959";

describe("parseLeverageConfig", () => {
    it("defaults: disabled, log_only, caps 10 / 5 / 1, no allowlist", () => {
        expect(parseLeverageConfig({})).toEqual({
            enabled: false,
            liquidationMode: "log_only",
            maxFreePlay: 10,
            maxMatch: 5,
            maxCompetition: 1,
            allowlist: [],
        });
    });

    it("the running config has leverage off (nothing in the test env sets it)", () => {
        expect(config.leverage.enabled).toBe(false);
    });

    it("LEVERAGE_ENABLED is on only for true / 1", () => {
        expect(parseLeverageConfig({ LEVERAGE_ENABLED: "true" }).enabled).toBe(true);
        expect(parseLeverageConfig({ LEVERAGE_ENABLED: "1" }).enabled).toBe(true);
        expect(parseLeverageConfig({ LEVERAGE_ENABLED: "yes" }).enabled).toBe(false);
        expect(parseLeverageConfig({ LEVERAGE_ENABLED: "false" }).enabled).toBe(false);
    });

    it("reads the mode, caps and allowlist", () => {
        const cfg = parseLeverageConfig({
            LIQUIDATION_MODE: "execute",
            LEVERAGE_MAX_FREE_PLAY: "20",
            LEVERAGE_MAX_MATCH: "2.5",
            LEVERAGE_MAX_COMPETITION: "3",
            LEVERAGE_ALLOWLIST: ` ${ALICE.toUpperCase()} , ${BOB},`,
        });
        expect(cfg).toMatchObject({ liquidationMode: "execute", maxFreePlay: 20, maxMatch: 2.5, maxCompetition: 3 });
        expect(cfg.allowlist).toEqual([ALICE, BOB]);
    });

    it.each([
        ["LIQUIDATION_MODE", "on"],
        ["LEVERAGE_MAX_FREE_PLAY", "0.5"],
        ["LEVERAGE_MAX_MATCH", "abc"],
        ["LEVERAGE_MAX_MATCH", "101"],
        ["LEVERAGE_MAX_COMPETITION", "1.005"],
        ["LEVERAGE_ALLOWLIST", "not-a-uuid"],
    ])("%s=%s fails boot", (name, value) => {
        expect(() => parseLeverageConfig({ [name]: value })).toThrow(name);
    });
});

describe("leverageCap", () => {
    const on: LeverageConfig = { ...parseLeverageConfig({}), enabled: true };
    const pair = 10;

    it("is 1 while leverage is disabled, whatever the caps", () => {
        const off = parseLeverageConfig({ LEVERAGE_MAX_FREE_PLAY: "50" });
        expect(leverageCap(off, { mode: "FREE_PLAY", userId: ALICE, pairMaxLeverage: 50 })).toBe(1);
    });

    it("uses each mode's cap: free-play 10, competition 1", () => {
        expect(leverageCap(on, { mode: "FREE_PLAY", userId: ALICE, pairMaxLeverage: pair })).toBe(10);
        expect(leverageCap(on, { mode: "COMPETITION", userId: ALICE, pairMaxLeverage: pair })).toBe(1);
    });

    it("a match uses its own stamped cap; an unstamped (SPOT) match is 1x", () => {
        expect(leverageCap(on, { mode: "MATCH", userId: ALICE, pairMaxLeverage: pair, matchMaxLeverage: 5 })).toBe(5);
        expect(leverageCap(on, { mode: "MATCH", userId: ALICE, pairMaxLeverage: pair, matchMaxLeverage: 1 })).toBe(1);
        expect(leverageCap(on, { mode: "MATCH", userId: ALICE, pairMaxLeverage: pair })).toBe(1);
    });

    it("never above the pair's own max_leverage", () => {
        expect(leverageCap(on, { mode: "FREE_PLAY", userId: ALICE, pairMaxLeverage: 3 })).toBe(3);
    });

    it("a non-empty allowlist holds everyone else at 1x", () => {
        const phase1 = { ...on, allowlist: [ALICE] };
        expect(leverageCap(phase1, { mode: "FREE_PLAY", userId: ALICE.toUpperCase(), pairMaxLeverage: pair })).toBe(10);
        expect(leverageCap(phase1, { mode: "FREE_PLAY", userId: BOB, pairMaxLeverage: pair })).toBe(1);
    });
});
