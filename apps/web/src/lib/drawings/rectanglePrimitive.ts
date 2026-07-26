import type { IPrimitivePaneView, PrimitiveHoveredItem } from "lightweight-charts";
import type { StoredDrawing } from "@/stores/drawingStore";
import { BaseDrawingPrimitive } from "./baseDrawingPrimitive";
import {
    type MediaScope,
    type RenderTarget,
    drawAnchorHandle,
    applySelectedGlow,
} from "./drawingPrimitiveShared";

function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace("#", "");
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Rectangle — filled + bordered quad between two opposite (time, price)
 * corners. Same polygon-fill approach as BollingerFillPaneView, just a fixed
 * 4-corner path instead of N band points; low fill alpha so candles read
 * through, matching the fill convention already established there. */
class RectanglePaneView implements IPrimitivePaneView {
    constructor(private _primitive: RectanglePrimitive) {}

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

                    const left = Math.min(x0, x1);
                    const right = Math.max(x0, x1);
                    const top = Math.min(y0, y1);
                    const bottom = Math.max(y0, y1);

                    context.save();
                    context.fillStyle = hexToRgba(primitive.data.color, 0.15);
                    context.fillRect(left, top, right - left, bottom - top);

                    if (primitive.selected) applySelectedGlow(context, primitive.data.color);
                    context.strokeStyle = primitive.data.color;
                    context.lineWidth = primitive.selected ? 2 : 1.5;
                    context.strokeRect(left, top, right - left, bottom - top);
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

export class RectanglePrimitive extends BaseDrawingPrimitive<StoredDrawing> {
    private _paneViews = [new RectanglePaneView(this)];

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

        const left = Math.min(x0, x1);
        const right = Math.max(x0, x1);
        const top = Math.min(y0, y1);
        const bottom = Math.max(y0, y1);
        if (x < left || x > right || y < top || y > bottom) return null;
        return { externalId: this.data.id, zOrder: "top", cursorStyle: "pointer" };
    }
}
