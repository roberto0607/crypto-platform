# Real leverage (feat/leverage): design + plan

Status: **APPROVED 2026-10-13** with the decisions below. Building PR by PR (§8).
Based on `origin/main` @ a844ff2 (after #207 match wallets).

## Decisions (2026-10-13)

1. **Model B**: perp-style isolated margin for every real user. Bots and system users stay on the spot path.
2. **Leftover margin after a liquidation is returned** to the user (equity − fee, floored at 0).
3. **Maintenance margin**: 0.5% BTC/ETH, 1% SOL (`trading_pairs.maintenance_margin_bps`, configurable).
4. **Leverage caps per mode, configurable**: free-play **10x**, 1v1 matches **5x** (stamped on the match at accept), weekly competitions **1x**.
5. **Order input = margin.** Notional, est. liq price and fee are shown live under it before submit.
6. **Competitions** run on the same model at a 1x cap.
7. **No funding in v1.**

These override the defaults and open questions further down (e.g. `LEVERAGE_MAX_MATCH` defaults to 5, and a `LEVERAGE_MAX_COMPETITION` defaulting to 1 is added).

---

## 0. What the code does today (the facts the design builds on)

| Area | Today | File |
|---|---|---|
| Account model | Spot with shorts. A long debits USD for the full notional and credits base. A short debits base (it goes negative, mig 060) and credits USD with the proceeds. | `trading/matchingEngine.ts` Phase I/J |
| Positions | One aggregate row per (user, pair, competition, match). Holds `base_qty`, `avg_entry_price`, `realized_pnl_quote` and `fees_paid_quote`, written by every fill. No id, no leverage, no margin. | `analytics/positionRepo.ts` |
| Buying power | The 2× rule (#206): `USD free − Σ price × (2·short + openShortReserve)`. System users are exempt. | `trading/buyingPower.ts` |
| Fees | `feeCalc.ts` is the single source: taker 5 / maker 2 bps on the quote amount. The MM bot pays 0 as maker. | `trading/feeCalc.ts` |
| Fair price | Kraken book touch (≤ max age), else the Kraken ticker bid/ask, else `stale_price_source`. A close crosses the touch: bid for a long, ask for a short. | `trading/priceCollar.ts` |
| Feed health | `StalenessTracker` per symbol. `krakenWs` exposes per-symbol `ok / stale / waiting`. | `market/feedWatchdog.ts`, `market/krakenWs.ts` |
| Trigger cleanup | Any fill through `placeOrderWithSnapshot` that closes a position cancels that scope's triggers (#202). The comment there already says *"a future liquidation engine must place its closing order through placeOrderWithSnapshot"*. | `triggers/positionCloseTriggers.ts` |
| Match wallets | Funded at accept. At end: cancel orders → lock wallets → force-close positions → settle base to USD at the fair touch → close wallets (#207). | `competitions/matchWallets.ts`, `matchService.settleMatchAccountsTx` |
| Match score | Realized − fees from `positions`, ÷ starting capital. The live push adds unrealized. | `matchService.calculatePlayerStats`, `computeLiveMatchPnl` |
| Leverage UI | **Cosmetic.** The 1/2/3/5/10x buttons multiply the order size (`effectiveUsd = usd × leverage`), so "10x" just buys a 10× bigger spot position, capped by the 2× rule. `posLeverage` is local React state the server never sees. | `web/.../UnifiedOrderPanel.tsx:152,212` |
| Single-runner | Redis leader election (`coordination/leaderElection.ts`). | |

### ⚠️ Existing bug found while reading: short P&L accounting is wrong

`applyFillToPositionTx` only realizes P&L in the SELL branch:

- **Covering a short (BUY while `base_qty < 0`) books no realized P&L.** Example: short 2 @ 110, buy 1 @ 90 → realized stays 0 (should be +20). The entry stays 110 (correct), but it also stays 110 after the short goes flat.
- **Adding to a short (SELL while `base_qty < 0`)** resets `avg_entry_price` to the latest fill price instead of averaging (short 1 @ 100, sell 1 @ 120 → 120, should be 110).
- **Flipping short → long** books no P&L on the short and gives the long a wrong entry (short 1 @ 100, buy 3 @ 90 → entry 85, realized 0; should be 90 and +10).

(Corrected 2026-10-13 after running the old math: the first draft said a cover moved the entry to 130. It doesn't.)

Consequences today: `calculatePlayerStats` scores a short closed *before* match end as 0 P&L. Positions-based P&L, equity snapshots and the force-close at match end, which uses the corrupted average, are all wrong for shorts. Leverage makes this worse (bigger shorts, and liquidation prices are computed from `avg_entry_price`), so **PR 0 fixes it first.** It ships on its own regardless of leverage. The wallets themselves are correct; only the `positions` analytics row is wrong.

---

## 1. The big decision: how leveraged positions fit the model

### Option A: margin-spot (borrow to buy, keep moving base)
A 10x long debits the full notional, so USD goes negative (borrowed), and base is credited. Liquidation sells the base.
- ➕ Smallest engine change. Wallets keep showing BTC.
- ➖ **Margin is pooled in the wallets (cross margin), not isolated.** The spec's "loss capped at the margin" can't be enforced per position because no per-position collateral exists.
- ➖ Negative USD breaks `debitAvailableTx`, AVAILABLE, and the 2× rule's assumptions all at once.
- ❌ Doesn't meet the spec (isolated margin).

### Option B: perp-style for every position, with 1x as a perp at leverage 1 (**recommended**)
For real users, orders never move base. The USD wallet is the only balance. The position row is the instrument: signed `qty`, `entry`, `leverage`, `isolated_margin` and `liq_price`.
- Open/increase: lock margin (`notional / L`) out of USD into the position, and charge the fee on the notional.
- Reduce/close: realize P&L into USD, release margin pro rata, and apply the loss cap.
- ➕ **Isolated margin is real**: the position's collateral sits in its own row, so the loss cap and liquidation are well-defined.
- ➕ **Shorts become clean.** No negative base, and no "proceeds are hidden leverage" problem, so the 2× rule disappears: **buying power = USD balance − USD reserved.** At 1x this gives exactly the numbers #206 produces: a $50 long and a $50 short both use $50.
- ➕ One code path for 1x and 10x, and one P&L formula everywhere (positions, match score, journal).
- ➖ Requires a one-time **conversion** of open spot positions (free-play and competitions) into 1x perp positions. It's equity-preserving (proof below), but it's a data migration.
- ➖ Every place that computes equity from wallets alone must add `Σ (margin + uPnL)`. These are `portfolioService`, the competition leaderboard, match P&L and the web AVAILABLE/equity readouts. One shared `accountEquity()` replaces them.
- ➖ Wallet UI: BTC/ETH/SOL balances go to 0 for real users. Exposure lives in positions.

### Option C: hybrid (1x stays spot, >1x is a new perp position)
- ➕ No conversion, and the existing 1x path is untouched.
- ➖ **Two models for good.** A user can hold spot BTC *and* a perp BTC on the same pair: two position cards, two P&L formulas, and ambiguous reduce-only semantics (which position does a SELL reduce? which one does a SL protect?). Triggers, journal, match scoring and the close hook all need both. The bugs live in the seams.
- ➖ Keeps the 2× rule and the negative-base shorts that just needed #206 and #207 to patch.

**Recommendation: B.** The conversion is a one-time cost. C's dual model is a permanent one.

How 1x coexists and migrates under B:
- **System users (MM bot, risk-agent bot, `@system.local`) keep the spot path unchanged.** Settlement is per leg: a fill between a real-user taker and the bot as maker settles the user's leg as perp (USD + position) and the bot's leg as spot (base/USD wallets), exactly as today. Base conservation across users breaks, but it already does: system fills mint base from nothing. `isSystemUser()` is the switch, and it's already used for the buying-power exemption.
- **Free-play and competitions:** one conversion script, run at cutover (§6). Each open spot position becomes a 1x isolated position, struck at its avg entry after PR 0's rebuild fixes those entries.
  - Conversion of a long `q @ P`: base wallet `q → 0`; position `margin = q·P`, `entry = P`; USD unchanged. Equity before: `USD + q·mark`. After: `USD + q·P + q(mark − P)`. Equal. ✓
  - Conversion of a short `−q @ P`: base wallet `−q → 0` with USD `−q·P` (buy-back booked at P), then margin `q·P` locked (USD `−q·P` again). Equity before: `USD − q·mark`. After: `USD − 2qP + qP + q(P − mark) = USD − q·mark`. ✓
  - If the rebuilt position qty ≠ the wallet base balance (old data drift), strike at the current mark instead and log it. Equity is preserved for any strike price as long as settlement and the open use the same one.
- **Matches:** don't convert mid-match. `matches.margin_mode` is stamped at accept. Matches accepted before the cutover finish on the spot path and end within hours. Matches accepted after use the perp path with `matches.max_leverage` stamped at accept, so changing the cap never affects an in-flight match. The spot path stays in the code only until the last pre-cutover match ends, then PR 8 deletes it.

---

## 2. Schema, engine, liquidation engine

### 2.1 Migration 096 (one migration, additive)

```sql
-- positions: the instrument
ALTER TABLE positions
  ADD COLUMN margin_mode     TEXT NOT NULL DEFAULT 'SPOT'
                             CHECK (margin_mode IN ('SPOT','ISOLATED')),  -- SPOT = system users / pre-cutover
  ADD COLUMN leverage        NUMERIC(6,2)  NOT NULL DEFAULT 1,
  ADD COLUMN isolated_margin NUMERIC(28,8) NOT NULL DEFAULT 0,
  ADD COLUMN liq_price       NUMERIC(28,8),             -- NULL when flat / SPOT
  ADD COLUMN epoch           INT NOT NULL DEFAULT 0,    -- +1 each time it opens from flat (and on a flip)
  ADD COLUMN opened_at       TIMESTAMPTZ;

-- the liquidation engine's hot path: per pair, by side, by liq price
CREATE INDEX idx_positions_liq_long  ON positions (pair_id, liq_price DESC)
  WHERE margin_mode = 'ISOLATED' AND base_qty > 0;
CREATE INDEX idx_positions_liq_short ON positions (pair_id, liq_price ASC)
  WHERE margin_mode = 'ISOLATED' AND base_qty < 0;

-- per-pair risk params (BTC/ETH 50 bps, SOL 100 bps). Shipped in 096 with DEFAULT 50 for
-- every pair (additive only); SOL's 100 is set when the engine starts reading it (PR 2).
ALTER TABLE trading_pairs
  ADD COLUMN maintenance_margin_bps INT NOT NULL DEFAULT 50,
  ADD COLUMN max_leverage           NUMERIC(6,2) NOT NULL DEFAULT 10;

-- per-match cap + model, stamped at accept
ALTER TABLE matches
  ADD COLUMN margin_mode  TEXT NOT NULL DEFAULT 'SPOT' CHECK (margin_mode IN ('SPOT','ISOLATED')),
  ADD COLUMN max_leverage NUMERIC(6,2) NOT NULL DEFAULT 1;

-- the order remembers the leverage it was placed at (LIMITs rest)
ALTER TABLE orders ADD COLUMN leverage NUMERIC(6,2) NOT NULL DEFAULT 1;

-- every liquidation, real or would-be
CREATE TABLE liquidations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mode            TEXT NOT NULL CHECK (mode IN ('LOG_ONLY','EXECUTED','SKIPPED_STALE')),
  user_id         UUID NOT NULL REFERENCES users(id),
  pair_id         UUID NOT NULL REFERENCES trading_pairs(id),
  competition_id  UUID, match_id UUID REFERENCES matches(id),
  position_epoch  INT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
  qty             NUMERIC(28,8) NOT NULL,
  entry_price     NUMERIC(28,8) NOT NULL,
  leverage        NUMERIC(6,2)  NOT NULL,
  margin          NUMERIC(28,8) NOT NULL,
  liq_price       NUMERIC(28,8) NOT NULL,
  mark_price      NUMERIC(28,8) NOT NULL,      -- what tripped it
  fill_price      NUMERIC(28,8),               -- NULL for LOG_ONLY
  realized_pnl    NUMERIC(28,8),
  fee             NUMERIC(28,8),
  returned_equity NUMERIC(28,8),
  shortfall       NUMERIC(28,8) NOT NULL DEFAULT 0,  -- loss beyond margin, absorbed (gap)
  book_age_ms     INT,
  order_id        UUID REFERENCES orders(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one row per position episode per mode: log-only doesn't spam every tick
CREATE UNIQUE INDEX liquidations_once
  ON liquidations (user_id, pair_id, COALESCE(competition_id, NIL), COALESCE(match_id, NIL), position_epoch, mode);

-- ledger: margin moves + loss-cap absorption
-- add 'MARGIN_LOCK','MARGIN_RELEASE','REALIZED_PNL','LIQUIDATION_SHORTFALL','POSITION_CONVERSION'

-- journal
ALTER TABLE closed_trades
  ADD COLUMN leverage NUMERIC(6,2) NOT NULL DEFAULT 1,
  ADD COLUMN margin NUMERIC(28,8),
  ADD COLUMN close_reason TEXT,   -- MANUAL | TP | SL | TRAILING | LIQUIDATION | MATCH_END
  ADD COLUMN return_on_margin_pct NUMERIC(10,4),
  ADD COLUMN match_id UUID;       -- the 066 TODO, needed for match journals
```

### 2.2 Engine changes (`matchingEngine.placeOrderInternal` + `phase6OrderService`)

A real user's leg in an `ISOLATED` scope settles as perp. The bot's leg is unchanged.

| Phase | Today | ISOLATED |
|---|---|---|
| A: pair lock | same | same (still Level 1, serializes everything incl. liquidations) |
| E: affordability | BUY needs USD ≥ cost | Opening portion needs `USD free ≥ margin + fee`. A closing portion needs nothing. |
| LIMIT reserve | BUY reserves notional + max fee. SELL reserves base. | Both sides reserve `margin + maxFee` for the full qty in USD (conservative). The excess is released at fill if it reduced instead of opened. |
| F2: buying power | 2× rule | `USD balance − reserved ≥ 0` after the order. Mark-to-market drops out: losses are confined to each position's margin. |
| Reduce-only | `isReduceOnly` reads the base wallet | Reads `positions` (the same row `reducibleQty` already reads for triggers). |
| I/J: settle | debit/credit quote + base | Taker leg: no base wallet touched. USD moves are `MARGIN_LOCK`/`MARGIN_RELEASE`/`REALIZED_PNL`/`FEE`. The maker leg uses perp if the maker is a real user. |
| Leverage check | — | `1 ≤ L ≤ min(pair.max_leverage, scopeCap)` where scopeCap = free-play cap or `matches.max_leverage`. An add must equal the open position's leverage (`leverage_mismatch`). The UI locks the selector while a position is open. |

`applyFillToPositionTx` becomes the single place the position math lives (pure core in `trading/margin.ts`, §3), applying increase / reduce / flip:
- **Increase** (same sign or from flat): `Q += Δq`, `E = (Q·E + Δq·p) / (Q + Δq)`, `M += Δq·p / L`, recompute `liq`. From flat: `epoch += 1`, `opened_at = now`.
- **Reduce** (opposite side, `Δq ≤ |Q|`): `pnl = Δq·(p − E)·sign`, `released = M·Δq/|Q|`, `M −= released`, E unchanged, liq unchanged (M/Q is constant). Flat → `M = 0, liq = NULL`.
- **Flip** (`Δq > |Q|`): split into a full close of `|Q|` (above), then an increase of `Δq − |Q|` from flat at `p` with the order's leverage. The buying-power check already covered the opening leg.
- **Loss cap** on every reduce: `credit = max(0, released + pnl − fee)`. Booked P&L = `max(pnl, −released)`. Booked fee = `min(fee, max(0, released + pnl))`. Any shortfall is recorded (`LIQUIDATION_SHORTFALL`, and a `liquidations` row when it was a liquidation). **USD can't go negative from a position.**

Equity: a new `accountEquity(scope)` = `USD balance + Σ (M + uPnL_capped)` where `uPnL_capped = max(uPnL, −M)`. It's used by the portfolio snapshot, the competition leaderboard, `computeLiveMatchPnl`, `GET /positions` (which also returns `leverage, isolated_margin, liq_price, margin_health, mark_price`) and the web AVAILABLE/equity readouts.

### 2.3 Liquidation engine (`trading/liquidationEngine.ts`)

**Where:** in the API process, started like `triggerEngine`, behind `withLeadership(LOCK_NAMES.LIQUIDATION)`. Only one instance evaluates. A second instance can't double-liquidate anyway (the lock below makes it a no-op), but this avoids wasted work.

**How often:** event-driven on `price.tick` per pair, throttled to at most once every 250 ms per pair, **plus** a 1 s sweep of every pair. The sweep catches the case where Kraken book updates arrive but no `price.tick` fires, or a tick is dropped. Each evaluation is one indexed query:

```sql
SELECT ... FROM positions
WHERE pair_id = $1 AND margin_mode = 'ISOLATED'
  AND ((base_qty > 0 AND liq_price >= $mark) OR (base_qty < 0 AND liq_price <= $mark))
```

At today's user count that's trivially cheap, and it's stateless: no in-memory index that can drift from the DB.

**Mark price:** the mid of the **Kraken book only** (`getCollarReference`, ≤ `MARKET_COLLAR_MAX_BOOK_AGE_MS`, not crossed). No ticker fallback for liquidation, which is stricter than orders. **Stale ⇒ pause that pair:** if there's no book reference or `krakenWs` reports the symbol `stale/waiting/disconnected`, skip the pair, log `liquidation_paused_stale_feed {pair, bookAgeMs}` once per episode, set the gauge `liquidation_paused{pair}=1`, and on recovery log `liquidation_resumed {pausedMs}` and evaluate immediately. Positions that crossed bankruptcy during the pause are liquidated at the touch on resume; the loss cap absorbs any gap.

**Glitch guard:** a candidate must breach on **two consecutive evaluations ≥ 500 ms apart** (state kept per `user:pair:scope:epoch`). One bad book print can't liquidate anyone. The cost is ≤ ~0.5 s of extra gap, which the loss cap covers.

**Execution (mode `execute`):** a closing MARKET order through `placeOrderWithSnapshot(..., source = 'liquidation', liquidation = { epoch })`, so the trigger cancel hook (#202), journal, positions, outbox and match-wallet routing are all reused. Inside `placeOrderInternal`, after the wallet locks (keeping the existing pair → wallets → positions lock order), the position row is locked `FOR UPDATE` and **re-verified**:
1. `epoch` is unchanged and the qty is non-zero with the same sign (otherwise it was closed or reopened, so abort);
2. the liq condition still holds against the reference fetched **under the pair lock**;
3. qty = the current `|Q|` read under the lock (never the stale candidate qty).

If any check fails, it's a silent no-op. The fill is at the touch (bid for long, ask for short) via the normal collar/system-fill path. The fee is the taker rate, capped at the remaining equity. The leftover equity (≈ MMR − fee) **returns to the user** (recommended; see open question 2). Then the `liquidations` row (`EXECUTED`), the `position.liquidated` SSE event, and a notification.

**Mode `log_only`:** same evaluation, glitch guard and stale pause. Instead of the order it writes a `liquidations` row (`LOG_ONLY`, at most one per position epoch) and logs `liquidation_would_fire {user, pair, scope, side, qty, entry, L, margin, liqPrice, mark, bid, ask, bookAgeMs}`.

**Races (all serialized by the pair lock + the epoch/qty re-check):**
- *Liquidation vs TP/SL:* whichever reaches `placeOrderTx` first wins. If the trigger wins, the liquidation's re-check sees a flat or reduced position and recomputes (no-op or smaller). If the liquidation wins, the #202 hook cancels the triggers in the same transaction, and a trigger already in `TRIGGERED` phase 2 hits `reducibleQty = 0` and becomes `CANCELED no_position` (existing code).
- *Liquidation vs a user's manual close/add:* the same serialization applies. An add changes `liq_price`, so the re-check uses the new value.
- *Liquidation vs match end:* match end locks the match wallets and closes them. A liquidation waiting on those wallet locks gets `match_ended` and stops. The match-end settlement (which now applies the same loss cap) books the position. A liquidation that commits first leaves a flat position that match end skips. The liquidation adds no new lock order because it *is* an order.
- *Liquidation vs resting maker fills:* the same pair lock applies.
- *Crash mid-liquidation:* it's a single transaction, so either everything committed or nothing did. Nothing needs startup recovery, unlike the triggers' two-phase fire.

**Failure modes and responses:**

| Failure | Response |
|---|---|
| Feed stale/killed | Pause the pair, log once, gauge. No liquidation on a stale or ticker price. |
| Bad single print | 2-breach confirmation. Crossed book rejected (existing). |
| Gap past bankruptcy | Loss cap: credit 0, `shortfall` recorded, balance never < 0. |
| Event-loop lag | The 1 s sweep plus the loss cap. Metric `liquidation_eval_lag_ms`. |
| DB error mid-evaluation | Logged. Next tick retries. Idempotent via epoch + the unique index. |
| Leader dies | Leadership TTL expires and another instance takes over (existing leader election). |
| Mass liquidation on one pair | Sequential under the pair lock. Each closes at the then-current touch. Known limitation, the same as for any MARKET order: no depth walk (top of book for the whole size). |
| Replay sessions | Leverage disabled (cap 1x) in solo replay in v1. Replay prices aren't the live book. |

---

## 3. Formulas (USD-margined linear, isolated)

Notation: `Q` = position size in base (>0), `E` = avg entry, `L` = leverage, `p` = fill price, `P` = mark, `MMR` = maintenance-margin rate, `M` = isolated margin.

- Notional at open: `N = Q·E`
- Initial margin: `M = N / L` (summed across adds)
- Fee: `fee = notional_of_fill × bps / 10000` (taker 5, maker 2, via `feeCalc.ts`, unchanged)
- Unrealized P&L: long `Q(P − E)`, short `Q(E − P)`
- Position equity: `M + uPnL`
- Maintenance margin: `MM = Q·P·MMR`
- **Liquidate when** `M + uPnL ≤ MM`
- **Liq price, long:** `P_liq = (Q·E − M) / (Q·(1 − MMR))`. For a single open that's `E·(1 − 1/L) / (1 − MMR)`.
- **Liq price, short:** `P_liq = (Q·E + M) / (Q·(1 + MMR))`, i.e. `E·(1 + 1/L) / (1 + MMR)`.
- Bankruptcy price (equity = 0): long `E − M/Q`, short `E + M/Q`
- Margin health (for the UI): `(equity − MM) / (M − MM_at_entry)`. This is linear in price: 100% at entry, 0% at liquidation.
- Realized on a reduce of `Δq`: `Δq·(p − E)` long / `Δq·(E − p)` short. Released margin: `M·Δq/Q`.
- Return on margin: `net_pnl / M`. Return on capital (match score): `net_pnl / starting_capital`.

Liq prices are computed with `decimal.js` from the stored `M`, so they stay correct after adds and partial closes. Server and web share one pure module with a shared JSON case file, the same pattern as `buyingPowerCases.json`.

### Worked example: $50 at 10x long BTC at $83,000 (MMR 0.5%, taker 5 bps)

| | |
|---|---|
| Notional | 50 × 10 = **$500** |
| Size | 500 / 83,000 = **0.00602410 BTC** |
| Open fee | 500 × 0.0005 = **$0.25** |
| USD debited | 50 (MARGIN_LOCK) + 0.25 (FEE) = **$50.25** |
| Liq price | 83,000 × 0.9 / 0.995 = **$75,075.38** (−9.55%) |
| Check at 75,075.38 | equity = 50 + 0.0060241 × (−7,924.62) = 2.2613. MM = 0.0060241 × 75,075.38 × 0.005 = 2.2613 ✓ |
| Bankruptcy | 83,000 × 0.9 = **$74,700** |
| At $84,000 | uPnL +$6.02, equity $56.02 |
| At $80,000 | uPnL −$18.07, equity $31.93 |
| **Liquidated**, bid $75,060 | pnl −$47.83, remaining $2.17, fee $0.23 → **$1.94 returned**. Total loss incl. open fee: **$48.31** |
| **Gap** to $74,000 | pnl −$54.22 → booked −$50.00, credit $0, **shortfall $4.22 absorbed**, USD unaffected beyond the $50.25 |
| Partial close of ½ at $85,000 | pnl +$6.02, released $25, fee $0.13 → **+$30.90 to USD**. Remaining M = $25, liq still $75,075.38 |
| Add $50 @10x at $80,000 | Q = 0.01227410, E = $81,472.39, M = $100 → liq **$73,693.62** |
| Same trade as a short | liq 83,000 × 1.1 / 1.005 = **$90,845.77**, bankruptcy $91,300 |
| 1x | long liq ≈ $0 (never). Short liq = $165,174 (+99%). 1x is effectively today's behavior. |

---

## 4. UI

**Order panel (`UnifiedOrderPanel.tsx`)**
- The leverage selector becomes real: the buttons are `[1,2,3,5,10]` filtered to `≤ cap` (the cap comes from the server, per mode/match). It's sent with the order. It's locked to the position's leverage while one is open ("Close to change leverage").
- **The input becomes MARGIN (USD)**, which is what you're risking. It shows Notional = margin × L, Size, Fee (on the notional), **Est. liq price** (for a market order from the touch you'd cross; for a limit from the limit price), and Margin used / Available (`USD − reserved`).
- The OPEN button label keeps the #18 format with the notional.
- The fake "effective size" hint goes away.

**Position card:** leverage badge (`10x`), margin, entry, mark, **liq price**, uPnL $ and ROE % (on margin), plus a **margin-health bar** (green > 50%, amber 25–50%, red < 25% with a pulse). Tooltip: "Liquidation at $75,075.38 (−9.5% from entry)".

**Chart:** a dashed liq-price line on the price chart, the same primitive as the TP/SL lines.

**Warning near liquidation:** a server-side `position.margin_warning` SSE event when health crosses below 25%, with hysteresis (re-arms above 35%), at most once per episode. Shown as a toast plus the card turning red. A pure UI version also runs off the live mark so the card reacts even between events.

**Liquidation notification:** a `position.liquidated` SSE event → toast ("BTC 10x LONG liquidated at $75,060. $1.94 margin returned"), a bell notification via `notificationService`, and a chart marker.

**Journal / CSV:** `closed_trades` gets leverage, margin, close_reason and return on margin. The journal shows a red **LIQUIDATED** badge. The CSV export adds `leverage, margin, close_reason, return_on_margin_pct, liq_price`.

---

## 5. Scoring

- **Match P&L% = net P&L / starting capital (unchanged definition).** Leverage amplifies it naturally. That's the competitive point, measured on capital, not on margin, so a 10x +5% move on a $1k margin of $10k capital is +5% match P&L, not +50%.
- **The loss floor is structural:** each position loses at most its margin, and margins come from the match wallet, so a player can't go below −100%. `computeLiveMatchPnl` and the match-end settlement both use capped uPnL.
- **Liquidations count as closed trades** (losses) in win rate. Trades count is unchanged.
- `calculateNuancedScore` clamps P&L to ±50%. With leverage, more matches hit the clamp, so blowing up and nearly blowing up score the same (0). **v1: keep the formula, log `score_pnl_clamped`** to see how often it bites, and decide with data.
- **Per-mode cap:** `matches.max_leverage` is stamped at accept (default from `LEVERAGE_MAX_MATCH`). The challenge card shows "Max 10x". ELO is unchanged (win/loss-based).
- **Weekly competitions / leaderboard:** in v1 they run on the ISOLATED model at a **1x cap**, and their equity uses `accountEquity()`. Turning on leverage there is a later product decision.

---

## 6. Rollout

Flags (env, read via `config.ts`):
- `LEVERAGE_ENABLED` (default `false`): the ISOLATED path for real users. `false` keeps today's spot path.
- `LIQUIDATION_MODE` = `off | log_only | execute` (default `log_only`)
- `LEVERAGE_MAX_FREE_PLAY` (default 10), `LEVERAGE_MAX_MATCH` (default 10)
- `LEVERAGE_ALLOWLIST`: user IDs allowed above 1x while it's non-empty; everyone else is capped at 1x.

You set these and run the scripts. I won't touch prod or Railway.

**Phase 0: dark deploy.** All PRs merged with `LEVERAGE_ENABLED=false`. Nothing changes. PR 0's short-P&L fix is live on its own.

**Phase 1: 1x perp for everyone + log-only liquidations.**
1. `pnpm positions:rebuild --dry-run`, then real (fixes old short entries).
2. `pnpm leverage:convert --dry-run`, which prints every open spot position, its strike price, and equity before and after (must be equal to the cent). Then real, in one transaction.
3. Set `LEVERAGE_ENABLED=true`, `LIQUIDATION_MODE=log_only`, `LEVERAGE_ALLOWLIST=<your accounts>`.
4. Everyone trades 1x perp. Your accounts can open up to 10x. Check `liquidation_would_fire` logs and `liquidations WHERE mode='LOG_ONLY'` against the liq price the UI showed.
   - Note: in log-only mode an allowlisted leveraged position is *not* force-closed. The settlement loss cap still guarantees no negative balance on its eventual close.

**Phase 2: execute.** Set `LIQUIDATION_MODE=execute` (still allowlist-only). Verify a real liquidation end-to-end, then clear `LEVERAGE_ALLOWLIST` to open 10x to everyone.

**Kill switch:** cap = 1 (`LEVERAGE_MAX_*=1`) stops new leverage and keeps the engine protecting the positions already open. **The conversion is one-way**: going back to spot would need a reverse script, which isn't planned. That's why Phase 1 runs at 1x for everyone first.

---

## 7. Test plan

Pure math (`margin.test.ts`, shared JSON cases with the web copy):
- Liq/bankruptcy/health for long and short at 1/2/3/5/10x, matching the §3 table to the cent
- Add-to-position recomputes E, M and liq. Partial close releases M pro rata and leaves liq unchanged. Flip = close + fresh open at the fill with a new epoch.
- Loss cap: gap past bankruptcy → credit 0, shortfall > 0, fee capped
- PR 0: covering a short realizes P&L. Adding to a short averages entry. Flip from short to long.

Engine (DB tests, the existing `phase6OrderService.test.ts` style):
- Buying power with leverage: $1,000 USD free → $100 margin at 10x opens $1,000 notional. $1,000 margin at 10x is rejected (fee doesn't fit). A resting LIMIT reserves margin + max fee.
- Leverage above the cap or mismatched to the open position → rejected
- Reduce-only uses positions. System user (MM bot) fills: wallet base moves exactly as today, and its positions stay SPOT (**bot unaffected**). Snapshot-compare the bot's ledger before and after.

Liquidation engine:
- Breach → liquidated at the touch (bid for long, ask for short). Fee capped. Leftover returned. `liquidations` row. Triggers canceled (#202). Event + notification.
- **Price gap past liq**: liquidated at the gapped touch, shortfall recorded, USD ≥ 0
- **Stale feed**: book age > max, or symbol `stale` → no liquidation, one `paused` log, then resume → liquidation
- Glitch guard: a single breach followed by recovery → no liquidation
- **Liquidation racing a TP/SL** (both orders: trigger first and liquidation first; trigger in TRIGGERED phase 2) → exactly one close. No negative balance, no reopened position, triggers end CANCELED/TRIGGERED correctly.
- Racing a manual close, and racing an add (liq moves away → no-op)
- **Match end with open leveraged positions**: settlement at the fair touch with the loss cap, wallets closed. A liquidation waiting on locks → `match_ended` no-op. Match score uses capped P&L.
- Log-only: a row is written once per epoch, no order, position untouched
- Two engines (leadership off) racing the same position → one liquidation

Conversion script: equity before == after per account (long, short, flat, multiple pairs, drift case struck at mark). Idempotent re-run.

UI: `margin.ts` web copy (vitest), order panel liq estimate, health bar thresholds, CSV columns. Playwright smoke: open 10x, see the liq line and health bar, force a log-only/execute liquidation in local dev with a fake book.

---

## 8. Size and PR split

Roughly **4–5k lines including tests**, in 9 PRs, each independently reviewable and typecheck-clean:

| PR | Content | Size |
|---|---|---|
| **0** | Fix short P&L in `applyFillToPositionTx` + tests + `positions:rebuild` dry-run report. **Ships first, independent of leverage.** | S |
| 1 | Migration 096 + `trading/margin.ts` pure math (+ web copy, shared cases) + config flags. No behavior change. | M |
| 2 | Engine ISOLATED path behind the flag: open/increase/reduce/flip, margin ledger, loss cap, buying power, reduce-only, LIMIT reserve, leverage caps, `accountEquity()`, `GET /positions` fields | **L** (the core) |
| 3 | Matches: stamp mode/cap at accept, perp settlement at match end with the loss cap, live P&L cap, scoring | M |
| 4 | Liquidation engine: log_only + execute, leadership, stale pause, glitch guard, `liquidations` rows, events, metrics, race tests | M–L |
| 5 | `leverage:convert` script (dry-run default, equity-preservation check) | M |
| 6 | Web: real leverage selector, margin input, liq estimate, position card, health bar, chart liq line, warning + liquidation toasts | L |
| 7 | Journal: close_reason / leverage / margin / ROE, LIQUIDATED badge, CSV columns | S–M |
| 8 | After the last pre-cutover match ends and Phase 2 is stable: delete the spot path for real users and the 2× rule | S |

### PR 2 implementation notes (feat/leverage-engine)

Decisions made while building the engine path, beyond the table above:

- **Where the math runs.** `trading/isolatedPosition.ts` (pure: increase / reduce / flip + the loss cap) and `trading/isolatedSettlement.ts` (mode resolution, position lock, ledger postings). The matching engine settles an ISOLATED leg itself, because its USD moves depend on the position; `phase6OrderService` skips `applyFillToPositionTx` for those legs (`PlaceOrderResult.isolatedLegs`). Spot legs are untouched.
- **Which model an order trades.** An open position keeps its model (a pre-leverage SPOT position trades spot until flat; an ISOLATED one stays ISOLATED even with the flag off). Otherwise SPOT when the flag is off, for system users, and in a match stamped SPOT (all matches until PR 3). Otherwise ISOLATED.
- **`orders.margin_mode` + `orders.cancel_reason` (migration 098).** A resting order settles its maker leg in the model it was reserved under, whatever the flag says at fill time. A resting order of the other model on the same pair/scope blocks a new order (`spot_orders_open` / `isolated_orders_open`), so a fill can never land on a position of the wrong model.
- **One leverage per (user, pair, scope)** while a position or resting order is open. An order that opens or adds must match it (`leverage_mismatch`); an order with no leverage inherits it; a pure reduce ignores the requested leverage. The cap (`leverage_exceeds_cap`) is checked only on orders that open or add, so lowering a cap never blocks a close.
- **LIMIT reserve (changed from the table above in review).** Immediate (taker) fills are paid from free USD. The resting remainder reserves `open × limit / L + max fee` in USD, for either side, where `open` is only the part that would open or flip past flat: the remainder minus the position it reduces, net of what the user's other resting orders on that side already claim. The reducing part reserves nothing; its fee comes out of `settleReduce` (uncollected if capped). So a fully invested user can rest a LIMIT close with $0 free.
- **Fill-time check on a resting order's opening part.** When a resting ISOLATED order is swept, its reducing part always fills. A part that would open (because the position shrank some other way first, or it was placed past flat) fills only if its leverage is still within the user's cap now and its own reserve covers margin + fee. Otherwise the order fills what it can and the rest is canceled with `orders.cancel_reason` = `leverage_exceeds_cap` or `insufficient_margin`; the reserve is released and the owner gets `order.updated` + an `ORDER_CANCELLED` outbox event with the reason. The taker's sweep moves on to the next resting order / the system fill.
- **SOL** maintenance margin = 100 bps (migration 097, SOL-based pairs only).
- **Equity.** `analytics/accountEquity.positionValue`: an ISOLATED position is worth `M + max(uPnL, −M)`; SPOT rows are valued as before. Used by the portfolio summary (and so the competition leaderboard and finalize) and the per-fill portfolio snapshot. `computeLiveMatchPnl` and match-end settlement are PR 3.
- **`GET /positions`** adds `margin_mode, leverage, isolated_margin, liq_price, mark_price, margin_health` on ISOLATED rows only; SPOT rows keep their exact shape.
- **Flag off is proven unchanged** by `flagOffParity.test.ts`: a scripted session's full DB state (wallets, ledger, orders, trades, positions, equity snapshots) equals a golden dump generated from origin/main before this PR.

### PR 3 implementation notes (feat/leverage-matches)

- **Stamp at accept.** `acceptMatch` sets `matches.margin_mode = 'ISOLATED'` and `max_leverage = LEVERAGE_MAX_MATCH` while `LEVERAGE_ENABLED` is on. Flag off leaves the column defaults (SPOT, 1x), so flag-off matches are unchanged. A PENDING match isn't stamped; the config in force at accept wins.
- **The stamp beats the flag.** In a match, `resolveTakerMargin` uses the stamp before looking at the flag: an ISOLATED match keeps trading ISOLATED if the flag is later turned off (at 1x, since `leverageCap` is 1 with the flag off: the kill switch), and a SPOT match stays SPOT when it's turned on. One model per match. An open position still keeps its own model first.
- **Match-end settlement.** `closeMatchScopedPositions` closes an ISOLATED position through `settleIsolatedFillTx` at the same fair touch as before: `MARGIN_RELEASE` + `REALIZED_PNL` with the loss cap (`LIQUIDATION_SHORTFALL` past bankruptcy), position flat, margin 0, liq NULL. **No fee**, the same as the SPOT force-close. The synthetic close order now carries the position's `margin_mode` and `leverage` (SPOT/1 for spot rows, i.e. the defaults). `settleMatchWalletsTx` has no base to settle for ISOLATED players.
- **Score.** Unchanged formula (realized − fees ÷ capital), now over loss-capped realized P&L. `calculatePlayerStats` logs `score_pnl_clamped {matchId, userId, pnlPct, score}` when |P&L| > 50% (where `calculateNuancedScore` clamps).
- **Live P&L.** `computeLiveMatchPnl` caps an ISOLATED row's unrealized loss at `−isolated_margin`; `matchPnlEngine` reads `margin_mode` and `isolated_margin`. SPOT rows are computed exactly as before.
- **Flag off is proven unchanged** by `flagOffMatchParity.test.ts`: two matches through createMatch → acceptMatch → trades → completeMatch / forfeitMatch with positions open, the full DB state (matches, ELO, wallets, ledger, orders, trades, positions, equity snapshots) compared to a golden generated from origin/main before this PR. `flagOffParity.test.ts` (PR 2) still passes, and its golden regenerated on current main is byte-identical.

---

## Funding: recommendation **no funding in v1**

1. **Wrong timescale for matches.** Funding settles every 8h (Deribit's rate is quoted per 8h). Matches run minutes to hours, so funding would hit only the match that happens to straddle a settlement timestamp. That's noise in the score, and it can be gamed by timing.
2. **Another live-data dependency on money.** The funding display uses Deribit. Charging it would put a third external feed (with its own staleness rules) on the P&L path we just made safe for Kraken.
3. **No counterparty to pay.** Funding is longs-pay-shorts between traders. Here the other side is mostly the system or bot, so it would be a fee or rebate from nowhere.
4. Cost of skipping it: holding a leveraged position is cheaper than on a real exchange. That's acceptable for paper trading and labeled in the UI ("Funding rate shown for reference; not charged").

v2 option: hourly accrual from the Deribit rate, free-play only, behind its own flag, as a `FUNDING` ledger entry against the position's margin (which then also moves the liq price).

---

## Open questions (resolved)

All six were answered on 2026-10-13. See **Decisions** at the top.
