import type { StoredDrawing } from "@/stores/drawingStore";
import { BaseDrawingPrimitive } from "./baseDrawingPrimitive";
import { HorizontalLinePrimitive } from "./horizontalLinePrimitive";
import { HorizontalRayPrimitive } from "./horizontalRayPrimitive";
import { VerticalLinePrimitive } from "./verticalLinePrimitive";
import { TrendlinePrimitive } from "./trendlinePrimitive";
import { RectanglePrimitive } from "./rectanglePrimitive";
import { FibonacciPrimitive } from "./fibonacciPrimitive";

/**
 * One primitive instance per drawing. `text` drawings are intentionally
 * excluded — Text Annotation renders as a DOM chip (see
 * TextAnnotationChip.tsx), not a canvas primitive, so it has no entry here.
 */
export function createDrawingPrimitive(drawing: StoredDrawing): BaseDrawingPrimitive<StoredDrawing> | null {
    switch (drawing.type) {
        case "hline":
            return new HorizontalLinePrimitive(drawing);
        case "hray":
            return new HorizontalRayPrimitive(drawing);
        case "vline":
            return new VerticalLinePrimitive(drawing);
        case "trendline":
            return new TrendlinePrimitive(drawing);
        case "rect":
            return new RectanglePrimitive(drawing);
        case "fib":
            return new FibonacciPrimitive(drawing);
        case "text":
            return null;
    }
}
