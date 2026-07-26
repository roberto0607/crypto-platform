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

/** Horizontal Line — time-independent, spans the full pane width at a fixed
 * price. The anchor's `time` is kept only to place the drag handle when
 * selected; it plays no role in where the line renders. */
class HorizontalLinePaneView implements IPrimitivePaneView {
    constructor(private _primitive: HorizontalLinePrimitive) {}

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
                    if (y == null) return;

                    context.save();
                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.beginPath();
                    context.moveTo(0, y);
                    context.lineTo(mediaSize.width, y);
                    context.stroke();
                    context.restore();

                    if (primitive.selected) {
                        const x = chart.timeScale().timeToCoordinate(point.time as never) ?? mediaSize.width / 2;
                        drawAnchorHandle(context, x, y);
                    }
                });
            },
        };
    }
}

export class HorizontalLinePrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new HorizontalLinePaneView(this)];

    paneViews(): readonly IPrimitivePaneView[] {
        return this._paneViews;
    }

    hitTest(_x: number, y: number): PrimitiveHoveredItem | null {
        const series = this.series;
        const point = this.data.points[0];
        if (!series || !point) return null;
        const lineY = series.priceToCoordinate(point.price);
        if (lineY == null) return null;
        if (Math.abs(y - lineY) > HIT_TOLERANCE_PX) return null;
        return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
    }
}
