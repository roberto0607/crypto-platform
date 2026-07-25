import { useRef, useCallback } from "react";

// Order panel's horizontal-resize counterpart to DragHandle.tsx's vertical
// sub-panel resize (Gate 1). Same mousedown/mousemove/mouseup shape, X/width
// instead of Y/height — deliberately not sharing localStorage key/state
// with DragHandle's DEFAULT_HEIGHTS (different shape: one number, not a
// per-panel record).
const STORAGE_KEY = "tradr_order_panel_width";

export const DEFAULT_ORDER_PANEL_WIDTH = 360;
// Widen-only (Gate 1 design lock): the LIMIT-mode and TAKE PROFIT/STOP LOSS
// 2-column rows in UnifiedOrderPanel are tuned for ~160px columns at the
// current 360px width (see TradingPage.tsx's tr-pa-row/tr-ts-row comment) —
// shrinking below that risks clipping the amount/price fields and their
// unit labels. A responsive collapse back to a single column is out of
// scope for this pass; MIN_WIDTH is the floor until that's built.
const MIN_WIDTH = 360;

function clampWidth(width: number): number {
  // Max is 50% of the viewport, computed live (not a fixed constant like
  // DragHandle's MAX_HEIGHT) so it stays correct across window resizes.
  const max = window.innerWidth * 0.5;
  return Math.max(MIN_WIDTH, Math.min(max, width));
}

export function loadOrderPanelWidth(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (!Number.isNaN(parsed)) return clampWidth(parsed);
    }
  } catch { /* ignore */ }
  return DEFAULT_ORDER_PANEL_WIDTH;
}

function saveOrderPanelWidth(width: number) {
  try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* ignore */ }
}

interface HorizontalDragHandleProps {
  currentWidth: number;
  onWidthChange: (width: number) => void;
  onDragEnd: (width: number) => void;
}

export function HorizontalDragHandle({ currentWidth, onWidthChange, onDragEnd }: HorizontalDragHandleProps) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: currentWidth };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // The order panel sits at the grid's right edge, so dragging the
      // handle LEFT (negative clientX delta) should WIDEN it — invert vs.
      // DragHandle's vertical delta, which grows height downward.
      const delta = dragRef.current.startX - ev.clientX;
      onWidthChange(clampWidth(dragRef.current.startW + delta));
    };

    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (dragRef.current) {
        const delta = dragRef.current.startX - ev.clientX;
        const finalW = clampWidth(dragRef.current.startW + delta);
        dragRef.current = null;
        onDragEnd(finalW);
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [currentWidth, onWidthChange, onDragEnd]);

  return (
    <div
      onMouseDown={onMouseDown}
      style={{
        gridArea: "drag",
        width: 6, cursor: "ew-resize", background: "#1a1a1a",
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "#2a2a2a"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a1a"; }}
      title="Drag to resize"
    >
      <div style={{ width: 2, height: 24, background: "#444", borderRadius: 1 }} />
    </div>
  );
}

export { saveOrderPanelWidth };
