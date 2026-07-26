import { describe, it, expect } from "vitest";
import { distanceToSegment, HIT_TOLERANCE_PX } from "@/lib/drawings/drawingPrimitiveShared";

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
