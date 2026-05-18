# Commit 6 — Juice Pass: INVENTORY

**Date:** 2026-05-18
**Scope:** Read-only audit. No code changes.
**Goal of Commit 6:** kinetic feedback for trade fills, ELO changes, and live P&L — tool-feel, not game-feel.

---

## 1. Trade fill flow

**Handler:** `handlePlaceOrder()` — `apps/web/src/components/trading/UnifiedOrderPanel.tsx:216-304`

Flow on LONG/SHORT click:

1. `handlePlaceOrder()` fires → calls `submitOrder()` in `tradingStore.ts:276-308`.
2. Store sets `orderSubmitting = true` → button text becomes **"PLACING..."** (`UnifiedOrderPanel.tsx:208`).
3. `POST /orders` returns `{ order, fills }`; filled qty derived from `fills`.
4. If TP/SL/TSL specified, follow-up `createOco()` / `createTrigger()` calls.
5. Store sets `btnState = "success"` → button turns green, text **"ORDER PLACED"** / **"ORDER + TP/SL SET"** (`:280`). Form fields cleared (`:284-287`).
6. `onOrderFilled()` callback → `TradingPage.refreshPositions()` (`TradingPage.tsx:698-702`) does `GET /positions`.
7. `currentPosition` updates → passed as prop → **position card renders** (`UnifiedOrderPanel.tsx:523-619`) when `hasPosition && posQty !== 0`.
8. After 2.5s the button resets to idle.

**What the user sees today:** button label/color change (PLACING → ORDER PLACED green, 2.5s) and a separate toast `"Trade filled: {qty} {side} @ ${price}"` fired off the SSE `trade.created` event (`ToastProvider.tsx:62-68`, top-right, 5s).

**Gap:** The position card has **no entrance treatment** — it just pops into existence after the `/positions` round-trip (~100–300ms+, longer on slow networks). No skeleton, no placeholder, no transition. The card "suddenly exists."

---

## 2. P&L update flow

**Display:** `UnifiedOrderPanel.tsx:553-555` — colored P&L line (`+$X (+Y%)`), green/red by sign.
Also in `MatchHeaderBar.tsx:64-72` (you) and `:87-95` (opponent) for LiveMatchView.

Flow:

1. SSE `price.tick` arrives → `useSSE.ts:60-81` extracts `bid/ask/last`.
2. `setSnapshot()` → `tradingStore.ts:325-326`. **No throttling.**
3. `UnifiedOrderPanel` re-renders: `currentPrice = snapshot?.last`, `pnlValue = (currentPrice - posEntryPrice) * posQty`, `pnlPct` recomputed (`:112-139`).
4. Number repaints instantly.

**Update frequency:** every price tick, unthrottled (store update → immediate re-render). LiveMatchView additionally polls match P&L every 15s (`LiveMatchView.tsx:555-577`); positions refresh on `trade.created`.

**Transition today:** **None.** No CSS `transition`/`animation` on the P&L element — only an instant color swap on sign change. Changes are abrupt.

---

## 3. ELO display locations

| # | Location | File:line | Update mechanism |
|---|----------|-----------|------------------|
| 1 | Profile page header `{elo} ELO` | `ProfilePage.tsx:163` | **Page refresh.** ELO derived from latest match in `getMatchHistory()` (`:118`, `:137-141`), local state `elo` (`:109`) |
| 2 | Profile ELO progress bar (tier progression) | `ProfilePage.tsx:169-176` | Same as #1 |
| 3 | Profile match-history ELO delta column | `ProfilePage.tsx:226,237` | Same as #1 (per-match `elo_delta`) |
| 4 | Arena tier badge (header) | `ArenaPage.tsx:342` | Zustand `useCompetitionStore.userTier` — tier string, not numeric; updates on app init / explicit store call |
| 5 | Arena match-history ELO delta column | `ArenaPage.tsx:528,540-544` | Page refresh |
| 6 | Match End Overlay — "ELO CHANGE" | `MatchEndOverlay.tsx:120` | **Live** — `GET /v1/matches/{id}/result` on mount, local `eloResult` state (`:36,40`) |
| 7 | Match End Overlay — "NEW ELO" | `MatchEndOverlay.tsx:135` | Live, same as #6 (`winner_new_elo`/`loser_new_elo`) |
| 8 | Match End Overlay — tier change banner | `MatchEndOverlay.tsx:140-155` | Live, same as #6 |
| 9 | Topbar tier badge `★ {userTier}` | `AppLayout.tsx:333` (store at `:53`) | Zustand `useCompetitionStore.userTier`; refresh-bound |

**Canonical "current ELO" source:** there is **no single numeric ELO in global state.**
- Tier (string) lives in `useCompetitionStore.userTier` (`competitionStore.ts:39,67,130,140`, fetched via `/v1/competitions/tier`).
- Numeric ELO is **derived locally per-page** from match history (`ProfilePage` local `elo`), or from the post-match result API (`MatchEndOverlay.eloResult`). These are not synced with each other or the store.

---

## 4. Animation infrastructure

**Animation libraries:** **NONE.** No `framer-motion`, `@react-spring/web`, `react-transition-group`, `gsap`, or `motion` in `apps/web/package.json`.

**What exists — CSS / Tailwind only:**
- Tailwind config defines ~9 custom keyframes: `fadeUp`, `pulse-dot`, `blink`, `ticker-scroll`, `boot-fade`, `bar-fill`, `flicker`, `pulse-row`, `dashed-pulse`.
- `index.css` adds keyframes for boot/glitch/auth effects: `bootLine`, `glitch1/2`, `scroll-line`, `auth-spin`, `revealPanel`, `tpulse`, `tpulse-war`.
- ~28 `animate-*` class usages across landing/auth/layout/ticker components.
- Inline CSS transitions for theme swaps and collapse arrows (`transition: transform 0.1s/0.15s`, `transition-colors`, `transition-all duration-200`).
- Theme system: CSS variables, theme-agnostic animations.

**Verdict: CSS only.** No animation library present. The codebase already has a mature, consistent CSS-keyframe + Tailwind-animation idiom.

---

## 5. Recommended approach

**Do not add an animation library.** The three Commit-6 surfaces are all simple, discrete state changes — well within CSS reach — and the repo already has an established keyframe vocabulary to match. Adding framer-motion would be a bundle/idiom cost with no payoff here.

Minimal-risk plan per surface:

- **Trade fill — position card entrance.** Add a one-shot entrance keyframe (reuse/adapt `fadeUp`) on the position card so it slides/fades in instead of popping. Optionally a brief border-flash on first render. Pure CSS class toggled on mount; no flow changes.

- **P&L — number transitions.** The number itself can't CSS-transition text content. Two low-risk options: (a) brief background/color flash on change via a keyframe re-triggered by a `key` or class toggle (green-up / red-down tick flash, classic Bloomberg-style), or (b) a small JS count-up tween if smoother motion is wanted. Recommend (a) — flash-on-change is tool-feel, cheap, and matches the existing idiom. Watch the unthrottled tick rate; a flash that retriggers every tick may need a light throttle (e.g. 200–300ms) to avoid strobing.

- **ELO — change feedback.** The Match End Overlay (#6–8) is the only live surface and the natural home for kinetic ELO feedback — count-up the delta there. The refresh-bound displays (#1–5, #9) would each need either a store-level numeric-ELO source or a post-match refetch to animate; that's a data-flow change, larger than a CSS pass. Recommend scoping Commit 6's ELO juice to the Match End Overlay only, and noting "no canonical numeric ELO in state" as a separate follow-up if live ELO elsewhere is wanted later.

**Throttle note:** P&L re-renders are unthrottled (`setSnapshot` every tick). Any per-change animation must account for high tick frequency — throttle the *animation trigger*, not the data.

---

## Summary

- **Task 1 — Trade fill:** `handlePlaceOrder` → store → `/orders` → callback → `/positions` refetch. User sees button color/text change + a toast; the position card just pops in with no entrance.
- **Task 2 — P&L:** SSE `price.tick` → `setSnapshot` (unthrottled) → instant recompute at `UnifiedOrderPanel.tsx:553`. No transition — abrupt.
- **Task 3 — ELO:** 9 display spots; only the Match End Overlay updates live, everything else is page-refresh-bound. No canonical numeric ELO in global state.
- **Task 4 — Animation infra verdict:** **CSS only** — no animation library; mature Tailwind/keyframe idiom already in place.

**Surprises:**
1. No single source of numeric ELO in state — it's re-derived per page from match history. Animating ELO outside the post-match overlay would require a data-flow change, not just CSS.
2. P&L updates are completely unthrottled — straight from every SSE tick to re-render. Any change-flash animation risks strobing without a throttle.
3. Trade-fill feedback is split across two mechanisms (button state in the panel, toast off SSE) and the position card itself has zero entrance treatment.
