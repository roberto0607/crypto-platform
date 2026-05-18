# Sub-commit 3b — Execution Plan (Investigation Pass)

**Status:** READ-ONLY investigation complete. No code changed. Awaiting review.
**Base:** main @ 8d8635f (post 3a).
**Date:** 2026-05-18.

---

## ⚠️ Read this first — the classification report is materially wrong in places

`docs/audit/CLASSIFICATION_2026-05.md` was written 2026-05-17 and its **DEAD list for
`market/` is substantially inaccurate.** It claimed 8 market files have "0 importers."
Re-verified with precise path-resolved greps (api + web, tests excluded):

| File | Classified | Reality |
|---|---|---|
| `signalService.ts` | DEAD (0 imp) | Imported by `signalTrackerJob.ts` + `v1Signals.ts` |
| `binanceFutures.ts` | DEAD (0 imp) | Imported by `derivativesPollerJob.ts` |
| `derivativesPoller.ts` | DEAD (0 imp) | Imported by `derivativesPollerJob.ts` + `v1Signals.ts` |
| `patternService.ts` | DEAD (0 imp) | Imported by `v1Signals.ts` |
| `liquidityZones.ts` | DEAD (0 imp) | Imported by `v1Signals.ts` → **feeds a live chart overlay** |
| `candleAggregator.ts` | DEAD (0 imp) | Imported by `feeds/coinbaseWs.ts` + `krakenWs.ts` — **live infra** |
| `krakenRest.ts` | DEAD (0 imp) | Imported by `krakenCandleSyncJob.ts` — **live infra** |
| `orderFlowFeatures.ts` | DEAD (0 imp) | Imported by `krakenBookRoutes.ts` (a KEEP route) — **live infra** |

Net effect: **4 files the audit called DEAD are actually KEEP** (`candleAggregator`,
`krakenRest`, `orderFlowFeatures`, `liquidityZones`). They are **excluded from deletion below.**
The other 4 are still cut — but as part of the signal stack, not as "dead code."

Only **2** of the audit's 10 `market/` DEAD files are genuinely unreferenced:
`candleBackfill.ts`, `orderBookService.ts`.

`strategy/` classification verified accurate — the whole directory is reachable
**only** from `bot/`, and `bot/` is being cut. Clean.

---

## Section 1 — Full file delete list

### 1A. Backend — `strategy/` (entire directory, 24 files)

Verified: no file outside `strategy/` imports any `strategy/*` file except `bot/`
(`engine`, `types`, `backtestTypes` ← `bot/`). With `bot/` also deleted, `strategy/`
has zero surviving importers.

```
apps/api/src/strategy/annualAnalysis.ts
apps/api/src/strategy/backtest.ts
apps/api/src/strategy/backtestConfig.ts
apps/api/src/strategy/backtestMetrics.ts
apps/api/src/strategy/backtestRunner.ts
apps/api/src/strategy/backtestTypes.ts
apps/api/src/strategy/dataValidation.ts
apps/api/src/strategy/engine.ts
apps/api/src/strategy/exits.ts
apps/api/src/strategy/gridOptimizer.ts
apps/api/src/strategy/indicators.ts
apps/api/src/strategy/invalidation.ts
apps/api/src/strategy/liquidity.ts
apps/api/src/strategy/monteCarlo.ts
apps/api/src/strategy/optimizedOrchestrator.ts
apps/api/src/strategy/parameterRobustness.ts
apps/api/src/strategy/regime.ts
apps/api/src/strategy/regimeSegmentation.ts
apps/api/src/strategy/sensitivity.ts
apps/api/src/strategy/signals.ts
apps/api/src/strategy/sizing.ts
apps/api/src/strategy/tradeLogger.ts
apps/api/src/strategy/types.ts
apps/api/src/strategy/walkForward.ts
```

### 1B. Backend — `bot/` (entire directory, 5 files + 1 test)

```
apps/api/src/bot/botRunRepo.ts
apps/api/src/bot/botRunner.ts
apps/api/src/bot/botTypes.ts
apps/api/src/bot/strategyAdaptor.ts
apps/api/src/bot/strategyBotService.ts
apps/api/src/bot/__tests__/botRunner.test.ts
```

### 1C. Backend — `market/` (12 files; CUT-SIGNAL + CUT-INFRA + signal-stack + genuinely DEAD)

```
# CUT-SIGNAL — advisor scores (Roberto's product decision)
apps/api/src/market/marketIntelligence.ts      (529 LOC)
apps/api/src/market/regimeClassifier.ts        (439 LOC)
apps/api/src/market/signalNormalizer.ts        (279 LOC)

# CUT-INFRA — plumbing that served only marketIntelligence / the signal-learning loop
apps/api/src/market/signalLogger.ts            (122 LOC)
apps/api/src/market/weightAdjuster.ts          (135 LOC)
apps/api/src/market/outcomeTracker.ts          (236 LOC)

# Signal-stack files reachable only via cut routes/jobs (audit mislabeled these "DEAD")
apps/api/src/market/signalService.ts           (553 LOC)  ← signalTrackerJob + v1Signals
apps/api/src/market/derivativesPoller.ts       (186 LOC)  ← derivativesPollerJob + v1Signals
apps/api/src/market/binanceFutures.ts          ( 93 LOC)  ← derivativesPollerJob
apps/api/src/market/patternService.ts          (100 LOC)  ← v1Signals (patterns/scenarios)

# Genuinely DEAD — verified 0 importers anywhere
apps/api/src/market/candleBackfill.ts          (243 LOC)
apps/api/src/market/orderBookService.ts        ( 80 LOC)
```

**`market/` files that STAY** (do NOT delete — 12 files):
`krakenWs`, `snapshotStore`, `perpetualBasisService`, `liquidationEstimator`,
`onChainFlowService`, `orderBookAggregator`, `optionsGammaService`,
`macroCorrelationService` (all 8 originally KEEP), **plus the 4 reclassified KEEPs:**
`candleAggregator`, `krakenRest`, `orderFlowFeatures`, `liquidityZones`.

### 1D. Backend — routes (5 files deleted, 1 trimmed)

```
apps/api/src/routes/intelligenceRoutes.ts   (imports marketIntelligence)
apps/api/src/routes/signalRoutes.ts         (imports signalNormalizer)
apps/api/src/routes/regimeRoutes.ts         (imports regimeClassifier)
apps/api/src/routes/learningRoutes.ts       (imports signalLogger + weightAdjuster)
apps/api/src/routes/v1/v1Bot.ts             (imports bot/strategyBotService)
```

**`apps/api/src/routes/v1/v1Signals.ts` — TRIM, do NOT delete.** See Risk #1.

### 1E. Backend — jobs (3 files)

```
apps/api/src/jobs/definitions/signalTrackerJob.ts      (imports signalService — cut)
apps/api/src/jobs/definitions/derivativesPollerJob.ts  (imports binanceFutures + derivativesPoller — cut)
apps/api/src/jobs/definitions/orderFlowSnapshotJob.ts  (see Risk #4 — borderline)
```

### 1F. Frontend — components & pages

```
apps/web/src/components/trading/OrdersTab.tsx           (orphan — 0 importers)
apps/web/src/components/trading/PositionsTab.tsx        (orphan — 0 importers)
apps/web/src/components/trading/TriggersTab.tsx         (orphan — 0 importers)
apps/web/src/components/competitions/ComparisonChart.tsx (orphan — 0 importers)
apps/web/src/components/competitions/TierBadge.tsx      (orphan — 0 importers)
apps/web/src/pages/BotPage.tsx                          (orphan — not routed in App.tsx)
apps/web/src/__tests__/ordersTab.test.tsx               (tests deleted OrdersTab)
```
> Deleting both files in `components/competitions/` empties the directory — remove the dir.

### 1G. Frontend — API endpoint clients

```
apps/web/src/api/endpoints/bot.ts        (sole importer = BotPage.tsx — being deleted)
apps/web/src/api/endpoints/portfolio.ts  (0 importers — orphaned by 3a; see Risk #5)
apps/web/src/api/endpoints/sim.ts        (0 importers — orphaned by 3a; see Risk #5)
```

`apps/web/src/api/endpoints/signals.ts` — **TRIM, do NOT delete.** See Risk #1/#3.

### 1H. Frontend — DISCOVERED ORPHANS (human decision — see Risk #5)

```
apps/web/src/components/trading/MarketContext.tsx   (orphan — 0 importers)
apps/web/src/components/trading/MarketTab.tsx       (orphan — 0 importers)
```
Not in the original 3b scope and not strategy/bot code. Recommend delete, but confirm first.

---

## Section 2 — Code edits needed in surviving files

### 2.1 `apps/api/src/app.ts`

Remove 4 route imports (lines 40–43):
```diff
-import signalRoutes from "./routes/signalRoutes";
-import regimeRoutes from "./routes/regimeRoutes";
-import intelligenceRoutes from "./routes/intelligenceRoutes";
-import learningRoutes from "./routes/learningRoutes";
```
Remove the bot runner import (line 48):
```diff
-import { initBotRunner } from "./bot/botRunner";
```
Remove the `disableBotRunner` option (lines 63–64):
```diff
-  /** Skip starting bot runner (useful for tests). */
-  disableBotRunner?: boolean;
```
Remove the Swagger "Bot" tag (line 192):
```diff
-        { name: "Bot", description: "Strategy bot runs and signals" },
```
Remove 4 route registrations (lines 238–241):
```diff
-  await app.register(signalRoutes);
-  await app.register(regimeRoutes);
-  await app.register(intelligenceRoutes);
-  await app.register(learningRoutes);
```
Remove the bot runner onReady hook (lines 313–314):
```diff
-  if (!opts.disableBotRunner) {
-    app.addHook("onReady", () => { initBotRunner(); });
-  }
```
> Verify the closing brace count when removing the `if` block.

### 2.2 `apps/api/src/server.ts`

Remove 2 imports (lines 34–35):
```diff
-import { initRegimeClassifier, stopRegimeClassifier } from "./market/regimeClassifier";
-import { initOutcomeTracker, stopOutcomeTracker } from "./market/outcomeTracker";
```
Remove the stop calls (lines 112–113):
```diff
-    stopRegimeClassifier();
-    stopOutcomeTracker();
```
Remove `initRegimeClassifier()` (line 151) and the `initOutcomeTracker()` try/catch
(lines ~154–157):
```diff
-  initRegimeClassifier();
   ...
-  try {
-    initOutcomeTracker();
-  } catch (err) {
-    console.warn("[Phase4] OutcomeTracker failed to init:", (err as Error).message);
-  }
```
> Read lines 145–160 before editing — confirm exact surrounding structure.

### 2.3 `apps/api/src/routes/v1/index.ts`

```diff
-import v1Bot from "./v1Bot";
 ...
-    await app.register(v1Bot);
```

### 2.4 `apps/api/src/jobs/definitions/index.ts`

```diff
-import { signalTrackerJob } from "./signalTrackerJob";
-import { orderFlowSnapshotJob } from "./orderFlowSnapshotJob";
-import { derivativesPollerJob } from "./derivativesPollerJob";
 ...
 export const allJobs: JobDefinition[] = [
     ...
-    signalTrackerJob,
-    orderFlowSnapshotJob,
-    derivativesPollerJob,
     krakenCandleSyncJob,
     matchCleanupJob,
 ];
```

### 2.5 `apps/api/src/routes/v1/v1Signals.ts` — TRIM (see Risk #1)

This route file is **mixed**: 9 cut endpoints + 1 kept endpoint. The kept one:
```
GET /v1/pairs/:pairId/liquidity-zones   → market/liquidityZones.computeLiquidityZones
```
…feeds the **Liquidity Zones chart overlay** (CLAUDE.md "Already Built").

Two options for Roberto to choose (Risk #1):
- **(A) Trim in place:** keep only the `/liquidity-zones` handler + its `liquidityZones`
  import; delete handlers for `signals`, `signals/refresh`, `order-flow`, `derivatives`,
  `confidence-heatmap`, `scenarios`, `patterns`, `copilot`, `equity-curve`, `performance`;
  drop imports of `signalService`, `orderFlowFeatures` (getOrderFlow), `derivativesPoller`,
  `patternService`.
- **(B) Relocate:** move the `/liquidity-zones` handler into `v1Market.ts` (where the
  other chart-data endpoints already live) and delete `v1Signals.ts` entirely.

Recommended: **(B)** — `v1Signals.ts` reduced to one endpoint is an odd artifact, and
`v1Market.ts` is the natural home for chart-data routes.

### 2.6 `apps/web/src/api/endpoints/signals.ts` — TRIM (see Risk #3)

After the deletes, the only still-used exports are `getLiquidityZones` and the
`LiquidityZone` type (used by `CandlestickChart.tsx` + `lib/liquidityZonesPrimitive.ts`).
Everything else (`getSignals`, `refreshSignals`, `getEquityCurve`, `getOrderFlow`,
`getDerivatives`, `getAggregatePerformance`, `getConfidenceHeatmap`, `getScenarios`,
`getPatterns`, `postCopilotAnalysis`) becomes unused.
Recommend trimming to `getLiquidityZones` + `LiquidityZone` (+ supporting types).
Not a typecheck blocker — unused exports compile — so this is cleanup, not critical path.
If option (B) above is chosen, update the path in `getLiquidityZones`.

### 2.7 `apps/web/src/components/trading/CandlestickChart.tsx` — ⚠️ LARGE EDIT (see Risk #3)

This KEEP file contains a full **Market Intelligence overlay** that must be removed
(marketIntelligence is cut). Affected regions (line numbers approximate, ~300 LOC):
- Lines 57–89 — `IntelKeyLevel`, `IntelAlert`, `MarketIntelligenceData` type defs
- Lines 211–213 — `marketIntelligence` / `intelLoading` / `intelError` state
- Lines 963–1000 — intel CSS injection + `/market/intelligence` fetch `useEffect`
- Lines ~1306–~1610 — the entire Market Intelligence overlay JSX block
- Keep `getLiquidityZones` import (line 40) and its use at line ~938 — that stays.

### 2.8 `apps/web/src/components/trading/IndicatorToolbar.tsx`

Remove the toggle entry (line 22):
```diff
-  { key: "marketIntelligence", label: "Market Intelligence", color: "rgba(147,51,234,1)" },
```
Keep `liquidityZones` (line 19) — that overlay stays.

### 2.9 `apps/web/src/stores/tradingStore.ts`

Remove from `defaultIndicatorConfig` (line 56):
```diff
-  marketIntelligence: false,
```
Keep `liquidityZones: false` (line 53).

### 2.10 `apps/api/src/config.ts` — optional cleanup

After job deletes these become dead config:
- Line 148 `derivativesPollerEnabled` (only `derivativesPollerJob` reads it)
- Lines ~140–144 "Phase 20: ML signals" block (`mlSignalCooldownMs`, etc.)

> ⚠️ Do NOT touch lines 132–135 (`botUserId` / `BOT_USER_ID`) — that is the **market-maker
> bot**, a kept feature, unrelated to the strategy bot being cut.

---

## Section 3 — Risks / human decisions needed

### Risk #1 — `liquidityZones.ts` is a LIVE chart feature, not dead code  ⚠️ DECISION
The audit marked `market/liquidityZones.ts` DEAD. It is not. Chain:
`CandlestickChart.tsx` (line 938 `getLiquidityZones`) → `endpoints/signals.ts`
→ `GET /v1/pairs/:id/liquidity-zones` → `v1Signals.ts` → `market/liquidityZones.ts`.
"Liquidity Zones" is in CLAUDE.md's "Already Built" indicator list and has a toggle in
`IndicatorToolbar.tsx`.
**Decision needed:** confirm Liquidity Zones stays a chart feature (recommended — keep
`liquidityZones.ts`, trim `v1Signals.ts` per §2.5). If Roberto wants it cut too, that's a
larger scope change (also delete the toolbar toggle, the overlay code in CandlestickChart,
and `lib/liquidityZonesPrimitive.ts`).

### Risk #2 — Audit DEAD list was wrong; this plan supersedes it
See the table at the top. Four "DEAD" files are actually KEEP infra
(`candleAggregator`, `krakenRest`, `orderFlowFeatures`, `liquidityZones`). They are
**not** in the delete list. If you executed straight from `CLASSIFICATION_2026-05.md`
you would have broken `coinbaseWs`, `krakenCandleSyncJob`, `krakenBookRoutes`, and the
Liquidity Zones overlay. Trust this plan over the audit for `market/`.

### Risk #3 — CandlestickChart.tsx Market Intelligence removal is a ~300-LOC surgical edit
This is the largest single edit and touches a core KEEP file. It must be done carefully
(JSX block boundaries, state hooks, unused imports afterward). Recommend doing this edit
in isolation with a typecheck immediately after. `endpoints/signals.ts` trimming (§2.6)
is cosmetic and can be deferred.

### Risk #4 — `orderFlowSnapshotJob.ts` is borderline  ⚠️ DECISION
It imports `getAllOrderFlow()` from `orderFlowFeatures.ts` — a file that **stays** (KEEP).
But the job's purpose is persisting order-flow snapshots for the signal system; nothing
on a kept chart reads its DB output. Recommended: **delete the job** (it serves the cut
signal stack), keep `orderFlowFeatures.ts` (still needed by `krakenBookRoutes`).
Confirm this is acceptable — it is the one job whose dependency survives.

### Risk #5 — Discovered orphans outside the stated scope  ⚠️ DECISION
- `MarketContext.tsx`, `MarketTab.tsx` — 0 importers; not strategy/bot code; orphaned for
  an unknown duration (possibly pre-3a). Recommend delete, but they are out of the literal
  3b scope — confirm.
- `endpoints/portfolio.ts`, `endpoints/sim.ts` — 0 importers; orphaned by 3a's page
  deletions (PortfolioPage / sim pages), not by the bot/strategy cut. Safe to delete as
  3a-orphan cleanup; included here because 3b's scope explicitly covers cascaded orphans.

### Risk #6 — Database tables left intact (no schema drop this commit — by design)
Code is deleted; tables stay. Tables that will become write-orphaned:
- `derivatives_snapshots` (migration `052_derivatives_data.sql`) — written by the deleted
  `derivativesPollerJob`. **Production may hold rows.** Left intact.
- Adaptive-learning tables (migration `056_adaptive_learning.sql`) — signal logger /
  weight adjuster / outcome tracker. Left intact.
- Strategy-bot run tables (used by `botRunRepo.ts`) — no migration matched `bot_run*`;
  the table name should be confirmed during execution but is left intact regardless.
A future sub-commit can drop these tables once Roberto confirms no prod dependency.

### Risk #7 — No surviving code imports cut code (verified clean)
All 12 KEEP `market/` files were grepped for imports of `strategy/`, `marketIntelligence`,
`signal*`, `regimeClassifier`, `outcomeTracker` — **all clean.** The audit's note that
`macroCorrelationService.ts` imports `strategy/regime` is **false** — that file has no
import statements at all. No KEEP→CUT edge exists; no pre-refactor needed.

---

## Section 4 — Estimated total LOC deleted

| Area | Files | LOC |
|---|---|---|
| `strategy/` + `bot/` (incl. `botRunner.test.ts`) | 30 | 5,390 |
| `market/` (12 files) | 12 | 2,995 |
| Backend routes + jobs (5 routes incl. v1Bot + 3 jobs) | 8 | 689 |
| Frontend components/pages/test (incl. 2 flagged orphans) | 10 | ~2,100 |
| Frontend endpoint clients (`bot`, `portfolio`, `sim`) | 3 | ~120 |
| **Subtotal — file deletions** | **63** | **≈ 11,300** |
| Edits removing code (CandlestickChart intel block ≈300; app.ts/server.ts/indexes/trims ≈150) | — | ≈ 450 |
| **Grand total removed** | | **≈ 11,750 LOC** |

(Frontend file LOC measured together at 2,221 for the 12 frontend deletes; split above is
approximate. `v1Signals.ts` / `endpoints/signals.ts` trims net additional small removals.)

---

## Section 5 — Recommended delete / edit order

Principle: **edit surviving files first, delete second.** If files are deleted first, the
still-referencing survivors fail typecheck mid-execution. Editing references out first
leaves the doomed files as harmless orphans that still compile, then they delete cleanly.
Do it in one branch; typecheck (`cd apps/api && npx tsc --noEmit`, `cd apps/web && npx tsc
--noEmit`) at each checkpoint.

**Step 1 — Resolve the two decisions** (Risk #1 option A/B, Risk #4/#5) before touching code.

**Step 2 — Backend: detach references in survivors**
1. `app.ts` — remove route imports/registrations, bot runner, `disableBotRunner`, Bot tag (§2.1)
2. `server.ts` — remove regimeClassifier + outcomeTracker init/stop (§2.2)
3. `routes/v1/index.ts` — remove v1Bot (§2.3)
4. `jobs/definitions/index.ts` — remove 3 jobs (§2.4)
5. `v1Signals.ts` — trim or relocate `/liquidity-zones` (§2.5)
→ **Checkpoint A:** `tsc --noEmit` on api. It will still pass (cut files still exist).

**Step 3 — Backend: delete files** (whole sets atomically — a half-deleted import cluster
won't compile)
6. Delete `apps/api/src/strategy/` (entire dir)
7. Delete `apps/api/src/bot/` (entire dir incl. `__tests__`)
8. Delete the 12 `market/` files (§1C)
9. Delete the 5 route files (§1D) + 3 job files (§1E)
→ **Checkpoint B:** `tsc --noEmit` on api must pass clean.

**Step 4 — Frontend: detach references in survivors**
10. `CandlestickChart.tsx` — remove Market Intelligence block (§2.7) — do alone, typecheck after
11. `IndicatorToolbar.tsx` — remove toggle (§2.8)
12. `tradingStore.ts` — remove config key (§2.9)
13. `endpoints/signals.ts` — trim to `getLiquidityZones` (§2.6)
→ **Checkpoint C:** `tsc --noEmit` on web.

**Step 5 — Frontend: delete files**
14. Delete `OrdersTab.tsx`, `PositionsTab.tsx`, `TriggersTab.tsx`, `BotPage.tsx`,
    `__tests__/ordersTab.test.tsx`
15. Delete `components/competitions/ComparisonChart.tsx` + `TierBadge.tsx`, then remove the
    empty `components/competitions/` directory
16. Delete `endpoints/bot.ts`, `endpoints/portfolio.ts`, `endpoints/sim.ts`
17. (If confirmed) delete `MarketContext.tsx`, `MarketTab.tsx`
→ **Checkpoint D:** `tsc --noEmit` on web must pass clean.

**Step 6 — Final** — full typecheck both packages, run smoke tests, then commit.

**Step 7 — optional** — `config.ts` cleanup (§2.10). Lowest priority; do not touch
`botUserId`/`BOT_USER_ID` (market-maker bot, kept).

---

**Report path:** `./SUBCOMMIT_3B_PLAN.md`

---

## Post-execution corrections (2026-05-18)

The plan above was executed on branch `chore/cut-strategy-bot-market`. The
checkpoint structure (typecheck after every edit/delete batch + test suites)
caught **three issues** the read-only investigation missed. All three trace to
the same root cause: verification greps with **too-narrow path filters**. Future
readers should NOT trust the original plan's DEAD/delete lists blindly — use
this section as the correction of record.

### Correction 1 & 2 — two `market/` files were NOT dead (restored)

`market/candleBackfill.ts` and `market/orderBookService.ts` were listed as
"genuinely DEAD — verified 0 importers" in §1C. They are not dead — both are
imported by **KEEP files via relative intra-`market/` imports**:

- `market/krakenWs.ts:9` → `import { runBackfill } from "./candleBackfill.js"`
  (boot-time historical candle backfill, gated by `config.candleBackfillOnBoot`).
- `market/liquidityZones.ts:3` → `import { getDollarLiquidityAtPrice } from "./orderBookService.js"`
  (liquidityZones is KEEP-CHART; orderBookService is its dependency).

**Why missed:** the external-importer grep used `grep -v "/market/"` to exclude
the directory under analysis — which also hid *sibling* imports within `market/`.
Caught by **Checkpoint B** (API typecheck → `TS2307: Cannot find module`).
Both files were restored (`git checkout HEAD -- …`) and re-verified to pull in no
deleted dependency. **Net: `market/` deletions = 10 files, not 12.**

### Correction 3 — a stale backend test was missed (deleted)

`apps/api/tests/strategy-optimization.test.ts` imports exclusively from the
deleted `strategy/` directory (8 imports: `types`, `backtestTypes`, `monteCarlo`,
`regimeSegmentation`, `annualAnalysis`, `parameterRobustness`, `gridOptimizer`,
`optimizedOrchestrator`).

**Why missed:** the Step-4 test scan used `find . -path '*__tests__*'`, matching
only the `src/**/__tests__/` convention — it never looked at the flat
`apps/api/tests/` directory. Caught by the **API test suite step** (module-resolution
failure, not an assertion regression). The file was deleted — it tested only cut
code, consistent with the plan's "tests delete with the module" rule.

### Corrected tallies

- `market/` deletions: **10 files** (was 12 — `candleBackfill`, `orderBookService` restored).
- `candleBackfill.ts` + `orderBookService.ts` are **KEEP — live infrastructure
  surfaced during execution**, not in the original 12 KEEP `market/` files.
- Backend test deletions: **1** (`tests/strategy-optimization.test.ts`).
- Revised total LOC removed: **≈ 11,430** (was ≈ 11,750).

### Final verification (all green)

- Checkpoint A/B/C/D — API + web typecheck: **pass** (B passed after restore).
- API test suite: **17 suites / 214 tests passed**.
- Web test suite: **1 test passed** (`replayRoute.test.tsx`).
- Web production build: **success — 511 modules** (vs 512 baseline; the −1 is
  `endpoints/signals.ts` leaving the build graph after `getLiquidityZones` was
  relocated to `endpoints/marketData.ts`). The near-flat count is expected and
  reassuring: every deleted frontend file was a true orphan — orphans are not in
  the production module graph, so removing them does not change the count.
