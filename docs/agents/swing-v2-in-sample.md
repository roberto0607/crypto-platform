# Swing Agent v2 backtest: BTC-USD 4h, in-sample (2019-05-01 → 2023-12-31)

**Verdict: INCONCLUSIVE** against the in-sample pass bar fixed on 2026-11-15, before this run. Only 13 trades (needs 30): too few to tell skill from luck, so this is not a pass.

| Check | Result | Needs | Pass |
|---|---|---|---|
| Trades (base run) | 13 | >= 30 | ❌ |
| Expectancy, fees + slippage ×2 | -0.48R | > 0.00R | ❌ |
| MAR vs baseline (b), base costs | -0.07 vs 0.23 | >= baseline (b) | ❌ |

**The 15% drawdown halt tripped on 2020-04-14 (base run)** and is never re-armed in a backtest, so 79.50% of the period's evaluations were blocked by it. The trade count reflects that.

**A baseline beats v2 on MAR (CAGR ÷ max drawdown):** baseline (a) weekly trend, full size 0.70; baseline (b) weekly trend, 1% risk 0.23; buy and hold 0.73 vs v2 -0.07.

Per the pass bar, out-of-sample is **not** run: that data stays unseen.

Generated 2026-11-16 by `pnpm agent:backtest:v2 --period is`. Rules and numbers: `apps/api/src/agents/swing/swingParamsV2.ts` (fixed before this run; nothing tuned on it).

- **Period:** 2019-05-01 → 2023-12-31 (10,236 4h bars), fresh $100,000, its own drawdown halt. Candles loaded: 2015-07-20 → 2024-01-01 (exclusive): nothing from the out-of-sample period was read. Earlier bars only warm up the indicators.
- **Data:** Coinbase BTC-USD: 1h and 1d native, 4h rolled up from 1h, 1w from 1d.
- **Costs per side:** taker fee 5 bps + slippage 5 bps. Stress run: both doubled.
- **Risk:** 1.00% per trade, notional ≤ 1x equity. MAR = CAGR ÷ max drawdown.

## Summary

Every row is split into all / long / short. Return, CAGR, max DD, MAR and time in market are whole-portfolio numbers, so they only appear on the "all" rows. Results on fewer than 30 trades are flagged **⚠ low confidence**. The baselines are long only. Their R is per 1% of equity at entry for (a), and per the stop distance for (b).

| Strategy | Run | Side | Trades | Win rate | Avg R | Expectancy / trade | PF | Net P&L | Return | CAGR | Max DD | MAR | Time in market | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| v2 (Variant A) | base | all | 13 | 7.69% | -0.39R | −$381 | 0.53 | −$4,959 | -4.96% | -1.08% | 15.24% | -0.07 | 1.74% | ⚠ low confidence (n=13) |
| v2 (Variant A) | base | long | 10 | 10.00% | -0.25R | −$254 | 0.68 | −$2,544 | — | — | — | — | — | ⚠ low confidence (n=10) |
| v2 (Variant A) | base | short | 3 | 0.00% | -0.86R | −$805 | 0.00 | −$2,415 | — | — | — | — | — | ⚠ low confidence (n=3) |
| v2 (Variant A) | fees + slippage ×2 | all | 14 | 7.14% | -0.48R | −$449 | 0.45 | −$6,291 | -6.29% | -1.38% | 15.77% | -0.09 | 2.06% | ⚠ low confidence (n=14) |
| v2 (Variant A) | fees + slippage ×2 | long | 11 | 9.09% | -0.37R | −$350 | 0.57 | −$3,853 | — | — | — | — | — | ⚠ low confidence (n=11) |
| v2 (Variant A) | fees + slippage ×2 | short | 3 | 0.00% | -0.91R | −$812 | 0.00 | −$2,437 | — | — | — | — | — | ⚠ low confidence (n=3) |
| baseline (b) 1% risk | base | all | 11 | 36.36% | +1.00R | $1,017 | 9.62 | $11,192 | 11.19% | 2.30% | 10.10% | 0.23 | 68.11% | ⚠ low confidence (n=11) |
| baseline (b) 1% risk | base | long | 11 | 36.36% | +1.00R | $1,017 | 9.62 | $11,192 | — | — | — | — | — | ⚠ low confidence (n=11) |
| baseline (b) 1% risk | base | short (long only) | 0 | 0.00% | +0.00R | $0 | — | $0 | — | — | — | — | — | ⚠ low confidence (n=0) |
| baseline (b) 1% risk | fees + slippage ×2 | all | 11 | 36.36% | +0.99R | $1,001 | 9.25 | $11,011 | 11.01% | 2.26% | 10.07% | 0.22 | 68.11% | ⚠ low confidence (n=11) |
| baseline (b) 1% risk | fees + slippage ×2 | long | 11 | 36.36% | +0.99R | $1,001 | 9.25 | $11,011 | — | — | — | — | — | ⚠ low confidence (n=11) |
| baseline (b) 1% risk | fees + slippage ×2 | short (long only) | 0 | 0.00% | +0.00R | $0 | — | $0 | — | — | — | — | — | ⚠ low confidence (n=0) |
| baseline (a) full size | base | all | 11 | 36.36% | +27.34R | $40,168 | 5.69 | $441,849 | 441.85% | 43.59% | 61.88% | 0.70 | 68.11% | ⚠ low confidence (n=11) |
| baseline (a) full size | base | long | 11 | 36.36% | +27.34R | $40,168 | 5.69 | $441,849 | — | — | — | — | — | ⚠ low confidence (n=11) |
| baseline (a) full size | base | short (long only) | 0 | 0.00% | +0.00R | $0 | — | $0 | — | — | — | — | — | ⚠ low confidence (n=0) |
| baseline (a) full size | fees + slippage ×2 | all | 11 | 36.36% | +27.09R | $39,096 | 5.50 | $430,058 | 430.06% | 42.92% | 62.33% | 0.69 | 68.11% | ⚠ low confidence (n=11) |
| baseline (a) full size | fees + slippage ×2 | long | 11 | 36.36% | +27.09R | $39,096 | 5.50 | $430,058 | — | — | — | — | — | ⚠ low confidence (n=11) |
| baseline (a) full size | fees + slippage ×2 | short (long only) | 0 | 0.00% | +0.00R | $0 | — | $0 | — | — | — | — | — | ⚠ low confidence (n=0) |

## v2 against the baselines (base costs)

| Strategy | Trades | Return | CAGR | Max DD | MAR | Time in market |
|---|---|---|---|---|---|---|
| v2 (Variant A) | 13 | -4.96% | -1.08% | 15.24% | -0.07 | 1.74% |
| baseline (b) weekly trend, 1% risk | 11 | 11.19% | 2.30% | 10.10% | 0.23 | 68.11% |
| baseline (a) weekly trend, full size | 11 | 441.85% | 43.59% | 61.88% | 0.70 | 68.11% |
| buy and hold | 1 | 700.72% | 56.11% | 77.08% | 0.73 | 100.00% |

Baseline (a): long 100% of equity while the last weekly close > SMA 50w, else flat. Baseline (b): the same signal, stop = weekly close − 2 × weekly ATR(14) (fixed), 1.00% risk, ≤ 1x notional; re-enters at the next weekly close still above after a stop-out. Buy and hold buys at the period's first open and sells at its last close.

## v2: by year (entry year, base run)

| Year | Side | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|
| 2019 | all | 10 | 10.00% | -0.24R | 0.68 | −$2,568 | ⚠ low confidence (n=10) |
| 2019 | long | 8 | 12.50% | -0.04R | 0.90 | −$588 | ⚠ low confidence (n=8) |
| 2019 | short | 2 | 0.00% | -1.05R | 0.00 | −$1,980 | ⚠ low confidence (n=2) |
| 2020 | all | 3 | 0.00% | -0.87R | 0.00 | −$2,391 | ⚠ low confidence (n=3) |
| 2020 | long | 2 | 0.00% | -1.07R | 0.00 | −$1,956 | ⚠ low confidence (n=2) |
| 2020 | short | 1 | 0.00% | -0.48R | 0.00 | −$435 | ⚠ low confidence (n=1) |

## v2: by regime (daily ADX 14 at the decision, base run)

Trending ≥ 25, transitional 20–25, ranging < 20. "Share of bars" is how much of the period each regime covered.

| Regime | Share of bars | Side | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|---|
| trending | 60.37% | all | 9 | 0.00% | -0.97R | 0.00 | −$8,320 | ⚠ low confidence (n=9) |
| trending |  | long | 7 | 0.00% | -0.95R | 0.00 | −$6,340 | ⚠ low confidence (n=7) |
| trending |  | short | 2 | 0.00% | -1.05R | 0.00 | −$1,980 | ⚠ low confidence (n=2) |
| transitional | 20.29% | all | 1 | 100.00% | +5.92R | ∞ | $5,487 | ⚠ low confidence (n=1) |
| transitional |  | long | 1 | 100.00% | +5.92R | ∞ | $5,487 | ⚠ low confidence (n=1) |
| transitional |  | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| ranging | 19.34% | all | 3 | 0.00% | -0.74R | 0.00 | −$2,126 | ⚠ low confidence (n=3) |
| ranging |  | long | 2 | 0.00% | -0.87R | 0.00 | −$1,691 | ⚠ low confidence (n=2) |
| ranging |  | short | 1 | 0.00% | -0.48R | 0.00 | −$435 | ⚠ low confidence (n=1) |
| unknown | 0.00% | all | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| unknown |  | long | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| unknown |  | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

## v2: exit reasons (base run)

`stop` = the initial hard stop; `trend` = a 4h close across EMA 50, filled at the next open; `end_of_data` = still open at the period end, closed at its last close.

| Exit | Side | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|
| stop | all | 9 | 0.00% | -1.04R | 0.00 | −$8,932 | ⚠ low confidence (n=9) |
| stop | long | 7 | 0.00% | -1.04R | 0.00 | −$6,952 | ⚠ low confidence (n=7) |
| stop | short | 2 | 0.00% | -1.05R | 0.00 | −$1,980 | ⚠ low confidence (n=2) |
| trend | all | 4 | 25.00% | +1.09R | 3.62 | $3,973 | ⚠ low confidence (n=4) |
| trend | long | 3 | 33.33% | +1.61R | 5.08 | $4,408 | ⚠ low confidence (n=3) |
| trend | short | 1 | 0.00% | -0.48R | 0.00 | −$435 | ⚠ low confidence (n=1) |
| end_of_data | all | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| end_of_data | long | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| end_of_data | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

## Baseline (b): exit reasons (base run)

| Exit | Side | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|
| stop | all | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| stop | long | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| stop | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| signal | all | 10 | 30.00% | +0.84R | 7.49 | $8,425 | ⚠ low confidence (n=10) |
| signal | long | 10 | 30.00% | +0.84R | 7.49 | $8,425 | ⚠ low confidence (n=10) |
| signal | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| end_of_data | all | 1 | 100.00% | +2.57R | ∞ | $2,767 | ⚠ low confidence (n=1) |
| end_of_data | long | 1 | 100.00% | +2.57R | ∞ | $2,767 | ⚠ low confidence (n=1) |
| end_of_data | short | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

## v2: room to daily/weekly S/R (every evaluation that reached the check, base run)

v1 measured this on 4h + daily levels: median 0.61R against a 1.5R requirement. v2 uses daily (pivots 5/5) and weekly (pivots 3/3) levels only, needing 1R.

| Side | Evaluations reaching the check | No opposing level | 25th pct | Median | 75th pct | Pass (>= 1R) |
|---|---|---|---|---|---|---|
| all | 25 | 0 | 0.00R | 1.06R | 1.57R | 52.00% |
| long | 22 | 0 | 0.00R | 0.85R | 1.51R | 45.45% |
| short | 3 | 0 | 1.30R | 1.44R | 3.00R | 100.00% |

## v2: why it did nothing (every 4h evaluation, base run)

Side = the weekly bias the rules tested (the position's side while holding).

| Reason code | Meaning | Long bias | Short bias | No side | Total | Share |
|---|---|---|---|---|---|---|
| `killed` | kill switch on (drawdown halt) | 5,293 | 2,845 | 0 | 8,138 | 79.50% |
| `no_setup` | no pullback setup on this bar | 768 | 297 | 0 | 1,065 | 10.40% |
| `daily_disagrees` | daily close disagrees with the weekly bias | 522 | 29 | 0 | 551 | 5.38% |
| `adx_weak` | 4h ADX under 20 | 193 | 74 | 0 | 267 | 2.61% |
| `position_open` | held an open position | 158 | 7 | 0 | 165 | 1.61% |
| `entry` | entered a trade | 10 | 3 | 0 | 13 | 0.13% |
| `room_htf` | opposing daily/weekly S/R under 1.0R away | 12 | 0 | 0 | 12 | 0.12% |
| `stop_invalid` | stop outside 0.5%–8% | 7 | 5 | 0 | 12 | 0.12% |
| `cooldown` | cooldown after an exit | 7 | 2 | 0 | 9 | 0.09% |
| `trend_exit` | closed: 4h close across EMA 50 | 3 | 1 | 0 | 4 | 0.04% |

## Method

- **Same rules as live:** every decision is `evaluateSwingV2(snapshotAt(series, k), account, costs)`, the function the live agent will call.
- **No lookahead:** 4h indicators are causal; S/R levels come from `activeSRLevelsAt` (4h), `srHtfLevelsAt` (1d and 1w), and daily/weekly values from `htfValueAt`, all as of the 4h close.
- **Entries:** decided at the 4h close, filled at the next 4h open ± slippage + taker fee, sized by the plan. Skipped if that open is more than 0.25R from the decision close (the live drift guard).
- **Exits:** the initial stop never moves and is walked on the four 1h bars inside each 4h bar (an hour opening beyond it fills at its open). A 4h close across EMA 50 exits at the next 4h open. No target and no time stop. Fills pay slippage against the trade + the taker fee.
- **R:** net P&L ÷ (qty × |entry fill − stop|). Profit factor = gross wins ÷ gross losses, net of costs. Expectancy in the verdict = average R per trade.
- **Limits applied:** 1 position, 2 entries per UTC day, 1-bar cooldown, −3% daily loss stop, 15% drawdown halt (never re-armed in the backtest). **The halt tripped on 2020-04-14; no entries after that (base run).**
- **Data gaps (loaded candles):** 19 gaps in the 1h series, 2 in the 4h series (2017-02-28 20:00 UTC, 1 × 4h missing; 2018-08-10 04:00 UTC, 3 × 4h missing). 2 in-position 4h bars had no complete 1h breakdown and were walked as one bar.
