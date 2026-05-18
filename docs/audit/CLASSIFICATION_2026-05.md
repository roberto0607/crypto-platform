# TRADR — `market/` + `strategy/` File Classification (2026-05-17)

Read-only. No code changed. Classifies all 48 files in `apps/api/src/market` (24) and `apps/api/src/strategy` (24).

**Method:** for each file, resolved its exact import path (`.js`-extension and `@/`-alias aware — basename grep produced false positives, e.g. web `@/lib/indicators` ≠ `strategy/indicators`), counted live importers across `apps/api/src` + `apps/web/src` (tests excluded), then applied the decision test: *output renders on the user's chart → KEEP-CHART; output tells the user/a bot what to trade → CUT-SIGNAL.*

**Headline:** of 10,327 LOC in these two directories, **2,277 KEEP / 3,750 CUT / 4,300 DEAD**. 78% is dead or cuttable signal/advisor code. The entire `strategy/` directory is signal/bot code (0 KEEP); 13 of its 24 files are an orphaned backtesting cluster with no live entry point.

---

## Classification Table

### `apps/api/src/market` (24 files, 5,984 LOC)

| File | LOC | Classification | Confidence | Imported by (count) | One-line purpose | Notes |
|---|---|---|---|---|---|---|
| krakenWs.ts | 370 | KEEP-INFRA | HIGH | 3 (app, server, healthRoutes) | Kraken websocket live price feed | Feeds snapshotStore → charts + fill pipeline. Core. |
| snapshotStore.ts | 104 | KEEP-INFRA | HIGH | 6 (phase6OrderService, replayEngine, marketMakerJob, slippageModel, close-orphan-positions, krakenWs) | In-memory latest-price snapshot store | Used directly by the order fill pipeline. Core. |
| perpetualBasisService.ts | 193 | KEEP-CHART | HIGH | 5 (server, basisRoutes, +3 market) | Perpetual funding rate / basis | Rendered by `FundingRatePanel.tsx`, `MarketContext.tsx`, CandlestickChart. CLAUDE.md "Stage 2 deployed". |
| liquidationEstimator.ts | 152 | KEEP-CHART | HIGH | 1 (v1Market route) | Estimated liquidation price levels | Rendered via `lib/liquidationLevelsPrimitive.ts` + IndicatorToolbar toggle. CLAUDE.md Stage 5. |
| onChainFlowService.ts | 383 | KEEP-CHART | HIGH | 4 (server, onChainRoutes, +2 market) | On-chain exchange in/outflow metrics | Rendered by `OnChainIndicators.tsx` + CandlestickChart. Also feeds signalNormalizer/marketIntelligence. |
| orderBookAggregator.ts | 251 | KEEP-CHART | HIGH | 5 (server, orderBookSignalRoutes, +3 market) | Aggregated order-book depth/heatmap data | Rendered on CandlestickChart + IndicatorToolbar toggle. Route is named `orderBookSignalRoutes` but output is a chart overlay. |
| optionsGammaService.ts | 444 | KEEP-CHART | LOW | 5 (server, gammaRoutes, +3 market) | Options gamma (GEX) exposure levels | Fetched + rendered in CandlestickChart, but not in CLAUDE.md "Already Built" list and also feeds signalNormalizer/regimeClassifier. See review list. |
| macroCorrelationService.ts | 380 | KEEP-CHART | LOW | 4 (server, macroRoutes, +2 market) | Macro asset correlation series | Rendered on CandlestickChart, but also feeds `CycleForecast.tsx` (a prediction/advisor view) + marketIntelligence; imports `strategy/regime`. See review list. |
| marketIntelligence.ts | 529 | CUT-SIGNAL | LOW | 1 (intelligenceRoutes) | Composite "Market Intelligence" advisor score | Aggregates regime + signalNormalizer + gamma + basis + onChain + orderBook + macro + signalLogger + weightAdjuster. Surfaced as an IndicatorToolbar toggle ("Market Intelligence", line 22). See review list. |
| regimeClassifier.ts | 439 | CUT-SIGNAL | LOW | 3 (server, regimeRoutes, marketIntelligence) | Market regime classification labels | Rule explicitly lists "regime labels" as CUT-SIGNAL. But regime output is also fetched by CandlestickChart. See review list. |
| signalNormalizer.ts | 279 | CUT-SIGNAL | HIGH | 2 (signalRoutes, marketIntelligence) | Normalizes raw inputs into composite signal scores | Pure advisor aggregation. Feeds marketIntelligence. |
| signalLogger.ts | 122 | CUT-INFRA | HIGH | 2 (learningRoutes, marketIntelligence) | Persists generated signals for the learning loop | Plumbing used only by the signal/advisor system. |
| weightAdjuster.ts | 135 | CUT-INFRA | HIGH | 2 (learningRoutes, marketIntelligence) | Adaptive re-weighting of signal inputs | The "ML/adaptive" tuning of the advisor; serves only signal code. |
| outcomeTracker.ts | 236 | CUT-INFRA | LOW | 1 (server) | Tracks whether past signals were correct | Background poller for the signal-learning loop; only `server.ts` boots it. See review list. |
| signalService.ts | 553 | DEAD | HIGH | 0 | Trading signal generation service | Largest dead file in the repo. Not imported anywhere. |
| binanceFutures.ts | 93 | DEAD | HIGH | 0 | Binance futures REST client | Not imported. |
| candleAggregator.ts | 133 | DEAD | HIGH | 0 | Aggregates ticks/trades into OHLC candles | Not imported; candles served elsewhere (`candles` route/repo). |
| candleBackfill.ts | 243 | DEAD | HIGH | 0 | Historical candle backfill | Not imported; separate `scripts/backfillCandles.ts` is the live one. |
| derivativesPoller.ts | 186 | DEAD | HIGH | 0 | Polls derivatives (funding/OI) data | Not imported. |
| krakenRest.ts | 94 | DEAD | HIGH | 0 | Kraken REST API client | Not imported (krakenWs does not use it). |
| liquidityZones.ts | 301 | DEAD | HIGH | 0 | Computes liquidity zone price levels | Not imported; web gets zones via `api/endpoints/signals` + `lib/liquidityZonesPrimitive.ts`. |
| orderBookService.ts | 80 | DEAD | HIGH | 0 | Order book service | Not imported. |
| orderFlowFeatures.ts | 184 | DEAD | HIGH | 0 | Order-flow feature extraction (delta etc.) | Not imported. |
| patternService.ts | 100 | DEAD | HIGH | 0 | Chart pattern detection | Not imported. |

### `apps/api/src/strategy` (24 files, 4,343 LOC)

| File | LOC | Classification | Confidence | Imported by (count) | One-line purpose | Notes |
|---|---|---|---|---|---|---|
| engine.ts | 390 | CUT-SIGNAL | HIGH | 3 (bot: strategyBotService, botTypes, botRunner) | Strategy decision engine — emits entry/exit/sizing decisions | Powers the automated strategy bot. Cutting `strategy/` removes the bot feature — see review list note. |
| signals.ts | 244 | CUT-SIGNAL | HIGH | 1 (engine) | `scanLongEntry` / `scanShortEntry` — entry signal generation | Textbook CUT-SIGNAL. |
| exits.ts | 238 | CUT-SIGNAL | HIGH | 1 (engine) | Exit-decision logic (stops, targets, trails) | Tells the bot when to close. |
| invalidation.ts | 136 | CUT-SIGNAL | HIGH | 1 (engine) | Signal/setup invalidation logic | Advisor logic. |
| sizing.ts | 54 | CUT-SIGNAL | HIGH | 1 (engine) | `computePositionSize` — position-size recommendation | Recommends how much to trade. |
| regime.ts | 34 | CUT-SIGNAL | HIGH | 1 (engine) | `classifyRegime` — regime labels for the engine | Rule explicitly lists regime labels as CUT-SIGNAL. |
| indicators.ts | 152 | CUT-INFRA | HIGH | 1 (engine) | ema/atr/adx/vwap math for the strategy engine | NOT the chart indicators (`apps/web/src/lib/indicators.ts` is separate). Serves only CUT-SIGNAL code. |
| tradeLogger.ts | 188 | CUT-INFRA | HIGH | 1 (engine) | Trade-log store for engine/backtests | Plumbing for the signal engine. |
| types.ts | 204 | CUT-INFRA | HIGH | ~11 (engine + strategy siblings + bot/strategyAdaptor) | Shared strategy type definitions | Type plumbing; consumed only by CUT-SIGNAL strategy files + bot. |
| backtestTypes.ts | 243 | CUT-INFRA | HIGH | 3 live (engine, bot/botTypes, bot/strategyBotService) | Strategy params types + `DEFAULT_PARAMS` | Type plumbing for the signal/bot system. |
| liquidity.ts | 127 | CUT-INFRA | LOW | 1 (engine) | Equal-high/low liquidity-level detection for entries | Could be read as CUT-SIGNAL (market-structure detection); used only by the engine. See review list. |
| optimizedOrchestrator.ts | 244 | DEAD | HIGH | 0 | Top-level backtest optimization orchestrator | Root of an orphan cluster — no route/script/bot reaches it. |
| backtestRunner.ts | 255 | DEAD | HIGH | 0 live | Orchestrates a single backtest run | Orphan backtest cluster. |
| backtest.ts | 184 | DEAD | HIGH | 0 live | Core backtest loop | Orphan backtest cluster. |
| backtestMetrics.ts | 276 | DEAD | HIGH | 0 live | Sharpe/drawdown/return metric computation | Orphan backtest cluster. |
| backtestConfig.ts | 46 | DEAD | HIGH | 0 live | Backtest configuration constants | Orphan backtest cluster. |
| walkForward.ts | 279 | DEAD | HIGH | 0 live | Walk-forward optimization/validation | Orphan backtest cluster. |
| gridOptimizer.ts | 182 | DEAD | HIGH | 0 live | Grid-search parameter optimization | Orphan backtest cluster. |
| monteCarlo.ts | 123 | DEAD | HIGH | 0 live | Monte Carlo simulation of backtest results | Orphan backtest cluster. |
| parameterRobustness.ts | 131 | DEAD | HIGH | 0 live | Parameter robustness testing | Orphan backtest cluster. |
| regimeSegmentation.ts | 189 | DEAD | HIGH | 0 live | Segments backtest results by regime | Orphan backtest cluster. |
| annualAnalysis.ts | 117 | DEAD | HIGH | 0 live | Per-year backtest performance breakdown | Orphan backtest cluster. |
| sensitivity.ts | 157 | DEAD | HIGH | 0 live | Parameter sensitivity analysis | Orphan backtest cluster. |
| dataValidation.ts | 150 | DEAD | HIGH | 0 live | Validates candle data for backtests | Orphan backtest cluster. |

**Note on the orphan backtest cluster (13 files):** these files import each other, but no route, script, job, `app.ts`, `server.ts`, or `bot/` file imports any of them — `optimizedOrchestrator.ts` (the cluster root) has zero importers. The rule's literal "not imported anywhere" is satisfied only by the root, but the cluster as a whole is unreachable from any live entry point and is therefore classified DEAD in its entirety. Confidence HIGH that it is effectively dead/cuttable.

---

## KEEP files — 2,277 LOC (8 files)

KEEP-CHART (6 files, 1,803 LOC): `perpetualBasisService.ts` (193), `optionsGammaService.ts` (444), `liquidationEstimator.ts` (152), `onChainFlowService.ts` (383), `macroCorrelationService.ts` (380), `orderBookAggregator.ts` (251).

KEEP-INFRA (2 files, 474 LOC): `krakenWs.ts` (370), `snapshotStore.ts` (104).

All KEEP files are in `market/`. `strategy/` has zero KEEP files.

---

## CUT files — 3,750 LOC (16 files)

CUT-SIGNAL (9 files, 2,343 LOC): `marketIntelligence.ts` (529), `regimeClassifier.ts` (439), `signalNormalizer.ts` (279); `strategy/engine.ts` (390), `strategy/signals.ts` (244), `strategy/exits.ts` (238), `strategy/invalidation.ts` (136), `strategy/sizing.ts` (54), `strategy/regime.ts` (34).

CUT-INFRA (7 files, 1,407 LOC): `signalLogger.ts` (122), `weightAdjuster.ts` (135), `outcomeTracker.ts` (236); `strategy/indicators.ts` (152), `strategy/tradeLogger.ts` (188), `strategy/types.ts` (204), `strategy/backtestTypes.ts` (243), `strategy/liquidity.ts` (127).

(CUT-INFRA total above is 8 files / 1,407 LOC — counting correction; CUT total = CUT-SIGNAL 2,343 + CUT-INFRA 1,407 = 3,750 LOC across 17 files.)

---

## DEAD files — 4,300 LOC (23 files)

`market/` DEAD (10 files, 1,967 LOC): `signalService.ts` (553), `liquidityZones.ts` (301), `candleBackfill.ts` (243), `derivativesPoller.ts` (186), `orderFlowFeatures.ts` (184), `candleAggregator.ts` (133), `patternService.ts` (100), `krakenRest.ts` (94), `binanceFutures.ts` (93), `orderBookService.ts` (80).

`strategy/` DEAD (13 files, 2,333 LOC — the orphan backtest cluster): `walkForward.ts` (279), `backtestMetrics.ts` (276), `backtestRunner.ts` (255), `optimizedOrchestrator.ts` (244), `regimeSegmentation.ts` (189), `backtest.ts` (184), `gridOptimizer.ts` (182), `sensitivity.ts` (157), `dataValidation.ts` (150), `parameterRobustness.ts` (131), `monteCarlo.ts` (123), `annualAnalysis.ts` (117), `backtestConfig.ts` (46).

---

## LOW-CONFIDENCE files needing human review (6)

1. **`market/marketIntelligence.ts`** (529 LOC) — *Recommended: CUT-SIGNAL.* It is a composite "what's the market telling me" advisor score, which is the canonical CUT case. But it is wired as a user-facing chart indicator toggle (`IndicatorToolbar.tsx:22`, "Market Intelligence"). **Human call:** if you keep "Market Intelligence" as a chart feature, reclassify it KEEP-CHART — and then its dependencies `signalNormalizer`, `regimeClassifier`, `signalLogger`, `weightAdjuster` flip from CUT to KEEP-INFRA. If you are cutting advisor sprawl (per AUDIT §9), cut it.

2. **`market/regimeClassifier.ts`** (439 LOC) — *Recommended: CUT-SIGNAL.* The rule explicitly enumerates "regime labels" as CUT-SIGNAL, so I followed that. The ambiguity: regime output is also fetched by `CandlestickChart.tsx`, and a regime label is arguably descriptive ("what is happening") rather than prescriptive. **Human call:** if regime is shown purely as a chart annotation you want to keep, it's KEEP-CHART; if it's an input to the advisor, CUT.

3. **`market/macroCorrelationService.ts`** (380 LOC) — *Recommended: KEEP-CHART.* It renders on `CandlestickChart.tsx`, which qualifies it. The doubt: it also feeds `CycleForecast.tsx` (a price-target/inflection *prediction* view — advisor-flavored) and `marketIntelligence`, and it imports `strategy/regime`. **Human call:** depends whether the Cycle pages survive the cut. If Cycle is cut, re-check whether macro still has a chart consumer.

4. **`market/optionsGammaService.ts`** (444 LOC) — *Recommended: KEEP-CHART.* Gamma/GEX levels are fetched and drawn in `CandlestickChart.tsx`. The doubt: gamma is NOT in CLAUDE.md's "Already Built" indicator list, and it also feeds `signalNormalizer`/`regimeClassifier`/`marketIntelligence`. It may be a half-finished chart feature. **Human call:** confirm the gamma overlay actually renders for users; if it's experimental/unfinished, treat as CUT or DEAD-adjacent.

5. **`market/outcomeTracker.ts`** (236 LOC) — *Recommended: CUT-INFRA.* It tracks whether past signals were correct and is booted only by `server.ts` as a background poller. It is plumbing for the signal-learning loop, so it falls with the signal system. The doubt: nothing classified CUT-SIGNAL imports it directly (only `server.ts`), so it sits between CUT-INFRA and "effectively dead once signals are cut." **Human call:** cut it together with the signal stack.

6. **`strategy/liquidity.ts`** (127 LOC) — *Recommended: CUT-INFRA.* It detects equal-high/low liquidity levels consumed only by `strategy/engine.ts`. Classified CUT-INFRA because it is a computation feeding a CUT-SIGNAL file. The doubt: liquidity-level detection could itself be read as a CUT-SIGNAL ("here's where price will hunt"). Either way it is cut — the label is the only open question.

**Cross-cutting note for review:** classifying all of `strategy/` as CUT means **deleting the automated strategy bot feature** — `strategy/engine.ts` exists only to power `apps/api/src/bot/`. That is consistent with AUDIT §9 ("the competitive 1v1 match is the wedge; everything else is a distraction"), but it is a product decision, not just a file-cleanup decision. Confirm the strategy bot is intended to be cut before removing `strategy/`.

---

Report path: `./CLASSIFICATION_2026-05.md`
