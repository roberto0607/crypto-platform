# Design: Open-orders dock + cancel on the trade page (PR A)

**Status:** in implementation — dock done + smoke-verified; sticky submit footer added to scope after smoke (§g) · **Date:** 2026-05-27 · **Author:** order-visibility investigation session
**Tracks:** Phase 1 investigation (order placement / visibility / cancellation). Sibling work: PR B (TP/SL "--" repro, after PR A ships) and the HIGH-priority market-maker followup in `docs/followups.md`.

## Problem (recap from Phase 1)

A user on the trade page has **no way to see or cancel resting LIMIT orders**.
Ground-truthed in prod: the user placed three LIMIT BUYs @ 75,110.70 that were all
`OPEN` (holding $300.90 reserved), but the trade page renders no list of them and no
cancel control. The backend is fine — `GET /orders?status=OPEN` returns them and
`DELETE /orders/:id` cancels + releases funds correctly. This is a pure **UX gap**.
(The three stuck orders were cleaned up out-of-band on 2026-05-27 — see §f.)

Acceptance criteria this PR closes:
- **#2** — place a LIMIT order and see it in a visible open-orders list (price, side, status)
- **#3** — multiple resting limits all visible without switching views
- **#4** — cancel any specific resting limit with one click; it disappears from the list

(#1 market→position and #6 fill-price correctness are already built/correct; #5 TP/SL is PR B; limit *fills* are the market-maker followup.)

## a. Data-shape audit — has `OpenOrders.tsx` drifted?

**Verdict: no adapter work needed for data. The component is wire-compatible with the
current store today.**

`apps/web/src/components/trading/OpenOrders.tsx` reads exactly two store slices —
`s.openOrders` and `s.cancelOrder` — and renders these `Order` fields: `id`, `side`,
`type`, `limit_price`, `qty`, `qty_filled`, `status`. All seven exist on the current
`Order` interface (`types/api.ts:95-108`), and `openOrders: Order[]` is populated by
`refreshOpenOrders()` from `GET /orders?status=OPEN` (`tradingStore.ts:262-264`). The
store already maintains it: refetch on pair-select (`:202`), refetch after submit
(`:301`), optimistic remove + revert in `cancelOrder` (`:310-322`), and live updates via
the `order.updated` SSE handler `updateOrder` (`:328-341`). **The plumbing is complete;
only the rendering is missing.**

Two caveats to fix *while we're in here* (cheap, in-scope):

1. **Styling drift (the real "adapter" work).** `OpenOrders.tsx` is styled with generic
   Tailwind utilities (`text-gray-500`, `border-gray-800`, `bg-gray-800/30`). The trade
   page uses the custom `tr-` design system with CSS variables (`var(--border)`, the
   `.tr-*` classes). The dock + table must be **styled in the `tr-` system** to match
   `OrderBookPanel`. **No generic Tailwind ships.** This is the bulk of the visual work.

2. **`CANCELLED` vs `CANCELED` casing (latent bug, pre-existing).** Frontend
   `OrderStatus` uses `"CANCELLED"` (two L's, `types/api.ts:93`) and `updateOrder` checks
   `status === "CANCELLED"` (`tradingStore.ts:330`). The **backend emits `"CANCELED"`**
   (one L — DB `orders_status_check`). So an SSE-driven cancel from a *non-self* source
   (system cancel, OCO sibling) would not be removed by the `updateOrder` fast-path. The
   user's own cancels are masked by the optimistic removal, and `refreshOpenOrders`
   (status=OPEN) never returns canceled rows, so it's latent today — but it lands right
   on this feature's path. Fix: normalize to the backend's `"CANCELED"`.

## b. Placement — DECIDED: full-width bottom dock

**Decision (2026-05-27):** a full-width dock spanning both columns, **not** the dormant
right-panel slot. Rationale: every real trading platform (Binance/Bybit) uses a bottom
dock for open orders; the deleted right-side JSX ("use History page instead",
`TradingPage.tsx:928`) shows someone already walked away from the right-side approach;
and a dock gives a natural home for future **Order History / Trades / Positions** sibling
tabs without a redesign.

### Exact location

`.tr-wrap` is a flex column: `.tr-abar` (asset bar, 46px) → `.tr-body` (chart|order grid)
→ *(conditional competition bar)*. The bottom **ticker/price marquee is owned by
AppLayout** (`TradingPage.tsx:511` "ticker provided by AppLayout"; the body height calc
reserves `ticker(36px)`), **not** TradingPage — so it is *not* touched.

The dock mounts as a **new `flex-shrink:0` row at the bottom of `.tr-wrap`, directly
after `.tr-body` and above the conditional competition bar**, i.e. between the chart row
and AppLayout's marquee. Order: asset-bar → body → **open-orders dock** → [competition
bar if in match] → (AppLayout ticker).

### Body-height integration (the one real subtlety)

`.tr-body` is currently `height: calc(100vh - 126px)` (`:139`) — a hardcoded magic number
(topbar 41 + padding 3 + asset-bar 46 + ticker 36). A `flex-shrink:0` dock added below it
would overflow `.tr-wrap` (which is `overflow:hidden`). Fix:

- **Preferred:** make `.tr-body` flex-fill instead of fixed — `flex:1 1 0; min-height:0`
  — so the flex-column `.tr-wrap` distributes height between body and dock automatically,
  and the magic `100vh - 126px` calc goes away (it's brittle anyway). **Risk:** the
  lightweight-charts canvas needs its container height to resolve; verify it re-fits via
  its ResizeObserver in the live smoke. **Fallback if the chart misbehaves:** keep the
  calc but subtract a `--tr-dock-h` CSS var that tracks the dock's collapsed/expanded
  height.

### Collapsible / dismissible behavior

- **0 open orders →** dock renders as a thin 30px strip (header only). Minimal
  chart real-estate cost.
- **orders appear (count 0 → ≥1) →** dock auto-expands to a 210px region with the table,
  **overriding any stored collapse** — arriving with open orders must never show a thin
  dock that hides them (see §h Issue 1). Triggered both on the post-fetch first paint and
  when an order is placed.
- **Manual toggle:** the **entire header bar** is the toggle target (role=button +
  keyboard), not just the chevron (see §h Issue 2). A manual collapse while orders persist
  is respected and persisted in `localStorage` (`tradr_order_dock`) — but is overridden
  the next time orders appear from empty.

### Tabs-ready structure (build the seam, not the tabs)

`OrderDock` renders a **header tab-strip driven by a `tabs` array** + a content switch.
Today the array has one entry: `{ key: "open", label: "Open Orders", count: N }`. Adding
`Positions | Order History | Trades` later = append array entries + content cases. **Do
not build those tabs in this PR** — just structure so they're trivial to add.

## c. Implementation plan

1. **New component `apps/web/src/components/trading/OrderDock.tsx`** — the dock shell:
   tab-strip header (single "Open Orders (N)" tab for now), collapse chevron, collapsed
   vs expanded render, `localStorage` persistence, content area. `tr-`-styled.
2. **Restyle the open-orders table** to the `tr-` system. Either fold the existing
   `OpenOrders.tsx` into the dock's content or keep it as a child and replace its
   Tailwind classes with `tr-` classes/CSS vars. Columns at full width fit comfortably:
   Side · Type · Price · Qty · Filled (bar) · Status · Cancel.
3. **Mount in `TradingPage.tsx`** as the new bottom row of `.tr-wrap` (after `.tr-body`,
   before the competition bar); replace the `:928` "removed" comment. Add the
   `.tr-order-dock*` CSS in the page's style block.
4. **Body-height fix** per §b (flex-fill preferred; calc+var fallback).
5. **Fix the `CANCELLED`→`CANCELED` casing** in `OrderStatus` (`types/api.ts:93`) and
   `updateOrder` (`tradingStore.ts:330`).
6. **Confirm refresh on load:** `refreshOpenOrders()` already runs on pair-select; ensure
   first paint for the selected pair is covered.
7. Cancel flow end-to-end: click → optimistic remove → `DELETE /orders/:id` → row gone;
   on error → revert + toast.

## d. Testing — discriminator-tested

Each test must **fail on pre-fix code and pass after** (no tautological tests).

- **Integration (frontend, core of the PR):** render the trade page with a mocked store
  holding 2+ OPEN orders → assert rows render with correct price/side/qty *and the dock
  is present* (discriminator: **fails today** — dock isn't mounted). Click Cancel →
  assert `DELETE /orders/:id` called with the right id and the row is removed
  (discriminator: no cancel UI exists today). Error path → row reverts.
- **Empty-state discriminator:** 0 orders → assert the thin "0 open orders" strip renders
  (not the full table, not nothing).
- **Casing regression:** `updateOrder(id, "CANCELED", …)` (one L, backend's value) →
  assert the order is removed from `openOrders` (discriminator: **fails today** — the
  `=== "CANCELLED"` check misses it, so the order wrongly persists).
- **Backend already covered:** `matchingEngine.test.ts` cancel suite (`:566-`) +
  `trading.test.ts` exercise `DELETE /orders/:id` + reserved release. No backend change,
  no new backend tests.
- **Live smoke (Playwright MCP, local):** place a LIMIT → see it appear in the dock →
  cancel → row vanishes + funds released; verify the dock collapses to the thin strip at
  0 orders; **verify the chart still fits after the body-height change**. Also spot-verify
  criterion #1 (market→position). Needs local dev servers + throwaway account.

## e. Out of scope (tracked elsewhere)

- TP/SL "--" on the position card → **PR B** (10-min repro first, *after* PR A ships —
  not interleaved).
- LIMIT orders never filling in solo prod → **market-maker followup (HIGH)** in
  `docs/followups.md`. The dock makes resting orders *visible and cancelable* regardless
  of whether they fill, so this PR stands on its own.
- Order History / Trades / Positions tabs → future PR (the dock is structured for them).

## f. Cleanup record — the 3 stuck orders (done 2026-05-27)

Canceled out-of-band via a DB transaction mirroring `cancelOrderInternal` (API path
unavailable — no stored credential). Before: 3× `OPEN`, wallet `reserved=300.90039915`.
Transaction: `UPDATE orders SET status='CANCELED'` (3 rows) + `UPDATE wallets SET reserved
= reserved - 300.90039915` (1 row), committed. After (verified): all 3 → `CANCELED`,
wallet `reserved=0.00000000`, balance unchanged (97152.44260807 — a hold release moves no
balance). Skipped only the audit_log row + SSE event (immaterial for dead orders). Not
part of this PR's diff.

## g. Order-form height — sticky submit footer (added to PR A scope 2026-05-27)

The live smoke surfaced a layout problem the dock made visible but did **not** cause:

- **Problem 1 (pre-existing):** in LIMIT mode the order form is taller than
  `.tr-order-panel-top`, so the `OPEN LONG` button + cost summary sit **below the fold** —
  the user must scroll to submit, even when the dock is the thin 30px strip. (MARKET mode
  has one fewer field and just barely fit, which is why nobody noticed.)
- **Problem 2:** expanding the dock shrinks `.tr-body` → shrinks the right column →
  shrinks `.tr-order-panel-top`, so scrolling to submit becomes mandatory and the user
  loses sight of price/amount inputs and the submit button at the same time.

Root cause: the three **optional** fields (TAKE PROFIT, STOP LOSS, TRAILING STOP) compete
for vertical space with the **critical-path** elements (LIMIT PRICE, AMOUNT, summary,
submit) inside one scroll container.

### Options

- **Option A — collapse TP/SL/TSL behind "+ Advanced" (default closed).** Shortens the
  form ~150px. Simple (state + conditional render). Downside: hides functionality from
  users who set TP/SL at entry time (though they remain settable on the position card
  after opening).
- **Option B — sticky submit footer (CHOSEN).** Pin the summary + submit button to the
  bottom of `.tr-order-panel-top`; TP/SL/TSL scroll above. Doesn't hide anything; the
  critical elements (cost + submit) are always visible regardless of scroll or dock state.

**Decision: Option B** — keeps all fields visible, and directly satisfies "OPEN LONG +
cost summary always reachable" in both dock states.

### Feasibility (verified against the code, no scroll-behavior breakage)

`UnifiedOrderPanel` is **shared** by the trade page (`classPrefix="tr"`) and the arena
(`classPrefix="lmv"`) — those are the only two consumers. The trade page's
`.tr-order-panel-top` is the `overflow-y:auto` scroll container; the form renders inside
`.tr-order-section`. The **position card is already** `position:sticky; bottom:0`
(`.tr-position-card-sticky`, z-index 2, opaque bg) — so a sticky footer must coexist with
an existing sticky element.

Plan:
1. **JSX (shared):** wrap the `${p}-summary` block + submit button in
   `<div className={`${p}-order-footer${hasPosition ? "" : " is-pinned"}`}>`.
2. **Arena untouched:** `.lmv-order-footer { display: contents; }` makes the wrapper
   layout-transparent — the arena renders summary+submit in normal flow exactly as today.
   (Verified the arena's `.lmv-order-section` is a plain padded block with its own
   `.lmv-position-card-sticky`.)
3. **Trade page:** `.tr-order-footer.is-pinned { position:sticky; bottom:0; z-index:1;
   margin:0 -16px; padding:8px 16px 0; background:rgba(5,5,5,0.97); border-top:1px solid
   var(--borderW); }` — mirrors the card's edge-to-edge opaque treatment, z-index **below**
   the card (1 < 2). Sticky preserves flow space, so the last field (TSL) stays reachable.
4. **Dual-sticky resolution:** pin the footer **only when there is no position**
   (`is-pinned` omitted when `hasPosition`). With a position, the already-sticky position
   card (CLOSE button) remains the pinned element and the summary/submit scroll — i.e.
   today's has-position behavior is preserved, and the new pinning fixes the reported
   no-position case. (Avoids two `bottom:0` stickies fighting.)

### Position-card height check (your 3rd ask)

The position card is already sticky-pinned with an opaque bg, so CLOSE stays visible
regardless of scroll — structurally it does *not* have Problem 1. **To verify**, the
re-spot-check will open a MARKET position (local bot provides fills) and confirm the card
+ CLOSE button are visible without scrolling at both dock states, and that footer/card
don't visually collide.

### Re-test — VERIFIED 2026-05-27 (Playwright, local)

Geometry measured (discriminator: `OPEN LONG` reachable *despite* overflow), screenshots
in `docs/designs/assets/2026-05-27-open-orders-dock/`:
- **(a) LIMIT, thin dock** — panel viewport 382px, content 635px (**overflowing**), footer
  `position:sticky`, `OPEN LONG` at 439–473 inside viewport (bottom 483) → **visible, no
  scroll**. (`pr-a-footer-1-…`)
- **(b) dock expanded** — viewport squeezed to 202px, content 618px, `OPEN LONG` at
  259–293 inside viewport (bottom 303) → **still visible**. (`pr-a-footer-2-…`)
- **(c) open position** — footer class `tr-order-footer` (no `-pinned`),
  `display:contents`, not sticky → **no collision**; position card is the sole sticky
  element, `CLOSE POSITION` visible. Worst case (position + resting limit + dock expanded)
  the card fills the squeezed 202px panel with CLOSE pinned at the bottom and the form
  behind it — coherent, CLOSE always reachable. (`pr-a-footer-3-…`)

**Note on tests:** the sticky/`display:contents` behavior is layout, which jsdom can't
exercise; the discriminator here is the recorded Playwright geometry (overflow present yet
submit visible). A jsdom unit test could assert the `${p}-order-footer-pinned` class
toggles with `hasPosition`, but rendering `UnifiedOrderPanel` needs heavy store/API
mocking for low marginal value — deferred unless we want it as a CI guard.

## h. Post-spot-check fixes (Issues 1–3, 2026-05-27)

Safari spot-check confirmed the footer works but surfaced three follow-ups, all in
`OrderDock.tsx` + dock CSS:

1. **Dock not auto-expanding (real bug).** `expanded = orderCount>0 && !collapsed` and
   `collapsed` was seeded from `localStorage` — so any prior manual collapse kept the dock
   thin on every later load, hiding orders. **Fix:** a `prevCount` ref + effect that
   `setCollapsed(false)` on the `0 → ≥1` transition (incl. the post-fetch first paint),
   overriding the stored pref. Manual collapse while orders persist is still respected;
   it's overridden the next time orders appear from empty. Discriminator tests added
   (`OrderDock.test.tsx`): auto-expand on 0→N *and* on first mount, each with a stored
   `"collapsed"` — fail on the pre-fix logic. Verified live: stored `"collapsed"` +
   reload with orders → dock `expanded`, stored pref rewritten to `"expanded"`.
2. **Only the chevron was clickable (UX).** **Fix:** the whole `.tr-dock-bar` is now the
   toggle (`role="button"`, `tabIndex`, `aria-expanded/-disabled`, Enter/Space); tabs +
   chevron are non-interactive `<span>`s whose clicks bubble to the bar. Discriminator
   test clicks the **"Open Orders" label** (not the chevron) and asserts toggle — fails on
   the pre-fix chevron-only handler. Verified live (label click collapses/expands).
3. **Form fields bled through the pinned footer (visual).** `background:rgba(5,5,5,0.97)`
   let ~3% of scrolling content (the TRAILING STOP label) show behind the summary rows.
   **Fix (opaque color, not z-index):** `background:#050505` — matches the position card.
   Verified live: computed footer bg `rgb(5,5,5)`, no bleed in `pr-a-footer-4-…`.

All 10 web tests pass; typecheck clean. (Final footer class is `tr-order-footer-pinned`,
applied only when `!hasPosition` — the §g plan's working name was `is-pinned`.)
