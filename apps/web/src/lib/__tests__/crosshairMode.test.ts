import { describe, it, expect, beforeEach } from "vitest";
import { CrosshairMode } from "lightweight-charts";
import { crosshairModeFor } from "../crosshairMode";
import { useDrawingStore } from "@/stores/drawingStore";

describe("crosshairModeFor", () => {
    beforeEach(() => {
        localStorage.clear();
        useDrawingStore.setState({ snapEnabled: false });
    });

    it("moves freely (Normal) when the magnet is off", () => {
        expect(crosshairModeFor(false)).toBe(CrosshairMode.Normal);
    });

    it("snaps (Magnet) when the magnet is on", () => {
        expect(crosshairModeFor(true)).toBe(CrosshairMode.Magnet);
    });

    it("defaults to free, and the magnet toggle switches the mode both ways", () => {
        const mode = () => crosshairModeFor(useDrawingStore.getState().snapEnabled);
        expect(mode()).toBe(CrosshairMode.Normal);
        useDrawingStore.getState().toggleSnap();
        expect(mode()).toBe(CrosshairMode.Magnet);
        useDrawingStore.getState().toggleSnap();
        expect(mode()).toBe(CrosshairMode.Normal);
    });
});
