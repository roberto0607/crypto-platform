import type { IPrimitivePaneView, PrimitiveHoveredItem } from "lightweight-charts";
import type { StoredDrawing } from "@/stores/drawingStore";
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

/** Trend Line — a straight segment between two (time, price) anchors. */
class TrendlinePaneView implements IPrimitivePaneView {
    constructor(private _primitive: TrendlinePrimitive) {}

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
                    const y0 = series.priceToCoordinate(p0.price);
                    const x1 = timeScale.timeToCoordinate(p1.time as never);
                    const y1 = series.priceToCoordinate(p1.price);
                    if (x0 == null || y0 == null || x1 == null || y1 == null) return;

                    context.save();
                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.beginPath();
                    context.moveTo(x0, y0);
                    context.lineTo(x1, y1);
                    context.stroke();
                    context.restore();

                    if (primitive.selected) {
                        drawAnchorHandle(context, x0, y0);
                        drawAnchorHandle(context, x1, y1);
                    }
                });
            },
        };
    }
}

export class TrendlinePrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new TrendlinePaneView(this)];

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
        const y0 = series.priceToCoordinate(p0.price);
        const x1 = timeScale.timeToCoordinate(p1.time as never);
        const y1 = series.priceToCoordinate(p1.price);
        if (x0 == null || y0 == null || x1 == null || y1 == null) return null;

        if (this.selected) {
            const anchorIdx = hitTestAnchorIndex([{ x: x0, y: y0 }, { x: x1, y: y1 }], x, y);
            if (anchorIdx != null) {
                return { externalId: anchorExternalId(this.data.id, anchorIdx), zOrder: "top", cursorStyle: "move" };
            }
        }

        if (distanceToSegment(x, y, x0, y0, x1, y1) > HIT_TOLERANCE_PX) return null;
        return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
    }
}
