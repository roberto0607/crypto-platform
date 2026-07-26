// Shared render-target typing + anchor-handle drawing, reused by every
// drawing-tool primitive in this directory. Mirrors the local MediaScope/
// RenderTarget interfaces duplicated across bollingerFillPrimitive.ts /
// liquidationLevelsPrimitive.ts / vpvrPrimitive.ts — centralized here since
// all 6 (soon 8) drawing primitives share it, unlike those one-off cases.

export interface MediaScope {
    context: CanvasRenderingContext2D;
    mediaSize: { width: number; height: number };
}

export interface RenderTarget {
    useMediaCoordinateSpace<T>(f: (scope: MediaScope) => T): T;
}

export const ANCHOR_HANDLE_SIZE = 6;
export const HIT_TOLERANCE_PX = 4;

/** Selected-state anchor handle — small filled square, standard charting-tool
 * convention (TradingView/cTrader) for "this point is draggable." */
export function drawAnchorHandle(context: CanvasRenderingContext2D, x: number, y: number): void {
    const half = ANCHOR_HANDLE_SIZE / 2;
    context.save();
    context.fillStyle = "#00ff41";
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1;
    context.fillRect(x - half, y - half, ANCHOR_HANDLE_SIZE, ANCHOR_HANDLE_SIZE);
    context.strokeRect(x - half, y - half, ANCHOR_HANDLE_SIZE, ANCHOR_HANDLE_SIZE);
    context.restore();
}

/** Selected-state glow applied to a shape's stroke — brightens the line so a
 * selected drawing is visually distinct without changing its color identity. */
export function applySelectedGlow(context: CanvasRenderingContext2D, color: string): void {
    context.shadowColor = color;
    context.shadowBlur = 6;
}

export function distanceToSegment(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number,
): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
}
