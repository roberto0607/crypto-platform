import { describe, it, expect } from "vitest";
import {
    distanceToSegment,
    HIT_TOLERANCE_PX,
    ANCHOR_HANDLE_SIZE,
    hitTestAnchorIndex,
    anchorExternalId,
    parseAnchorExternalId,
} from "@/lib/drawings/drawingPrimitiveShared";

// distanceToSegment backs Trendline's hitTest (Rectangle/lines use simpler
// axis-aligned checks that don't need this). Pinning it in isolation here
// since mocking a real IChartApi/ISeriesApi to exercise the primitives'
// hitTest end-to-end would test the mock more than the geometry — the
// primitives' actual on-chart rendering was verified via Playwright instead.

describe("distanceToSegment", () => {
    it("returns 0 for a point exactly on the segment", () => {
        expect(distanceToSegment(5, 5, 0, 0, 10, 10)).toBeCloseTo(0, 5);
    });

    it("returns the perpendicular distance for a point off a horizontal segment", () => {
        expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBeCloseTo(3, 5);
    });

    it("clamps to the nearest endpoint when the point is off the segment's extent", () => {
        // Beyond the (10, 0) end of a horizontal segment — nearest point is the endpoint.
        expect(distanceToSegment(15, 0, 0, 0, 10, 0)).toBeCloseTo(5, 5);
    });

    it("handles a zero-length segment as a point-to-point distance", () => {
        expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 5);
    });

    it("is consistent with the hit-tolerance used by Trendline.hitTest", () => {
        // A point just inside tolerance of a diagonal segment should read as a hit.
        const onLine = distanceToSegment(5, 5.0 + HIT_TOLERANCE_PX - 1, 0, 0, 10, 10);
        expect(onLine).toBeLessThan(HIT_TOLERANCE_PX);
    });
});

// hitTestAnchorIndex backs the anchor-handle-grab detection every primitive's
// hitTest does when selected — this is what makes drag-to-edit possible
// (mousedown resolves to a specific anchor index, or falls through to a
// plain shape-body hit). Pinned in isolation for the same reason as
// distanceToSegment above.
describe("hitTestAnchorIndex", () => {
    it("returns the index of the anchor within tolerance", () => {
        const anchors = [{ x: 10, y: 10 }, { x: 100, y: 50 }];
        expect(hitTestAnchorIndex(anchors, 100, 50)).toBe(1);
        expect(hitTestAnchorIndex(anchors, 10, 10)).toBe(0);
    });

    it("returns the anchor index for a point just inside ANCHOR_HANDLE_SIZE tolerance", () => {
        const anchors = [{ x: 0, y: 0 }];
        expect(hitTestAnchorIndex(anchors, ANCHOR_HANDLE_SIZE - 1, 0)).toBe(0);
    });

    it("returns null when no anchor is within tolerance", () => {
        const anchors = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
        expect(hitTestAnchorIndex(anchors, 50, 50)).toBeNull();
    });

    it("skips null anchor entries (off-screen anchors)", () => {
        const anchors = [null, { x: 20, y: 20 }];
        expect(hitTestAnchorIndex(anchors, 20, 20)).toBe(1);
        expect(hitTestAnchorIndex(anchors, 0, 0)).toBeNull();
    });

    it("returns an empty result for an empty anchor list", () => {
        expect(hitTestAnchorIndex([], 0, 0)).toBeNull();
    });
});

describe("anchorExternalId / parseAnchorExternalId", () => {
    it("round-trips a drawing id and anchor index", () => {
        const id = anchorExternalId("dr_abc123", 1);
        expect(parseAnchorExternalId(id)).toEqual({ drawingId: "dr_abc123", anchorIndex: 1 });
    });

    it("round-trips anchor index 0 (falsy, must not be dropped)", () => {
        const id = anchorExternalId("dr_xyz", 0);
        expect(parseAnchorExternalId(id)).toEqual({ drawingId: "dr_xyz", anchorIndex: 0 });
    });

    it("returns null for a plain (non-anchor) externalId, e.g. a shape-body hit", () => {
        expect(parseAnchorExternalId("dr_abc123")).toBeNull();
    });

    it("returns null for garbage input", () => {
        expect(parseAnchorExternalId("")).toBeNull();
        expect(parseAnchorExternalId("not-an-id-at-all")).toBeNull();
    });
});
