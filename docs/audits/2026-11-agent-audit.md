# Trading-agent system audit (2026-11-10)

**Scope:** the agent pipeline end to end, from the Scanner LLM through to orders and the AGENT ACTIVITY panel. It is read-only: no code was changed. Base commit: `ec8f5c0` (origin/main after PR #242).

**Method:** I read the source. I also ran read-only queries against the **local dev** database (`tradr_postgres`, port 5435) to see how the pipeline behaved in practice. I did not connect to production, read Railway variables, or open any `.env` file.

---

## TL;DR

1. **A complete five-stage pipeline exists and is merged:** Scanner (LLM) → Chart Analysis (LLM) → Risk (rules) → Execution (rules) → protective OCO. A News gate (rules) can block execution. All five stages are AND-gated behind `AGENTS_ENABLED`, which defaults to **false when `NODE_ENV=production`** (`apps/api/src/config.ts:57`). That is why prod is idle.
2. **All agent activity trades one shared bot account,** `riskagent@system.local` (id `…0002`), in its free-play wallet. There are no per-user agents. The bot cannot trade inside a match or competition: `matchId` is hard-coded to null and the bot can't be challenged.
3. **The AGENT ACTIVITY panel is empty for three independent reasons.** (a) No agent runs in prod. (b) Only the Risk and Execution agents publish `agent.decision`, so Scanner and Chart Analysis activity never shows. (c) The panel has no history: it's an in-memory store fed only by live SSE, so every page load starts empty.
4. **The decision quality is weak by construction.**
   - Chart Analysis *must* return a trade for every candidate. Its output schema has no "no trade" option.
   - Its indicator tool returns no current price and no candles.
   - The regime classifier is **never invoked**, so the regime tag the agents read is stale or null.
   - The Scanner ranks pairs on **daily** candles, so running it more often than hourly adds cost without adding information.
5. **Safety has real holes for "live":**
   - No daily-loss limit and no max-open-positions limit.
   - The bot is a *system user*, so it skips the buying-power check and `max_order_notional`.
   - The kill switch also blocks the emergency *flatten* order.
   - The recovery job can create a **duplicate stop/target leg**.
   - With more than one API instance, every proposal is generated (and paid for) once per instance.
6. **Locally, the pipeline is wedged:** 114 of 120 Risk decisions are rejections. Risk reservations are released only when a position is completely flat, so a few open bot positions pin total open risk above the 5% cap indefinitely. Separately, 333 Scanner runs failed with "credit balance too low".
7. **Recommendation:** use the hybrid design. A deterministic rule strategy decides; a cheap LLM writes the explanation for the activity panel. Phase 1 is a single agent, one pair, in its own practice wallet, behind a flag, with a working kill switch and a persisted decision log. Estimate: **~6–8 dev-days**. Running cost is negligible on Haiku 5.5.

---

## 1. What exists

### 1.1 Backend source (`apps/api/src/`)

| Area | File | Role |
|---|---|---|
| Scanner | `agents/scanner/rank.ts` | Deterministic shortlist: daily range % × volume ratio, top 8 (`:67-100`, `:148`) |
| | `agents/scanner/runner.ts` | **LLM** tool-use loop (Haiku 4.5) over the shortlist (`:236-334`) |
| | `agents/scanner/regimeClassifier.ts` | Rule-based trending/ranging/volatile-chop on 4h ATR/EMA. **`runRegimeClassification()` (`:134`) has no caller** |
| | `agents/scanner/newsClient.ts` | `cryptocurrency.cv` news feed for the `getNews` tool (`:35`) |
| | `agents/scanner/fearGreedClient.ts` | Alternative.me Fear & Greed index (used only by the dead regime classifier) |
| Chart Analysis | `agents/chartAnalysis/chartAnalysisEngine.ts` | Subscribes to `scanner.result` and runs the LLM once per candidate, sequentially (`:37-82`) |
| | `agents/chartAnalysis/runner.ts` | **LLM** loop (Haiku 4.5) that inserts a `trade_proposals` row (`:307-352`, `:363-475`) |
| Risk | `agents/riskAgent/riskEngine.ts` | Subscribes to `chart_analysis.proposal_created` (`:41-53`) |
| | `agents/riskAgent/evaluator.ts` | Deterministic sizing and caps: approve, reject or expire (`:74-275`) |
| | `agents/riskAgent/reservationRepo.ts` | Open-risk sum and reservation insert (`:15-40`) |
| | `agents/riskAgent/botSetup.ts` | Checks the bot user exists and creates/funds its free-play wallets (`:24-37`) |
| Execution | `agents/executionAgent/executionAgentEngine.ts` | Subscribes to `risk_agent.proposal_approved` |
| | `agents/executionAgent/executor.ts` | News gate, stale-price gate, tolerance check, MARKET order, OCO, auto-flatten, human alert (`:188-770`) |
| Shared | `agents/shared/agentDecisionRepo.ts`, `runLogPolicy.ts`, `parseAgentOutput.ts`, `regimeTagRepo.ts` | Decision log insert, run-log sampling, JSON extraction from model text, latest regime tag |
| Schemas | `agents/schemas/*.ts`, `agents/schemas/toolCalls/*.ts` | Zod schemas. `commitDrawing`, `setChartConfig` and `getOpenPositions` are **defined but never used** |
| Jobs | `jobs/definitions/scannerAgentJob.ts` | Interval job, default every 1800 s (`config.ts:326`) |
| | `jobs/definitions/newsAgentJob.ts` | APITube sentiment poll every 600 s; upserts `pair_news_flags` (`:268-305`) |
| | `jobs/definitions/executionAgentRecoveryJob.ts` | Every 60 s: re-protects or flattens `executed` proposals that are missing a leg. **Not gated by any agent flag** |
| | `jobs/definitions/agentHealthWatchdogJob.ts` | Every 300 s: logs `agent_health_watchdog_unhealthy` when Scanner or Chart Analysis has had no success for 90 min, or News for 35 min |
| Wiring | `app.ts:404-417`, `server.ts:80-82` | Engines start only when their flag is on |
| | `server.ts:105-108` | Boot log `devMode.{agentsEnabled, chartAnalysisAgentEnabled, riskAgentEnabled, executionAgentEnabled}` |
| Order path | `trading/phase6OrderService.ts:144-153` | Kill switch for `source='agent'` orders |
| | `trading/matchingEngine.ts:240` | `MARKET_SYMBOLS` backstop |
| | `trading/buyingPower.ts:92-93` | Bot counts as a system user |
| Kill switch | `system/systemFlagService.ts:35-39` | Reads the `AGENT_ACTIONS_ENABLED` row; a missing row means enabled |
| | `routes/betaAdminRoutes.ts:151-170` | `POST /v1/admin/system/agent-actions` (ADMIN) |
| | `routes/riskRoutes.ts:13-22` | `GET /v1/risk/status` returns `agent_actions_allowed` |
| Events | `events/eventTypes.ts:300-375`, `:433-436` | `scanner.result`, `chart_analysis.proposal_created`, `risk_agent.proposal_approved`, `agent.decision`, all **broadcast** |
| Test script | `scripts/agentConcurrencyTest.ts` | Track 2 direct-invocation race test for Risk and Execution |

There are **no HTTP read endpoints** for `trade_proposals`, `agent_decisions` or `agent_run_logs` (grep of `routes/` finds none).

### 1.2 Database (migrations in `apps/api/migrations/`)

| Migration | Object | Notes |
|---|---|---|
| 077 | `system_flags` row `AGENT_ACTIONS_ENABLED` | Seeded `{"enabled": true}` |
| 078 | `orders.source` | `'agent'` is gated; null means manual |
| 079, 083–085, 088–090 | `trade_proposals` | Lifecycle `pending → approved/rejected/expired → executed/execution_failed`; `chart_config`; nullable `qty`; server-computed stop distance; `flatten_order_id`; `human_alerted_at` |
| 080 | `agent_decisions` | Per-decision log. `outcome_30m/1h/4h` grading columns exist, but **no grading job exists** |
| 081 | `agent_run_logs` | One row per LLM run (sampled), with `cost_usd` and `latency_ms`. Retention is 14 days (`RETENTION_AGENT_RUN_LOG_DAYS`) |
| 082 | `regime_tags` | Never written in normal operation (see §6) |
| 086 | user `00000000-0000-0000-0000-000000000002` | `riskagent@system.local`, the account every agent trade uses |
| 087 | `risk_reservations` | Released only when the pair's position is completely flat |
| 088 | `trigger_orders.trade_proposal_id` | Links the OCO legs to their proposal |
| 091 | `pair_news_flags` | One row per pair, with a 45-min expiry |

### 1.3 Web (`apps/web/src/`)

| File | Role |
|---|---|
| `components/AgentActivityPanel.tsx` | Floating button and panel (`:72-130`), plus a toolbar toggle (`:138-158`) |
| `stores/agentActivityStore.ts` | Zustand store: in-memory, capped at 100 entries, **not persisted, no fetch** |
| `api/sse.ts:333`, `hooks/useSSE.ts:170` | `agent.decision` → `addDecision` |
| `layouts/AppLayout.tsx:385`, `components/trading/TradeToolbar.tsx:469` | Mount points |
| `types/api.ts:575` | `AgentDecisionEvent` type |

### 1.4 Railway variables to check on service `crypto-platform` (names only)

**Run it with `--service crypto-platform`** (see the CLAUDE.md secrets discipline). For the key variables, check presence only, never the value.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | When `production`, `AGENTS_ENABLED` defaults to false |
| **`AGENTS_ENABLED`** | false in prod | Master switch, ANDed into every flag below |
| `SCANNER_AGENT_ENABLED` | false | Scanner job (LLM) |
| `SCANNER_AGENT_INTERVAL_SECONDS` | 1800 | Scanner cadence |
| `CHART_ANALYSIS_AGENT_ENABLED` | false | Chart Analysis engine (LLM) |
| `RISK_AGENT_ENABLED` | false | Risk engine |
| `EXECUTION_AGENT_ENABLED` | false | Execution engine (places orders) |
| `NEWS_AGENT_ENABLED` | false | News sentiment job |
| `ANTHROPIC_API_KEY` | — | Needed by Scanner and Chart Analysis (presence only) |
| `NEWS_API_KEY` | — | APITube, used by the News job (presence only) |
| `RISK_AGENT_BOT_USER_ID` | `…0002` | **Gotcha:** the config comment says to set a random UUID, but migration 086 creates only `…0002`. Any other value makes `ensureRiskAgentBotSetup` throw (`botSetup.ts:29-31`) |
| `OPS_ALERT_EMAIL` | empty | Recipient for the "unprotected position" email |
| `DISABLE_JOB_RUNNER` | false | When true, no Scanner, News or recovery jobs run |
| `AGENT_LOG_SAMPLE_RATE`, `AGENT_LOG_HEARTBEAT_MINUTES`, `RETENTION_AGENT_RUN_LOG_DAYS` | 0.05 / 30 / 14 | Run-log volume |
| `QUEUE_TIMEOUT_MS` | 5000 | Reused as the Execution Agent's order timeout (`executor.ts:376`) |

There are two ways to check without reading secrets:

- **Boot log:** search the prod logs for the boot line that carries `devMode.agentsEnabled` (`server.ts:105`).
- **DB flag:** `GET /v1/risk/status` returns `agent_actions_allowed`.

Related systems that are **not** this pipeline: the market-maker bot (`marketMakerJob.ts`, `config.botUserId`) and ML signals (`ML_SERVICE_URL`, `ML_PREDICTION_ENABLED`).

---

## 2. How an agent decides

The pipeline mixes an **LLM for judgment** with **rules for sizing and safety**:

```
scanner-agent job (every 30 min, advisory-locked)
  └─ rank.ts: deterministic top-8 by (daily range %) × (today vol / 20-day avg vol)
  └─ Scanner LLM (Haiku 4.5): read-only tools → ranked candidates + reasoning
      publish scanner.result (broadcast)
        └─ Chart Analysis LLM (Haiku 4.5), once per candidate, sequential
            → trade_proposals row: side, entry, stop, target, reasons, confidence
            publish chart_analysis.proposal_created
              └─ Risk Agent (rules): 1% risk sizing, 20% notional cap, 5% total-open-risk cap
                  publish risk_agent.proposal_approved + agent.decision
                    └─ Execution Agent (rules): news gate → stale-price gate → tolerance gate
                        → MARKET order → STOP_MARKET + TAKE_PROFIT_MARKET OCO
                        publish agent.decision
```

- **Provider and model:** Anthropic, `claude-haiku-4-5-20251001`. Scanner model is set at `scanner/runner.ts:43`, Chart Analysis at `chartAnalysis/runner.ts:51`. Both use a hand-written tool loop with `MAX_ITERATIONS = 8` and `max_tokens = 4096`. No prompt caching, thinking or structured outputs are used. JSON is extracted from free text (`parseAgentOutput.ts`).
- **Prompts:**
  - Scanner: `scanner/runner.ts:57-68`.
  - Chart Analysis: `chartAnalysis/runner.ts:65-80`.
  - Both tell the model to treat tool output as data, a prompt-injection guard for news text.
- **Inputs (tools):**
  - `getIndicators` returns **only the latest value** of EMA20/50/200, RSI, ATR, MACD, Bollinger Bands, VWAP, delta, CVD and VPVR POC/VAH/VAL, computed over the last 300 candles (`routes/v1/v1Market.ts:228-300`).
  - `getFundingRate` / `getOpenInterest` cover BTC/ETH/SOL.
  - `getNews` returns 5 articles.
  - `getRegimeTag` reads the latest `regime_tags` row.
- **What the model never sees:** the current price or last close, the candle series, the order book, positions or balances. The prompt (`chartAnalysis/runner.ts:73`) says to derive entry "from the current price", but no tool returns one. The model has to infer it from EMA, VWAP or the Bollinger middle.
- **No option to pass:** `chartAnalysisResultSchema` (`schemas/chartAnalysisResult.ts:33`) requires `side`, `entry`, `stop` and `target`, so every candidate becomes a proposal. Locally, Chart Analysis wrote 126 proposals with an average confidence of 55 and an average stop distance of 3.05%.
- **Cadence and triggers:**
  - Scanner runs on the interval job.
  - The other three agents are event-driven, in process, through `subscribeGlobal`.
  - The News job polls every 10 min.
  - The recovery job runs every 60 s.
- **Universe:** active pairs that have 1d candles in the last 21 days. With `MARKET_SYMBOLS` set to BTC/ETH/SOL, the shortlist is at most 3 pairs in practice. `rank.ts:121` filters on `trading_pairs.is_active`, not on `MARKET_SYMBOLS`, but `matchingEngine.ts:240` rejects non-tradable pairs anyway.

---

## 3. How an agent trades

- **Code path:** `executor.ts:366-374` calls `placeOrderWithSnapshot` **directly in process**. This bypasses the HTTP route and the order queue.
  - The call is `(botUserId, {pairId, side, type: "MARKET", qty}, "execution-agent:<proposalId>", undefined, null /*competition*/, null /*match*/, "agent")`.
  - The protective legs use `createTriggerOrder` with `matchId: null` (`executor.ts:558-583`).
  - Auto-flatten is a second `source:"agent"` MARKET order (`:630-638`).
- **Wallet and scope:** the bot user's **free-play** wallets only. They are funded with the standard starting capital through `autoCreateWallets(botUserId, null)` (`botSetup.ts:34`). The bot never uses practice, match or competition wallets.
- **Authentication:** none. It is a trusted in-process call, with no JWT and no API key.
  - The "API-key leaderboard quirk" in `docs/followups.md:1183` is unrelated: it's about a human's `ApiKey` header counting as logged out on the public leaderboard.
  - API keys do matter for a *user-run* external bot; see §4.
- **Same pipeline as a human?** Mostly yes: `placeOrderWithSnapshot` → `placeOrderTx` under the same pair lock.

| Rule | Agent order | Notes |
|---|---|---|
| Fees | Same: taker `pair.taker_fee_bps` (`feeCalc.ts:29-34`) | Only the market-maker bot gets 0 maker fee |
| Slippage / fill model | Same book-walk + collar (`matchingEngine.ts:247-256`) | |
| Stale price | Same `stale_price_source` reject, plus an earlier executor gate (`executor.ts:298`) | |
| `MARKET_SYMBOLS` | Same (`matchingEngine.ts:240`) | |
| Leverage | Never sent, so 1x SPOT | |
| **Buying-power 2× rule** | **Skipped**: bot is a system user (`buyingPower.ts:93`, `matchingEngine.ts:660`) | Can go arbitrarily short or long |
| **`max_order_notional`** | **Skipped** for system users (`phase6OrderService.ts:194`) | The Risk Agent's 20% cap is the only size cap |
| Reduce-only | Entry: no (correct). SL/TP fires: yes, enforced by the trigger engine (`triggerEngine.ts:190`) | Auto-flatten is **not** reduce-only (`executor.ts:632`) |
| Idempotency key | `execution-agent:<proposalId>` / `…:flatten` | |
| Kill switch | `source='agent'` only | Trigger fires carry `source` null, so SL/TP keep working when the switch is off |

---

## 4. Safety

### What exists
- **Sizing** (`evaluator.ts:30-43`):
  - 1% of equity at risk per trade.
  - Notional of at most 20% of equity per trade.
  - Total open reserved risk of at most 5% of equity.
  - The risk check runs under an advisory lock (`:89`) and a row lock with an outcome re-check (`:91-104`).
- **Execution gates** (`executor.ts`):
  - News flag blocks the trade; a failed news check lets it proceed (`:258-284`).
  - Fallback price rejects the trade (`:298-309`).
  - Drift beyond half the stop distance rejects the trade (`:69-93`, `:311-329`).
  - The order is bounded by `QUEUE_TIMEOUT_MS` (`:375-378`).
- **Idempotency:**
  - The `FOR UPDATE` row lock is held across order placement, and `executed` is committed before the OCO is registered (`:394-422`).
  - A second layer is the order idempotency key.
- **Protection:**
  - The OCO is retried 3×. If it still fails, any surviving leg is canceled and the position flattened.
  - The recovery job retries every 60 s.
  - A human gets one email when the recovery retry also fails (`:474-499`, migration 090).
- **Kill switch:** `AGENT_ACTIONS_ENABLED`, toggled with `POST /v1/admin/system/agent-actions` (ADMIN, audit-logged). Covered by `trading/__tests__/agentKillSwitch.test.ts`.
- **Matches and competitions:**
  - The agent **cannot** trade in a 1v1 or a competition: `matchId`/`competitionId` are hard-coded null.
  - The bot can't be challenged (`competitions/challenges.ts:30`, through `isSystemUser`).
  - It can't trade any wallet but the bot's, because the user id comes from config.

### Gaps (ranked)
1. **No loss or exposure limits beyond per-trade sizing.** There is no daily-loss stop, no max-drawdown halt, no max open positions, no max trades per day, and no per-pair cooldown. Two proposals on the same pair **net into one position** (positions are per user, pair and scope), while their reservations and OCO pairs stay separate.
2. **The bot is exempt from buying power and `max_order_notional`.** Those exemptions exist for the market maker. An agent should trade under the same rules as a human.
3. **The kill switch blocks the emergency flatten.** The flatten is `source:"agent"`, so with the switch off, `registerProtectionOrFlatten` can't close an unprotected position and goes straight to the human-alert path. The switch also **doesn't stop LLM spend or proposals**. Everything upstream keeps running, and each approval ends as `execution_failed`.
4. **The recovery job can duplicate a leg.**
   - Its query selects rows with fewer than 2 distinct leg kinds (`executionAgentRecoveryJob.ts:26-40`).
   - `registerProtectionOrFlatten` always starts with both leg ids null (`executor.ts:551-552`), so a row that already has one leg gets a **second copy of that leg** in a new OCO group.
   - The test at `executionAgentRecoveryJob.test.ts:157` mocks this function, so it doesn't catch the bug.
   - The job is also not gated by `EXECUTION_AGENT_ENABLED` or `AGENTS_ENABLED`.
5. **Multiple instances multiply work.** Redis relay delivers every event to every instance's global handlers (`eventBus.ts:86`, `:228-229`).
   - With N API instances, each `scanner.result` runs Chart Analysis N times. That is N× the LLM cost and N **distinct** proposals for the same idea, each of which can be approved and executed.
   - Risk and Execution are idempotent per proposal, but not across duplicate proposals.
6. **Risk reservations leak until the position is completely flat** (`reservationRepo.ts:15-29`, a documented v1 simplification). Locally this wedged the pipeline: total open risk was about $5,970 against about $5,000 in cap, and 114 of 120 decisions were `rejected`.
7. **Orphans on timeout.** Losing the `Promise.race` does not cancel the order (`executor.ts:357-363`, a known limitation). A late fill leaves an unlinked bot position.
8. **Stale proposals:**
   - `pending` proposals never expire unless the Risk Agent evaluates them; there's no sweeper. Locally, 56 are stuck pending.
   - `stale_price_source` is a real, recurring rejection mode (`docs/followups.md:815-880`).
9. **No LLM budget or rate guard.** There is no daily dollar cap, no circuit breaker on repeated errors (locally: 333 consecutive "credit balance too low" runs), and no overlap guard on `processShortlist` if a cycle runs long.
10. **External user bots (API keys):**
    - `requireScope()` (`auth/requireUser.ts:79`) is **never applied to any route**, so a `read`-scoped key can place orders.
    - An API-key caller can pass `scope: MATCH` (`tradingRoutes.ts:219`, `resolveTradeScope`), so **a user's own bot can trade inside their 1v1** with nothing to mark or forbid it.
    - Orders placed with an API key aren't tagged with `orders.source`.
11. **Internal events go to every SSE client.** `scanner.result`, `chart_analysis.proposal_created`, `risk_agent.proposal_approved` and `agent.decision` are broadcast to all logged-in users' streams (`v1Events.ts:40`; only price, candle, book and mark events are pair-scoped). Risk decisions include the bot's equity and sizing math.

---

## 5. The AGENT ACTIVITY panel: why it's empty

**What it expects:** `agent.decision` SSE frames carrying `{agentName, pairId, decision, reasoning, tradeProposalId, priceAtDecision}` (`eventTypes.ts:365-372`). The frames are delivered as a broadcast, and `useSSE.ts:170` appends them to `agentActivityStore`. Nothing else feeds the store: there is no REST fetch, no persistence and no backfill.

**Why it's empty, in order:**
1. **Nothing runs in prod.** `AGENTS_ENABLED` defaults to false under `NODE_ENV=production` (`config.ts:57`), so all five flags evaluate false and no engine subscribes (`server.ts:80-82`). No `agent.decision` events are ever published.
2. **Even with agents on, only Risk and Execution publish to the panel.** They publish in `evaluator.ts:121,254,301` and `executor.ts:166,425,733`. Scanner and Chart Analysis publish only their internal hand-off events, so an environment running just those two stays empty.
3. **No history.** The store is in memory, so a page reload, a new tab or a late join shows "No agent activity yet" until the *next* live decision. With a 30-min scanner cadence and about 3 candidates, that can take most of an hour.
4. **Upstream dependencies.** The panel needs `ANTHROPIC_API_KEY` *with credit*. Locally, every recent scanner run failed before producing candidates, so nothing reached Risk.

**Fix shape (part of Phase 1):**
- Add `GET /v1/agents/activity?limit=50` over `agent_decisions`, joined to `trade_proposals`, and seed the store from it on mount.
- Publish a decision event from every stage, including "no trade" and errors.
- Scope it to admins, or to the owning user once agents are per-user.

---

## 6. Tests, dead code, half-built pieces

### Tests
The tests are vitest, and nearly all are unit tests with a mocked `pool`. There are about 205 cases:

| File | Cases |
|---|---|
| `executeTradeProposal.test.ts` | 34 |
| `evaluator.test.ts` | 18 |
| `chartAnalysis/runner.test.ts` | 15 |
| `newsAgentJob.test.ts` | 14 |
| `newsClient.test.ts` | 13 |
| `executionAgentRecoveryJob.test.ts` | 11 |
| `parseAgentOutput.test.ts` | 10 |
| scanner runner, rank, regime, `runLogPolicy`, watchdog | 9 each |
| `executionAgentEngine.test.ts`, `chartAnalysisEngine.test.ts` | 7 each |
| `executor.test.ts` | 6 |
| `scannerAgentJob.test.ts` | 4 |
| `agentKillSwitch.test.ts` (real DB) | 2 |
| `AgentActivityToggle.test.tsx` (web) | — |

**Not covered:**
- An end-to-end run from proposal through Risk and Execution to a real order and OCO against a real DB. Only the manual `agentConcurrencyTest.ts` script does this.
- The recovery job's partial-leg path against real `trigger_orders`; this is where the duplicate-leg bug lives.
- Multi-instance event fan-out.
- Kill switch × flatten interaction.
- Reservation release.
- Any evaluation of LLM output quality: no eval set, no backtest, and no outcome grading.

### Dead or half-built code
- `runRegimeClassification()` is never called, so `regime_tags` is never refreshed. `getLatestRegimeTag` (`regimeTagRepo.ts:15-20`) has **no age limit**: in any DB where a manual run once happened, agents get a months-old regime presented as current. Locally there are 75 rows, all from 2026-07-30.
- `agent_decisions.outcome_*` / `graded_at`: there is no grading job, so no agent performance is measured.
- `trade_proposals.chart_config`: written but never displayed.
- `trade_proposals.top_features` / `forecast`: never written.
- The `commitDrawing`, `setChartConfig` and `getOpenPositions` tool schemas are never used.
- The gate design docs that code comments cite ("Gate 1b–1f design doc / design lock") are **not in the repo**.
- There is no admin UI for the kill switch and no read API for proposals, decisions or run logs.

---

## 7. Cost

**No measured token data exists.** `agent_run_logs` retention is 14 days, and every local run in that window failed before calling the model (0 tokens). The figures below are estimates from the prompt, tool and loop shape. The first action once anything runs should be `SELECT avg(cost_usd) FROM agent_run_logs GROUP BY agent_name`.

**Per-run estimates (current design):**
- **Scanner:** system prompt plus tool definitions are about 1.5K tokens, resent every iteration. Each iteration runs parallel tool calls for each pair; with news (5 articles), that adds about 1K tokens of results per pair. Over about 4 iterations with growing context: **about 45K input and 3K output tokens.**
- **Chart Analysis, per candidate:** about 4 iterations, with context growing from 2K to 8K: **about 20K input and 2K output tokens.**
- **One cycle:** 1 Scanner run plus about 3 candidates (BTC/ETH/SOL), so about 105K input and 9K output tokens. With 8 candidates, about 205K input and 19K output.

Monthly cost at about 3 candidates per cycle (with 8 candidates, multiply by about 1.9):

| Cadence | Cycles/mo | Haiku 4.5 ($1/$5, current) | Haiku 5.5 ($0.10/$0.50) | Sonnet 5.5 ($2/$10) | Opus 5.5 ($4/$20) |
|---|---|---|---|---|---|
| per cycle | — | ~$0.15 | ~$0.015 | ~$0.30 | ~$0.60 |
| 1 hour | 720 | ~$108 | ~$11 | ~$216 | ~$432 |
| 30 min (default) | 1,440 | ~$216 | ~$22 | ~$432 | ~$864 |
| 15 min | 2,880 | ~$432 | ~$43 | ~$864 | ~$1,730 |
| 1 min | 43,200 | ~$6,500 (*not achievable: a cycle takes 1–3 min*) | ~$650 | ~$13,000 | ~$26,000 |

- **Cadence:** a cadence shorter than 1 h buys almost nothing, because `rank.ts` uses **daily** candles.
- **Caching:** prompt caching of the system prompt plus tools would cut repeated input, but the fixed prefix is about 1.5K tokens, near or below the minimum cacheable prefix on some models. The bigger savings are shorter loops and dropping news text from Chart Analysis.
- **Recommended hybrid (§8, option C):** the LLM is called only to *explain* a rule decision, once per actual signal. That's about 3K input and 300 output tokens per call, so about **$0.0005 per explanation on Haiku 5.5**. At 1-min evaluation with ~20 signals a day, that is **under $1/month**. A 1-min rule evaluation is free.

---

## 8. Gaps to "live and making decisions", options, recommendation

### 8.1 Gap list (dev-day estimates)

| # | Gap | Effort |
|---|---|---|
| G1 | Per-agent account in a **practice** wallet scope instead of the bot's free-play wallet; no system-user exemptions (normal buying power and `max_order_notional`) | 1–1.5 d |
| G2 | Hard limits: max position notional, max open positions, max trades/day, **daily-loss halt**, per-pair cooldown, one position per pair | 1 d |
| G3 | Kill switch that (a) stops the *decision loop*, not just orders, and (b) never blocks risk-reducing orders (make the flatten reduce-only and exempt) | 0.5 d |
| G4 | Persisted activity feed: an `agent.decision` (or `agent.activity`) event from **every** decision, including HOLD and errors; `GET` history endpoint; store seeds on mount; scoped delivery instead of broadcast | 1–1.5 d |
| G5 | A strategy that can say **no trade**, with a real price input (last close/mark) | 1 d (rules) / 1.5 d (LLM schema + prompt) |
| G6 | Fix the recovery duplicate leg (seed leg ids from existing `trigger_orders`) and gate the job on the agent flag | 0.5 d |
| G7 | Single-instance guarantee for event-driven agents (advisory lock or job-driven instead of `subscribeGlobal`) | 0.5 d |
| G8 | Reservation release on partial close, or drop reservations for a simpler "one position per pair" rule | 0.5 d |
| G9 | LLM spend guard: daily $ cap from `agent_run_logs.cost_usd`, error-streak circuit breaker | 0.5 d |
| G10 | Integration test against a real DB: signal → order → OCO → TP/SL fire → decision rows; kill switch mid-flight | 1 d |
| G11 | Outcome grading job (fill `outcome_30m/1h/4h`) so performance is measurable | 0.5–1 d |
| G12 | API-key hardening: apply `requireScope("trade")` to order routes and decide whether API-key orders may target `scope: MATCH` | 0.5 d |
| G13 | Delete or wire the dead code (regime classifier: schedule it with a max-age, or remove `getRegimeTag`) | 0.25 d |

### 8.2 Options

**A. Rule-based strategy bot**
- **What it is:** a deterministic strategy, for example an EMA20/50 trend filter, an RSI pullback entry and an ATR stop/target. It runs every 1–5 min on candle close and reuses the existing Risk and Execution logic.
- **Pros:**
  - Deterministic.
  - Backtestable on stored candles.
  - Free to run.
  - Easy to unit test.
  - Explainable by construction, since the reason is the rule that fired.
- **Cons:** the activity text is formulaic, and it won't satisfy a product goal of "an AI that trades".

**B. LLM agent (extend the existing pipeline)**
- **What it is:** keep Scanner and Chart Analysis, add a price tool and a NO_TRADE option, and fix the gaps above.
- **Pros:** most of the code exists, and it reads as "AI".
- **Cons:**
  - Non-deterministic and impossible to backtest cheaply.
  - The current design forces a trade on every candidate.
  - Costs $100–400/mo on Haiku 4.5 at useful cadences.
  - Its quality is unmeasured, and the model only sees single indicator values.
  - It has the most moving parts: 5 stages, 3 events and a multi-instance hazard.

**C. Hybrid: rules decide, LLM explains (recommended)**
- **What it is:** Option A's deterministic signal and sizing. When the rule fires (or once an hour for a HOLD summary), one cheap LLM call turns the structured inputs into a 1–3 sentence explanation stored with the decision. The LLM has **no authority**: it cannot change side, size or prices, and its output is display text only.
- **Pros:**
  - Testable.
  - Backtestable.
  - Essentially free (Haiku 5.5).
  - Readable activity for users.
  - The LLM is off the critical path, so its failure means "no explanation", never "bad trade".
  - Later phases can run an LLM "veto" (block-only, like the News gate) behind its own flag and measure it with G11 grading before giving it any power.

**Recommendation: C.** It reuses the parts of the existing system that are solid: the Execution Agent's idempotency, tolerance and protection logic, the kill-switch plumbing and `agent_decisions`. It drops the parts that are weakest (LLM-forced proposals, the dead regime data, the five-stage event chain).

### 8.3 Phased plan

**Phase 1: one paper agent, observable, killable (~6–8 dev-days).**
- **Account:**
  - One agent user: a new system-marked user (not the market-maker exemption path) with a dedicated **practice** wallet scope, funded with $100K.
  - Normal buying-power and notional checks apply (G1).
- **Flag:** new `RULE_AGENT_ENABLED`, ANDed with `AGENTS_ENABLED`.
- **Strategy:**
  - BTC-USD only, 15m candles, evaluated on `candle.closed`, runs on one instance only (G7).
  - Deterministic signal: BUY / SELL / HOLD.
  - The decision record includes the price input (G5).
- **Limits (G2):**
  - 1 position at a time.
  - ≤ 10% equity notional.
  - 1% risk.
  - ≤ 6 trades/day.
  - Daily-loss halt at −3%, which auto-sets the kill switch and logs `halted`.
- **Execution:** reuse `executor.ts`'s gates and OCO with the G6 fix, and make the flatten reduce-only and kill-switch-exempt (G3).
- **Kill switch (G3):** `AGENT_ACTIONS_ENABLED=false` stops the evaluation loop too, and is visible in the panel.
- **Logging:**
  - Every evaluation writes an `agent_decisions` row (HOLD included, throttled to state changes plus an hourly heartbeat) with `inputs` JSONB.
  - An `agent.decision` event goes to admins / the owner.
  - A history endpoint seeds the panel (G4).
  - An LLM explanation (Haiku 5.5, behind its own flag, failure-tolerant) fills `reasoning`.
- **Tests:** integration test G10 plus unit tests for the strategy and limits.
- **Exit criteria:** 2 weeks running locally, then in prod. Check decision and outcome logs for idempotency (no duplicate orders, no orphan triggers) and confirm the kill switch and daily halt fire.

**Phase 2: measure (~2–3 d).** Outcome grading (G11). A backtest harness over stored candles. An admin page with equity curve, win rate and decision log.

**Phase 3: widen (~2–4 d).** Add ETH/SOL with a cross-pair exposure cap and an optional LLM *veto* behind a flag (block-only), comparing graded outcomes with and without it.

**Phase 4 (optional): user-owned agents.** Each user gets their own agent, scoped to their own practice wallet, never `MATCH` scope. This requires G12, per-user limits and per-user activity delivery.

**Retire or repurpose:**
- Scanner and Chart Analysis can stay flag-off. Their `trade_proposals` output can be shown read-only as "AI idea of the hour" without trading.
- Delete the regime classifier and the unused tool schemas, or wire them up (G13).
