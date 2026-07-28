import { describe, it, expect, beforeEach } from "vitest";
import { useDrawingStore } from "@/stores/drawingStore";

// drawingStore drives the click-to-place state machine (IDLE -> PLACING ->
// COMMITTED -> SELECTED) plus per-pair localStorage persistence. These tests
// pin the arity-based commit contract (1-point tools commit on the first
// click, 2-point tools need a second) and the persistence round-trip, since
// this is the first mouse-driven interaction state machine in this codebase.

describe("drawingStore", () => {
    beforeEach(() => {
        localStorage.clear();
        useDrawingStore.setState({
            currentPairId: null,
            drawings: [],
            activeTool: null,
            pendingPoints: [],
            selectedDrawingId: null,
            draggingAnchor: null,
            snapEnabled: false,
        });
    });

    it("loadForPair loads an empty list for a pair with no stored drawings", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        expect(useDrawingStore.getState().drawings).toEqual([]);
        expect(useDrawingStore.getState().currentPairId).toBe("btc-pair");
    });

    it("loadForPair is a no-op when already loaded for that pair (preserves in-progress tool state)", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("trendline");
        useDrawingStore.getState().loadForPair("btc-pair");
        expect(useDrawingStore.getState().activeTool).toBe("trendline");
    });

    it("a 1-point tool (horizontal line) commits on the first addPoint", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("hline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });

        const state = useDrawingStore.getState();
        expect(state.activeTool).toBeNull();
        expect(state.pendingPoints).toEqual([]);
        expect(state.drawings).toHaveLength(1);
        expect(state.drawings[0]!.type).toBe("hline");
        expect(state.drawings[0]!.points).toEqual([{ time: 1000, price: 50000 }]);
        // New drawing enters selected state on commit.
        expect(state.selectedDrawingId).toBe(state.drawings[0]!.id);
    });

    it("a 2-point tool (trendline) does not commit until the second addPoint", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("trendline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });

        let state = useDrawingStore.getState();
        expect(state.activeTool).toBe("trendline");
        expect(state.pendingPoints).toEqual([{ time: 1000, price: 50000 }]);
        expect(state.drawings).toHaveLength(0);

        useDrawingStore.getState().addPoint({ time: 2000, price: 51000 });
        state = useDrawingStore.getState();
        expect(state.activeTool).toBeNull();
        expect(state.drawings).toHaveLength(1);
        expect(state.drawings[0]!.points).toEqual([
            { time: 1000, price: 50000 },
            { time: 2000, price: 51000 },
        ]);
    });

    it("a 2-point tool (fib) commits with its own type and default color, same arity contract as trendline", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("fib");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });
        expect(useDrawingStore.getState().drawings).toHaveLength(0);

        useDrawingStore.getState().addPoint({ time: 2000, price: 60000 });
        const state = useDrawingStore.getState();
        expect(state.activeTool).toBeNull();
        expect(state.drawings).toHaveLength(1);
        expect(state.drawings[0]!.type).toBe("fib");
        expect(state.drawings[0]!.color).toBe("#c084fc");
        expect(state.drawings[0]!.points).toEqual([
            { time: 1000, price: 50000 },
            { time: 2000, price: 60000 },
        ]);
    });

    it("cancelPlacement clears an in-progress drawing without committing it", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("rect");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });
        useDrawingStore.getState().cancelPlacement();

        const state = useDrawingStore.getState();
        expect(state.activeTool).toBeNull();
        expect(state.pendingPoints).toEqual([]);
        expect(state.drawings).toHaveLength(0);
    });

    it("persists committed drawings to localStorage under tradr_drawings_{pairId} and survives a reload of the same pair", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("vline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });

        const raw = localStorage.getItem("tradr_drawings_btc-pair");
        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!)).toHaveLength(1);

        // Simulate a fresh mount reading back the persisted pair.
        useDrawingStore.setState({ currentPairId: null, drawings: [] });
        useDrawingStore.getState().loadForPair("btc-pair");
        expect(useDrawingStore.getState().drawings).toHaveLength(1);
        expect(useDrawingStore.getState().drawings[0]!.type).toBe("vline");
    });

    it("scopes drawings per pair — loading a different pair does not see the first pair's drawings", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("hline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });

        useDrawingStore.setState({ currentPairId: null, drawings: [] });
        useDrawingStore.getState().loadForPair("eth-pair");
        expect(useDrawingStore.getState().drawings).toEqual([]);
    });

    it("deleteDrawing removes it from state and persistence, and clears selection if it was selected", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("hline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });
        const id = useDrawingStore.getState().drawings[0]!.id;
        expect(useDrawingStore.getState().selectedDrawingId).toBe(id);

        useDrawingStore.getState().deleteDrawing(id);

        const state = useDrawingStore.getState();
        expect(state.drawings).toHaveLength(0);
        expect(state.selectedDrawingId).toBeNull();
        expect(JSON.parse(localStorage.getItem("tradr_drawings_btc-pair")!)).toEqual([]);
    });

    it("deleteSelected deletes the currently selected drawing", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("hline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });

        useDrawingStore.getState().deleteSelected();
        expect(useDrawingStore.getState().drawings).toHaveLength(0);
    });

    it("startDraggingAnchor + updateDraggingAnchor updates in-memory only until commitDraggingAnchor persists it", () => {
        useDrawingStore.getState().loadForPair("btc-pair");
        useDrawingStore.getState().setActiveTool("hline");
        useDrawingStore.getState().addPoint({ time: 1000, price: 50000 });
        const id = useDrawingStore.getState().drawings[0]!.id;

        useDrawingStore.getState().startDraggingAnchor(id, 0);
        useDrawingStore.getState().updateDraggingAnchor({ time: 1000, price: 52000 });

        // In-memory reflects the drag immediately.
        expect(useDrawingStore.getState().drawings[0]!.points[0]).toEqual({ time: 1000, price: 52000 });
        // But persisted copy still has the drag committed at addPoint time (50000)
        // until commitDraggingAnchor runs.
        const persistedMidDrag = JSON.parse(localStorage.getItem("tradr_drawings_btc-pair")!);
        expect(persistedMidDrag[0].points[0].price).toBe(50000);

        useDrawingStore.getState().commitDraggingAnchor();
        expect(useDrawingStore.getState().draggingAnchor).toBeNull();
        const persistedAfterCommit = JSON.parse(localStorage.getItem("tradr_drawings_btc-pair")!);
        expect(persistedAfterCommit[0].points[0].price).toBe(52000);
    });

    it("a stale version wipes all tradr_drawings_* keys but leaves unrelated keys alone", () => {
        localStorage.setItem("tradr_drawings_btc-pair", JSON.stringify([{ id: "x" }]));
        localStorage.setItem("tradr_drawings_eth-pair", JSON.stringify([{ id: "y" }]));
        localStorage.setItem("tradr_drawings_version", "0"); // older than current schema version
        localStorage.setItem("tradr_panel_heights", "unrelated");

        useDrawingStore.getState().loadForPair("btc-pair");

        expect(useDrawingStore.getState().drawings).toEqual([]);
        expect(localStorage.getItem("tradr_drawings_eth-pair")).toBeNull();
        expect(localStorage.getItem("tradr_panel_heights")).toBe("unrelated");
        expect(localStorage.getItem("tradr_drawings_version")).toBe("1");
    });

    it("snapEnabled defaults to false and toggleSnap persists the flag under its own key", () => {
        expect(useDrawingStore.getState().snapEnabled).toBe(false);

        useDrawingStore.getState().toggleSnap();
        expect(useDrawingStore.getState().snapEnabled).toBe(true);
        expect(localStorage.getItem("tradr_snap_enabled")).toBe("1");

        useDrawingStore.getState().toggleSnap();
        expect(useDrawingStore.getState().snapEnabled).toBe(false);
        expect(localStorage.getItem("tradr_snap_enabled")).toBe("0");
    });

    it("snapEnabled is not affected by a stale-version wipe (separate key from tradr_drawings_*)", () => {
        localStorage.setItem("tradr_snap_enabled", "1");
        localStorage.setItem("tradr_drawings_version", "0");

        useDrawingStore.getState().loadForPair("btc-pair");

        expect(localStorage.getItem("tradr_snap_enabled")).toBe("1");
    });
});
