import type { IPrimitivePaneView, PrimitiveHoveredItem } from "lightweight-charts";
import type { StoredDrawing } from "@/stores/drawingStore";
import { BaseDrawingPrimitive } from "./baseDrawingPrimitive";
import {
    type MediaScope,
    type RenderTarget,
    HIT_TOLERANCE_PX,
    drawAnchorHandle,
    applySelectedGlow,
} from "./drawingPrimitiveShared";

/** Horizontal Ray — bounded on the left by its anchor time, extends right to
 * the pane edge. */
class HorizontalRayPaneView implements IPrimitivePaneView {
    constructor(private _primitive: HorizontalRayPrimitive) {}

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
                const point = primitive.data.points[0];
                if (!point) return;

                target.useMediaCoordinateSpace(({ context, mediaSize }: MediaScope) => {
                    const y = series.priceToCoordinate(point.price);
                    const x = chart.timeScale().timeToCoordinate(point.time as never);
                    if (y == null || x == null) return;

                    context.save();
                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.beginPath();
                    context.moveTo(x, y);
                    context.lineTo(mediaSize.width, y);
                    context.stroke();
                    context.restore();

                    if (primitive.selected) drawAnchorHandle(context, x, y);
                });
            },
        };
    }
}

export class HorizontalRayPrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new HorizontalRayPaneView(this)];

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }

    hitTest(x: number, y: number): PrimitiveHoveredItem | null {
        const series = this.series;
        const chart = this.chart;
        const point = this.data.points[0];
        if (!series || !chart || !point) return null;
        const lineY = series.priceToCoordinate(point.price);
        const startX = chart.timeScale().timeToCoordinate(point.time as never);
        if (lineY == null || startX == null) return null;
        if (x < startX) return null;
        if (Math.abs(y - lineY) > HIT_TOLERANCE_PX) return null;
        return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
    }
}
