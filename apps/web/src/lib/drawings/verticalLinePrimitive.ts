import type { IPrimitivePaneView, PrimitiveHoveredItem } from "lightweight-charts";
import type { StoredDrawing } from "@/stores/drawingStore";
import { BaseDrawingPrimitive } from "./baseDrawingPrimitive";
import {
    type MediaScope,
    type RenderTarget,
    HIT_TOLERANCE_PX,
    drawAnchorHandle,
    applySelectedGlow,
    hitTestAnchorIndex,
    anchorExternalId,
} from "./drawingPrimitiveShared";

/** Vertical Line — price-independent, spans the full pane height at a fixed
 * time. The anchor's `price` is kept only to place the drag handle. */
class VerticalLinePaneView implements IPrimitivePaneView {
    constructor(private _primitive: VerticalLinePrimitive) {}

    zOrder(): "top" {
        return "top";
    }

    renderer() {
        const primitive = this._primitive;
        return {
            draw(target: RenderTarget) {
                const chart = primitive.chart;
                const series = primitive.series;
                if (!chart || !series) return;
                const point = primitive.data.points[0];
                if (!point) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }: MediaScope) => {
                    const x = chart.timeScale().timeToCoordinate(point.time as never);
                    if (x == null) return;

                    context.save();
                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.beginPath();
                    context.moveTo(x, 0);
                    context.lineTo(x, mediaSize.height);
                    context.stroke();
                    context.restore();

                    if (primitive.selected) {
                        const y = series.priceToCoordinate(point.price) ?? mediaSize.height / 2;
                        drawAnchorHandle(context, x, y);
                    }
                });
            },
        };
    }
}

export class VerticalLinePrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new VerticalLinePaneView(this)];

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }

    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const chart = this.chart;
        const series = this.series;
        const point = this.data.points[0];
        if (!chart || !series || !point) return null;
        const lineX = chart.timeScale().timeToCoordinate(point.time as never);
        if (lineX == null) return null;

        if (this.selected) {
            const handleY = series.priceToCoordinate(point.price);
            const anchorIdx = hitTestAnchorIndex([handleY != null ? { x: lineX, y: handleY } : null], x, y);
            if (anchorIdx != null) {
                return { externalId: anchorExternalId(this.data.id, anchorIdx), zOrder: "top", cursorStyle: "move" };
            }
        }

        if (Math.abs(x - lineX) > HIT_TOLERANCE_PX) return null;
        return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
    }
}
