# Gate 1 Design Lock: Chart Drawing Tools (First Pass — 6 Tools)

Status: **DESIGN ONLY — awaiting sign-off before implementation.**
Scope: Horizontal Line, Horizontal Ray, Vertical Line, Text Annotation, Trendline,
Rectangle. **Fibonacci Retracement and Parallel Channel are explicitly OUT of this
pass** (see §8).

Builds on the Gate 0 recon (`docs/designs/` — drawing-tools recon, unfiled but
referenced throughout this doc): `lightweight-charts@5.1.0` has no built-in
drawing support; `subscribeClick`/`hitTest`/`coordinateToPrice`/`coordinateToTime`
are confirmed-available and confirmed-unused-until-now; the `*Primitive.ts`
rendering pattern is reusable but the interaction layer is new.

Resolved decisions (given, not re-litigated here):
1. Persistence: localStorage, per-user-per-pair, no backend table this pass.
2. Left-edge icon strip becomes part of chart layout (pushes plot area inward),
   not an absolute overlay competing with the legend-chip stack.
3. 6 of 8 tools in scope; infrastructure designed so Fib/Channel are a fast-follow.

---

## 1. Drawing-mode state machine

```
IDLE ──(click tool icon)──► TOOL_SELECTED ──(click #1 on chart)──► PLACING
  ▲                              │                                    │
  │                         (click icon again,                  (click #2,
  │                          or Esc)                              or for
  │                              │                              single-anchor
  │                              ▼                              tools, click #1
  └──────────────────────────  IDLE                              IS the commit)
                                                                       │
                                                                       ▼
                                                                  COMMITTED
                                                              (drawing added to
                                                               list, tool auto-
                                                               deselects → IDLE,
                                                               new drawing enters
                                                               SELECTED)
                                                                       │
                                            ┌──────────────────────────┤
                                            ▼                          ▼
                                       SELECTED                   (click empty
                                  (click on existing                 chart
                                   drawing's hitTest                 area) →
                                   region)                        DESELECTED
                                            │
                              ┌─────────────┼──────────────┐
                              ▼             ▼              ▼
                        DRAGGING_ANCHOR  Delete key    click elsewhere
                        (mousedown on    → removed,    → DESELECTED
                         an anchor,      back to IDLE
                         drag, mouseup   selection
                         commits new     state
                         position)
```

State lives in one new store: `useDrawingStore` (zustand, same pattern as
`tradingStore.ts`), scoped fields:
- `activeTool: DrawingToolType | null` (TOOL_SELECTED / PLACING collapse into
  this — `pendingPoints` distinguishes them)
- `pendingPoints: { time: number; price: number }[]` — points placed so far
  for the in-progress drawing (empty = TOOL_SELECTED, 1 point = mid-placement
  for two-point tools)
- `drawings: Drawing[]` — committed drawings for the current pair
- `selectedDrawingId: string | null`
- `draggingAnchor: { drawingId: string; anchorIndex: number } | null`

This mirrors `indicatorConfig` in `tradingStore.ts` in spirit (a config-shaped
slice) but drawings need imperative click/drag wiring a plain boolean toggle
doesn't, so it's a separate store rather than added to `tradingStore`.

**Crosshair/hover interaction — confirmed via reading `usePanelCrosshairHover.ts`
and the main chart's `subscribeCrosshairMove` in `CandlestickChart.tsx`:**
They **coexist, unchanged**. `subscribeCrosshairMove` (OHLCV readout, sub-panel
hover projection) and the new `subscribeClick` handler are independent
lightweight-charts subscriptions — the library fires both on every relevant
mouse event, and nothing about attaching one affects the other. The OHLCV
readout should keep working identically while a drawing tool is active (matches
TradingView's own behavior — crosshair readout doesn't disappear while drawing).
The only thing that changes is **pan/zoom** (see §2), never the crosshair
subscriptions.

---

## 2. Interaction layer

**Wiring**, all inside `CandlestickChart.tsx` where `chart`/`series` are already
in scope (same effect that currently does `chart.subscribeCrosshairMove(...)`
at line ~618):

```ts
chart.subscribeClick((param) => {
  const tool = useDrawingStore.getState().activeTool;
  if (!tool) {
    // Not drawing — treat as a hit-test against existing drawings for
    // select/deselect (see §4).
    return handleSelectionClick(param);
  }
  if (param.time == null || param.point == null) return;
  const price = series.coordinateToPrice(param.point.y);
  if (price == null) return;
  useDrawingStore.getState().addPoint({ time: param.time as number, price });
});
```

Drag (Trendline/Rectangle need a live preview between mousedown and mouseup —
`subscribeClick` alone can't show a rubber-band preview) uses raw DOM events on
the **container div** (`containerRef.current`), not chart-level subscriptions,
because lightweight-charts has no `subscribeMouseMove`-during-drag primitive —
only click/dblclick and crosshair-move (which fires on every hover regardless
of mouse-button state, so it's not drag-specific but IS reusable as the
"cursor moved" signal during a drag):

```ts
// On first click (tool active, pendingPoints.length === 1): start listening
// to the EXISTING chart.subscribeCrosshairMove to update a "preview" primitive
// (ghost line/rect at cursor position) until the second click commits it.
// This reuses the crosshair subscription already firing — no new mousemove
// listener needed for the preview itself.
```

So concretely: **no new raw `mousemove` listener** is needed even for
drag-preview — `subscribeCrosshairMove` already fires continuously while the
mouse moves over the chart (that's how the OHLCV readout tracks the cursor
today), and a drawing-in-progress can piggyback on it purely to update a
preview primitive's endpoint, without interfering with the OHLCV-readout
handler already subscribed. Two independent `subscribeCrosshairMove`
handlers, same pattern as `usePanelCrosshairHover`'s main + own dual
subscription already does.

**Pan/zoom lock — yes, disable while actively drawing**, matching the recon's
prediction and TradingView's own convention. Confirmed current chart creation
(`CandlestickChart.tsx` ~line 509) does **not** currently override
`handleScroll`/`handleScale`, so they're at library defaults (both enabled).
Design:

```ts
useEffect(() => {
  if (!chartRef.current) return;
  const drawing = activeTool !== null; // TOOL_SELECTED or PLACING
  chartRef.current.applyOptions({
    handleScroll: !drawing,
    handleScale: !drawing,
  });
}, [activeTool]);
```

Scoped narrowly to "a tool is selected/mid-placement" — not while a drawing is
merely SELECTED (a user should still be able to pan/zoom to look at a selected
trendline from a different part of the chart without losing the selection).
Dragging an anchor (`DRAGGING_ANCHOR`) also needs pan/zoom disabled for the
duration of that specific drag, same mechanism.

**Esc key** cancels PLACING (clears `pendingPoints`, returns to IDLE) —
standard charting-tool convention, and cheap to add as a `keydown` listener
alongside the Delete-key handler in §4.

---

## 3. Per-tool primitive design

All six are new files in `apps/web/src/lib/drawings/`, one primitive class
each, following the `BollingerFillPrimitive`/`VPVRPrimitive` shape
(`ISeriesPrimitive<Time>`, a `PaneView` holding a `renderer()` that draws to
canvas via `useMediaCoordinateSpace`). Unlike the existing primitives, each
also implements `hitTest(x, y): PrimitiveHoveredItem | null` (interface
already supports this — confirmed in typings, unused until now) and takes a
**generic `DrawingPrimitive<T extends Drawing>` base pattern** to share
anchor-storage/select-state boilerplate:

```ts
abstract class BaseDrawingPrimitive<T extends Drawing> implements ISeriesPrimitive<Time> {
  protected data: T;
  protected selected: boolean;
  protected series: ISeriesApi<"Candlestick"> | null = null;
  protected chart: IChartApi | null = null;
  // ... attached/detached/paneViews boilerplate, shared by all 6+2(future)
  abstract paneViews(): readonly IPrimitivePaneView[]; // per-tool render + hitTest
}
```

One primitive **instance per drawing** (not one primitive per tool type
shared across all drawings of that type) — matches how `attachPrimitive` is
called per-indicator today, just multiplied: `useDrawingStore`'s `drawings[]`
array drives a `useEffect` in `CandlestickChart.tsx` that keeps
`series.attachPrimitive`/`detachPrimitive` in sync with the array (attach new,
detach removed — same diffing idea already used for toggling indicators
on/off via `setData([])`, just attach/detach instead since these aren't
always-on).

| Tool | Anchors | Render logic | hitTest |
|---|---|---|---|
| **Horizontal Line** | 1 `{price}` (time-independent) | Full-width line at `series.priceToCoordinate(price)` | `\|y - lineY\| < 4px`, any x |
| **Horizontal Ray** | 1 `{time, price}` | Line from `timeToCoordinate(time)` to right edge, at `priceToCoordinate(price)` | `\|y - lineY\| < 4px && x >= startX` |
| **Vertical Line** | 1 `{time}` | Full-height line at `timeToCoordinate(time)` | `\|x - lineX\| < 4px`, any y |
| **Text Annotation** | 1 `{time, price}` + `text: string` | DOM overlay chip (NOT canvas — reuses the VWAP/BB legend-chip `position:absolute` pattern already in `CandlestickChart.tsx`, positioned via `priceToCoordinate`/`timeToCoordinate` each render), not a primitive at all | DOM click handler on the chip itself, no canvas hitTest needed |
| **Trendline** | 2 `{time, price}` | Straight line between the two coordinate pairs (same geometry `BollingerFillPaneView` already does per-point, just 2 points not N) | Point-to-line-segment distance < 4px |
| **Rectangle** | 2 `{time, price}` (opposite corners) | Filled + bordered quad — **directly reuses `BollingerFillPaneView`'s polygon-fill approach** (build a path from the 4 corners via `priceToCoordinate`/`timeToCoordinate`, `context.fill()` + `context.stroke()`) | Point-in-rect test (`x` between the two `timeToCoordinate` values, `y` between the two `priceToCoordinate` values) |

Text Annotation is the one outlier — it's a DOM element (an editable `<div>`
chip), not a canvas primitive, because canvas text editing (cursor, selection,
IME) is a much bigger problem than reusing React's native text input. This
mirrors why the existing legend chips are DOM, not primitives.

---

## 4. Selection/edit/delete UX

**Select**: click on canvas when no tool is active → `handleSelectionClick`
iterates `drawings[]` in reverse z-order (topmost first) calling each
primitive's `hitTest(x, y)`; first non-null hit sets `selectedDrawingId`.
Click on empty space clears it.

**Visual affordance for "selected"** — checked the codebase for an existing
convention: nothing analogous exists today (no other canvas-rendered object
in this app is user-selectable; the closest things, indicator toggle buttons
and timeframe buttons, use the `active`-class green-fill convention from
`TradeToolbar.tsx`/`IndicatorToolbar.tsx`, which is a *toggle* state not an
*object selection* state). Designing a new one, kept consistent with the
existing accent-color language:
- Selected drawing's stroke color brightens / gets a subtle glow (e.g.
  `shadowBlur` in the canvas render when `selected`)
- Small square anchor handles (6×6px, `#00ff41` fill, white border) drawn at
  each anchor point when selected — standard charting-tool convention
  (TradingView, cTrader, etc. all do exactly this), not inventing something
  unusual as the brief asked
- These handles are themselves drag targets: `hitTest` on a selected
  primitive additionally checks proximity to each anchor handle, returning a
  distinguishable hit (e.g. `{ ...hit, externalId: "anchor-0" }`) so
  `handleSelectionClick`'s caller can tell "start dragging anchor 0" apart
  from "select the whole shape"

**Drag an anchor**: mousedown on an anchor handle (detected via the hitTest
above) → `draggingAnchor` set → subsequent `subscribeCrosshairMove` events (the
same subscription already firing for OHLCV readout) update that anchor's
`{time, price}` live → mouseup (via `subscribeClick`, since a click event
fires on mouseup) commits the final position to the store and clears
`draggingAnchor`.

**Delete**: **both** mechanisms, matching common charting-tool UX (the brief
asked to confirm against convention rather than invent something unusual —
TradingView supports both Delete-key and a right-click/toolbar delete, so
this does too):
- `Delete`/`Backspace` keydown while `selectedDrawingId` is set → remove it
- A small delete-icon (×) rendered as a DOM chip near the selected shape's
  first anchor (same absolute-positioned convention as the legend chips),
  visible only when selected — covers touchpad/no-keyboard-focus cases

---

## 5. Coordinate anchor-snapping

**Snap to the nearest candle's time.** Confirmed reasoning: price levels and
trendlines are conventionally meant to align with actual candle
opens/closes/wicks (this is standard TA practice — a trendline "through the
candle body" only makes visual sense if its anchor times match real candles),
and floating freely would make re-render after a timeframe switch look
subtly wrong (the same time value maps to a different x position once the
candle grid changes resolution, but a candle-index-anchored point degrades
more gracefully — see §6 on why we store raw time/price rather than index,
though).

Reuses the **STEP-lookup** variant already established in
`usePanelCrosshairHover.ts` (used today by Funding/OI panels for sparse
series): given `coordinateToTime(x)`, find the last candle in the currently
loaded dataset with `candle.time <= resolvedTime`, and use that candle's exact
`time` as the anchor instead of the raw (possibly-between-candles) value
`coordinateToTime` returned. Price is **not** snapped (users routinely draw
horizontal lines at prices between the candle's O/H/L/C, e.g. a round number
like 50000) — only the time axis snaps.

**UPDATE (found during commit 2's Playwright verification): this snapping is
not just a UX nicety — it's load-bearing for rendering at all.** Empirically
confirmed `timeScale().timeToCoordinate()` returns `null` for a time that
doesn't exactly match one of the series' actual bar times — it does **not**
interpolate between bars the way `priceToCoordinate` tolerates arbitrary
prices. Every existing primitive in this codebase (VPVR, Bollinger fill,
liquidation levels, footprint) happened to only ever call it with a real
candle's own `time` value, so this constraint never surfaced before now.
Practical consequence: the placement flow (commit 3) must snap `time` to an
exact loaded-candle boundary **before** committing a point to the store, not
just as a display nicety — an unsnapped point silently fails to render
(verified: Horizontal Line, whose main line only needs `priceToCoordinate`,
rendered fine with an unsnapped time; Horizontal Ray/Vertical Line/
Trendline/Rectangle, which all need `timeToCoordinate`, silently rendered
nothing until times were corrected to exact candle boundaries).

---

## 6. localStorage schema

Key: `tradr_drawings_{pairId}` (pairId, not symbol — matches how
`tradingStore` already keys per-pair state elsewhere, and survives a symbol
rename cleanly). Separate key per pair (not one blob keyed internally) so a
single pair's drawings can be read/written without parsing every other pair's
data — same granularity reasoning as `tradr_panel_heights`.

```ts
interface StoredDrawing {
  id: string;              // uuid, client-generated
  type: "hline" | "hray" | "vline" | "text" | "trendline" | "rect";
  points: { time: number; price: number }[]; // 1 or 2 entries depending on type
  text?: string;           // only for type "text"
  color: string;           // hex, user-pickable later; a sane default per type for now
  createdAt: number;       // epoch ms, not load-bearing, just useful for debugging
}

interface DrawingsStorageShape {
  version: number;
  drawings: StoredDrawing[];
}
```

Anchors are stored in **price/time space, never screen pixels** — confirmed
necessary per the recon (screen coordinates are meaningless after a pan/zoom
or reload; price/time round-trips correctly through
`priceToCoordinate`/`timeToCoordinate` regardless of the current viewport).

**Versioning**: mirrors `INDICATOR_CONFIG_VERSION` exactly
(`tradingStore.ts` — `INDICATOR_STORAGE_KEY`/`INDICATOR_VERSION_KEY`/
`INDICATOR_CONFIG_VERSION`, bump-and-wipe-stale-data pattern). New constants:
`DRAWINGS_SCHEMA_VERSION = 1`, stored per-key as
`tradr_drawings_{pairId}_version` (or embedded as the `version` field inside
the JSON blob itself — embedding is slightly better here since it's already
per-pair-keyed rather than one global key, avoiding N extra localStorage keys
for N pairs). On load, a version mismatch wipes that pair's drawings only
(not every pair's, unlike the indicator config's single global wipe) — smaller
blast radius, and appropriate since a future schema change (e.g. adding Fib's
extra fields) shouldn't need to nuke a user's Rectangle on BTC just because
ETH's Fib format changed... though since all pairs share one schema version
in practice, a global bump is simplest and matches precedent most closely.
**Open question for implementation**: global bump (simpler, matches
`INDICATOR_CONFIG_VERSION` precedent exactly) vs. per-pair embedded version
(smaller blast radius). Lean toward matching precedent (global) unless told
otherwise — consistency with the one existing convention in this codebase
outweighs the marginal blast-radius benefit.

---

## 7. Left-edge icon strip

**Layout mechanics**: confirmed the chart container today is
`<div ref={containerRef} className="absolute inset-0" />` (line ~1601) inside
a positioned parent, with a `ResizeObserver` (line ~652) driving
`chart.applyOptions({ width, height })` off that container's observed size.
Plan: wrap `containerRef`'s parent in a flex row —

```
<div style={{ display: "flex", height: "100%" }}>
  <DrawingToolStrip />                              {/* fixed width, e.g. 36px */}
  <div style={{ position: "relative", flex: 1 }}>
    <div ref={containerRef} className="absolute inset-0" />
    {/* existing legend chips, crosshair readout, etc. unchanged, still left:12
        but now left:12 relative to the shrunk chart area, not the old full width */}
  </div>
</div>
```

No manual width math needed elsewhere — the existing `ResizeObserver` already
recomputes `chart.applyOptions({ width })` from the container's actual
`clientWidth`, and since the container is now a flex child instead of filling
the whole card, it automatically shrinks by exactly the strip's width. This
is why decision #2 (push the plot area inward) is cheap: the resize plumbing
already reacts to container size, it doesn't need to know *why* the container
got narrower.

**Icons** — new file `apps/web/src/components/trading/DrawingToolIcons.tsx`,
same dependency-free inline-SVG convention as `NavIcon.tsx` (16×16 viewBox,
`stroke="currentColor"`, `strokeWidth={1.4}`, round caps/joins — confirmed
this is the established pattern, no icon library exists anywhere in this
codebase):

- Horizontal Line: `<line x1="2" y1="8" x2="14" y2="8" />`
- Horizontal Ray: same line but only from x=6 to x=14 (visually implies
  "starts here, extends right")
- Vertical Line: `<line x1="8" y1="2" x2="8" y2="14" />`
- Text Annotation: a simple "T" glyph or `<path>` outline
- Trendline: a diagonal `<line x1="2" y1="13" x2="14" y2="3" />` with small
  circle endpoints (`<circle r="1.5">` at each end) to visually distinguish
  from Horizontal/Vertical Line
- Rectangle: `<rect x="2.5" y="4.5" width="11" height="7" />`

**Active-tool styling** — reuses the exact `active` convention from
`IndicatorToolbar.tsx`'s toggle rows / `TradeToolbar.tsx`'s `.tr-tb-tf-btn.active`
(green fill `#00ff41` background, black icon, vs. transparent
background + `rgba(255,255,255,0.85)` icon when idle) — no new visual
language invented, matches what's already established for "this control is
currently on."

**Strip container CSS** — new `.tr-draw-strip` class, injected via the same
"CSS-in-a-template-string-injected-once" convention as `TOOLBAR_CSS`/
`CONTEXT_BAR_CSS`: vertical flex column, 36px wide, icons stacked with small
gaps, sits flush against the chart's left edge, subtle right border to
visually separate it from the plot area (`border-right: 1px solid var(--border)`).

---

## 8. What this design already supports for Fibonacci/Parallel Channel, and what needs extending

**Already supports, no rework needed:**
- The state machine's `pendingPoints` array is unbounded-length-agnostic in
  principle — it's designed as "collect N points, then commit," and nothing
  about IDLE→TOOL_SELECTED→PLACING→COMMITTED assumes exactly 2 points. Fib
  needs 2 (same as Trendline). Channel needs 3.
- `BaseDrawingPrimitive<T>` is generic over the drawing's data shape — adding
  `FibDrawing { points: [p0, p1]; levels: number[] }` or
  `ChannelDrawing { points: [p0, p1, p2] }` is a new subclass, not a change to
  the base.
- `hitTest`/selection/anchor-dragging is per-primitive, so Fib/Channel just
  implement their own (Fib: hit-test against any of its N rendered level
  lines; Channel: hit-test against either of its two parallel lines, or the
  original trendline).
- Pan/zoom-lock, Esc-to-cancel, Delete-to-remove, localStorage schema
  (`StoredDrawing.points` is already an array, not a fixed tuple) — all
  generic across tool count, need zero changes.
- The left-edge icon strip is a simple array of tool defs
  (`icon`/`type`/`label`) — adding 2 more entries is not a layout change.

**Needs extending when picked up:**
- **Parallel Channel's 3rd point**: the state machine's PLACING state
  currently commits as soon as `pendingPoints.length` hits the tool's known
  arity (2 for everything in this pass). Channel needs a per-tool
  `requiredPoints` config (2 vs. 3) read from a `DRAWING_TOOL_SPECS` map
  rather than a hardcoded "2" — worth building that map with an explicit
  `requiredPoints` field now (even though every value is 2 in this pass) so
  Channel's `requiredPoints: 3` is a one-line addition later, not a
  state-machine rewrite.
- **Fibonacci's level computation + multi-line render**: net-new render logic
  (interpolate N% levels between the two anchors, render N labeled lines) —
  doesn't reuse Trendline's renderer as-is, needs its own, but fits the same
  `BaseDrawingPrimitive` shape.
- **Fib's level set may need to be user-configurable** (which percentages to
  show) — that's a settings surface this pass has no analog for (none of the
  6 in-scope tools have per-drawing configurable numeric params beyond
  color/text). Flag as a genuinely new UI need for that fast-follow, not
  something this pass's design covers.

**Recommendation**: build the `DRAWING_TOOL_SPECS` map (tool → icon → arity →
primitive class) now even though this pass only populates 6 entries, so the
fast-follow is "add 2 map entries + 2 primitive classes," not "refactor the
map from assumed-arity-2 to variable-arity."

---

## 9. Open questions — RESOLVED (2026-07-26)

1. **Versioning granularity**: **Global** version constant
   (`DRAWINGS_SCHEMA_VERSION`), matching `INDICATOR_CONFIG_VERSION`'s
   existing convention exactly — a bump wipes every pair's stored drawings,
   not just one. No per-pair embedded version.
2. **Color/style customization**: **out of scope this pass.** Each tool gets
   one fixed default color (no picker, no per-drawing override). Future
   follow-up if wanted later.
3. **Cross-device sync / backend persistence**: **confirmed out of scope**,
   localStorage-only as originally decided. (Kept as a design note: the
   `StoredDrawing` shape is flat JSON with no client-only references, so a
   future backend migration wouldn't require reshaping it.)
4. **Undo/redo**: **out of scope this pass.** Delete-key + delete-icon
   affordance is sufficient for v1. Noted here as an explicit future
   nice-to-have, not silently dropped.

---

## 10. Implementation plan (once reviewed)

New branch off latest `main` (not off `live-match-pnl-gate1` — this is
unrelated scope). Suggested commit sequence, each independently
typecheck-clean and buildable on the prior:

1. `useDrawingStore` (zustand) + `DRAWING_TOOL_SPECS` map + localStorage
   load/save (schema from §6), no UI yet.
2. `BaseDrawingPrimitive` + the 5 canvas-based primitive classes (Horizontal
   Line/Ray, Vertical Line, Trendline, Rectangle) — render only, no
   hitTest/interaction yet, manually attach one hardcoded test drawing to
   confirm rendering.
3. `subscribeClick` wiring + placement flow (IDLE → PLACING → COMMITTED) for
   all 5 canvas tools, pan/zoom lock, Esc-to-cancel.
4. Text Annotation (DOM chip variant, separate from the canvas primitives).
5. Selection (`hitTest` on all 6, click-to-select, visual affordance) +
   Delete key + delete-icon chip.
6. Anchor drag-to-edit.
7. Left-edge `DrawingToolStrip` component + layout change (flex wrap around
   `containerRef`) + icon set.

Standard verification discipline: typecheck both apps
(`apps/api && npx tsc --noEmit`, `apps/web && npx tsc --noEmit`) after each
commit; manual Playwright-MCP pass at the end of the sequence exercising all
6 tools (place, select, drag-edit, delete, reload-persistence,
pair-switch-persistence, timeframe-switch-anchoring). **Stop before merge** —
this is the highest bug-risk code written tonight (genuinely new interaction
layer, first-ever mouse-drag state machine in this codebase), needs explicit
review before landing on `main`.

## 11. KNOWN LIMITATION — time-anchored drawings can disappear on a
timeframe switch (found during the final verification pass, 2026-07-26)

Confirmed empirically (not a bug in this pass's code — a direct, expected
consequence of the exact-match `timeToCoordinate` behavior documented in
§5's update note): a drawing's anchor `time` is stored as the exact candle
boundary it was clicked on, in whichever timeframe was active at placement.
Switching to a **coarser** timeframe whose bar grid doesn't happen to
include that exact timestamp makes `timeToCoordinate` return `null` for
that anchor — the primitive's `if (x == null) return;` guard then makes it
silently not render (no error, no crash, just gone) until the user switches
back to a timeframe whose grid does include that time.

Verified directly against `chart.timeScale().timeToCoordinate()`: a full
set of 6 drawings placed on 1h all resolved fine after switching to **15m**
(every 1h boundary is also a valid 15m boundary — both are calendar-aligned
to `:00`, and 15m divides 60m evenly), but switching to **4h** broke 4 of
6 (`hline`, `hray`, both `trendline` anchors, one `rect` anchor) — only
anchors that happened to fall on an hour divisible by 4 survived. This is
directional: fine → coarse is the risky direction; coarse → fine is safe
(coarser grids are always a subset of finer ones, given calendar-aligned
bucketing).

**Not fixed in this pass** — flagging for a future pass rather than
expanding scope now, matching this repo's existing convention for
documented-not-blocking gaps (see the Stage 6 replay limitation in
`CLAUDE.md`). Two directions worth considering when picked up:
- Store anchors "loosely" and have each primitive's renderer fall back to
  interpolating/clamping to the nearest visible bar instead of requiring
  an exact match (bigger change — touches every primitive's render path).
- Leave storage as-is, but resolve anchor time through a STEP-lookup
  (nearest bar ≤ the stored time) at render time instead of passing the
  raw stored time straight to `timeToCoordinate` — smaller change, and the
  STEP-lookup pattern already exists in `usePanelCrosshairHover.ts`.

Text Annotation is unaffected in kind (same `timeToCoordinate`-based
positioning as the canvas tools) but wasn't separately stress-tested beyond
the 1h→15m→4h sequence above — assume it has the same limitation, not a
different one.
