import type { IPrimitivePaneView, PrimitiveHoveredItem } from "lightweight-charts";
import type { StoredDrawing, DrawingPoint } from "@/stores/drawingStore";
import { BaseDrawingPrimitive } from "./baseDrawingPrimitive";
import {
    type MediaScope,
    type RenderTarget,
    HIT_TOLERANCE_PX,
    drawAnchorHandle,
    applySelectedGlow,
    distanceToSegment,
    hitTestAnchorIndex,
    anchorExternalId,
} from "./drawingPrimitiveShared";

// Standard retracement levels only — 1.272/1.618 extensions are a deliberate
// fast-follow (need extrapolation beyond the two anchors, a different formula
// from interpolation, not just another entry in this list).
export const FIB_LEVELS: readonly number[] = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export interface FibLevel {
    level: number;
    price: number;
}

/** Derives each level's price from the two anchors — never stored, so
 * anchor-drag repositioning "just works" for free (the existing drag
 * machinery only ever moves `points[i]`, and every level recomputes from
 * that on next repaint). */
export function computeFibLevels(p0: DrawingPoint, p1: DrawingPoint): FibLevel[] {
    return FIB_LEVELS.map((level) => ({
        level,
        price: p0.price + level * (p1.price - p0.price),
    }));
}

class FibonacciPaneView implements IPrimitivePaneView {
    constructor(private _primitive: FibonacciPrimitive) {}

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const primitive = this._primitive;
        return {
            draw(target: RenderTarget) {
                const series = primitive.series;
                const chart = primitive.chart;
                if (!series || !chart) return;
                const [p0, p1] = primitive.data.points;
                if (!p0 || !p1) return;

                target.useMediaCoordinateSpace(({ context }: MediaScope) => {
                    const timeScale = chart.timeScale();
                    const x0 = timeScale.timeToCoordinate(p0.time as never);
                    const x1 = timeScale.timeToCoordinate(p1.time as never);
                    if (x0 == null || x1 == null) return;
                    const left = Math.min(x0, x1);
                    const right = Math.max(x0, x1);

                    context.save();
                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.fillStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.font = "10px monospace";
                    context.textBaseline = "middle";
                    context.textAlign = "left";

                    for (const { level, price } of computeFibLevels(p0, p1)) {
                        const y = series.priceToCoordinate(price);
                        if (y == null) continue;
                        context.beginPath();
                        context.moveTo(left, y);
                        context.lineTo(right, y);
                        context.stroke();
                        context.fillText(`${(level * 100).toFixed(1)}%  ${price.toFixed(2)}`, right + 4, y);
                    }
                    context.restore();

                    if (primitive.selected) {
                        const y0 = series.priceToCoordinate(p0.price);
                        const y1 = series.priceToCoordinate(p1.price);
                        if (y0 != null) drawAnchorHandle(context, x0, y0);
                        if (y1 != null) drawAnchorHandle(context, x1, y1);
                    }
                });
            },
        };
    }
}

export class FibonacciPrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new FibonacciPaneView(this)];

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }

    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const series = this.series;
        const chart = this.chart;
        const [p0, p1] = this.data.points;
        if (!series || !chart || !p0 || !p1) return null;
        const timeScale = chart.timeScale();
        const x0 = timeScale.timeToCoordinate(p0.time as never);
        const x1 = timeScale.timeToCoordinate(p1.time as never);
        if (x0 == null || x1 == null) return null;
        const left = Math.min(x0, x1);
        const right = Math.max(x0, x1);

        if (this.selected) {
            const y0 = series.priceToCoordinate(p0.price);
            const y1 = series.priceToCoordinate(p1.price);
            const anchorIdx = hitTestAnchorIndex(
                [y0 != null ? { x: x0, y: y0 } : null, y1 != null ? { x: x1, y: y1 } : null],
                x, y,
            );
            if (anchorIdx != null) {
                return { externalId: anchorExternalId(this.data.id, anchorIdx), zOrder: "top", cursorStyle: "move" };
            }
        }

        for (const { price } of computeFibLevels(p0, p1)) {
            const levelY = series.priceToCoordinate(price);
            if (levelY == null) continue;
            if (distanceToSegment(x, y, left, levelY, right, levelY) <= HIT_TOLERANCE_PX) {
                return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
            }
        }
        return null;
    }
}
