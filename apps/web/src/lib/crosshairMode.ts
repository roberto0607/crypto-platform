import { CrosshairMode } from "lightweight-charts";

/**
 * Trade-page crosshair mode, driven by the drawing toolbar's Magnet toggle
 * (drawingStore.snapEnabled) — one switch for crosshair AND drawing snapping,
 * like TradingView. Off (the default) = Normal: the horizontal line and
 * right-axis price label follow the mouse exactly. On = Magnet: they snap to
 * the hovered candle's price. Either way the vertical line lands on candle
 * times. Set explicitly because lightweight-charts defaults to Magnet.
 */
export function crosshairModeFor(snapEnabled: boolean): CrosshairMode {
    return snapEnabled ? CrosshairMode.Magnet : CrosshairMode.Normal;
}
