# Swing Agent backtest: BTC-USD 4h, Variant A vs B

Generated 2026-11-15 by `pnpm agent:backtest`. Rules and numbers: `apps/api/src/agents/swing/swingParams.ts` (fixed before this run; nothing was tuned on it).

- **Tested window:** 2019-05-19 → 2026-11-15 (16,416 4h bars), warm-up excluded. The weekly SMA 200 needs 200 closed weeks, so this is the first bar both variants can trade.
- **Data:** Coinbase BTC-USD, 2015-07-20 → 2026-11-15: 1h and 1d native, 4h rolled up from 1h, 1w from 1d.
- **Costs per side:** taker fee 5 bps + slippage 5 bps. Stress run: both doubled.
- **Start equity:** $100,000, risk 1.00% per trade, notional ≤ 1x equity.

## Summary

Results based on fewer than 30 trades are flagged **⚠ low confidence**: the sample is too small to tell skill from luck.

| Variant | Run | Trades | Win rate | Avg R | Expectancy / trade | PF | Return | CAGR | Max DD | Longest losing streak | Time in market | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | base | 4 | 0.00% | -1.06R | −$985 | 0.00 | -3.94% | -0.53% | 4.45% | 4 | 0.23% | ⚠ low confidence (n=4) |
| A | ADX ≥ 25 | 2 | 0.00% | -1.08R | −$994 | 0.00 | -1.99% | -0.27% | 2.51% | 2 | 0.09% | ⚠ low confidence (n=2) |
| A | fees + slippage ×2 | 4 | 0.00% | -1.12R | −$984 | 0.00 | -3.94% | -0.53% | 4.35% | 4 | 0.23% | ⚠ low confidence (n=4) |
| B | base | 22 | 18.18% | -0.55R | −$498 | 0.36 | -10.96% | -1.54% | 11.56% | 8 | 1.46% | ⚠ low confidence (n=22) |
| B | ADX ≥ 25 | 15 | 26.67% | -0.31R | −$298 | 0.58 | -4.47% | -0.61% | 6.64% | 4 | 1.07% | ⚠ low confidence (n=15) |
| B | fees + slippage ×2 | 22 | 18.18% | -0.62R | −$530 | 0.31 | -11.66% | -1.64% | 12.20% | 8 | 1.46% | ⚠ low confidence (n=22) |

Buy and hold over the same window: return 703.42%, CAGR 32.07%, max drawdown 77.08%.

## Variant A: 4h pullback to EMA 20 (EMA 50 structure, RSI 14 band)

Base run: 4 trades, 0.00% win rate, average -1.06R, profit factor 0.00, return -3.94%, max drawdown 4.45%.

### By year (entry year, base run)

| Year | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|
| 2020 | 1 | 0.00% | -1.09R | 0.00 | −$999 | ⚠ low confidence (n=1) |
| 2021 | 2 | 0.00% | -1.06R | 0.00 | −$1,968 | ⚠ low confidence (n=2) |
| 2022 | 1 | 0.00% | -1.03R | 0.00 | −$971 | ⚠ low confidence (n=1) |

### By regime (daily ADX 14 at the decision, base run)

Trending ≥ 25, transitional 20–25, ranging < 20. "Share of bars" is how much of the tested period each regime covered.

| Regime | Share of bars | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|
| trending | 54.76% | 3 | 0.00% | -1.06R | 0.00 | −$2,949 | ⚠ low confidence (n=3) |
| transitional | 21.01% | 1 | 0.00% | -1.07R | 0.00 | −$989 | ⚠ low confidence (n=1) |
| ranging | 24.23% | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| unknown | 0.00% | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

### Exit reasons (base run)

| Exit | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|
| target | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| stop | 4 | 0.00% | -1.06R | 0.00 | −$3,938 | ⚠ low confidence (n=4) |
| time | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| end_of_data | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

### Why it did nothing (every 4h evaluation, base run)

| Reason code | Meaning | Evaluations | Share |
|---|---|---|---|
| `no_setup` | no entry setup on this bar | 6,768 | 41.23% |
| `bias_neutral` | weekly bias neutral (between SMA 50 and 200) | 3,859 | 23.51% |
| `adx_weak` | 4h ADX under the threshold | 2,818 | 17.17% |
| `daily_disagrees` | daily close disagrees with the weekly bias | 2,424 | 14.77% |
| `room_to_target` | opposing S/R under 1.5R away | 408 | 2.49% |
| `target_too_close` | target under 1.5R | 78 | 0.48% |
| `position_open` | held an open position | 34 | 0.21% |
| `stop_invalid` | stop outside 0.5%–8% | 19 | 0.12% |
| `entry` | entered a trade | 4 | 0.02% |
| `cooldown` | cooldown after an exit | 4 | 0.02% |

## Variant B: 4h UT Bot flip (key 1, ATR 10)

Base run: 22 trades, 18.18% win rate, average -0.55R, profit factor 0.36, return -10.96%, max drawdown 11.56%.

### By year (entry year, base run)

| Year | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|
| 2019 | 1 | 0.00% | -1.04R | 0.00 | −$997 | ⚠ low confidence (n=1) |
| 2020 | 2 | 0.00% | -1.07R | 0.00 | −$1,976 | ⚠ low confidence (n=2) |
| 2021 | 6 | 33.33% | -0.14R | 0.78 | −$865 | ⚠ low confidence (n=6) |
| 2022 | 1 | 0.00% | -1.03R | 0.00 | −$962 | ⚠ low confidence (n=1) |
| 2023 | 2 | 0.00% | -1.08R | 0.00 | −$1,895 | ⚠ low confidence (n=2) |
| 2024 | 7 | 14.29% | -0.65R | 0.29 | −$3,919 | ⚠ low confidence (n=7) |
| 2025 | 1 | 100.00% | +1.80R | ∞ | $1,463 | ⚠ low confidence (n=1) |
| 2026 | 2 | 0.00% | -1.10R | 0.00 | −$1,806 | ⚠ low confidence (n=2) |

### By regime (daily ADX 14 at the decision, base run)

Trending ≥ 25, transitional 20–25, ranging < 20. "Share of bars" is how much of the tested period each regime covered.

| Regime | Share of bars | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|---|
| trending | 54.76% | 11 | 9.09% | -0.79R | 0.18 | −$7,778 | ⚠ low confidence (n=11) |
| transitional | 21.01% | 4 | 25.00% | -0.34R | 0.56 | −$1,243 | ⚠ low confidence (n=4) |
| ranging | 24.23% | 7 | 28.57% | -0.30R | 0.59 | −$1,936 | ⚠ low confidence (n=7) |
| unknown | 0.00% | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

### Exit reasons (base run)

| Exit | Trades | Win rate | Avg R | PF | Net P&L | Confidence |
|---|---|---|---|---|---|---|
| target | 4 | 100.00% | +1.74R | ∞ | $6,039 | ⚠ low confidence (n=4) |
| stop | 18 | 0.00% | -1.06R | 0.00 | −$16,995 | ⚠ low confidence (n=18) |
| time | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |
| end_of_data | 0 | 0.00% | +0.00R | — | $0 | ⚠ low confidence (n=0) |

### Why it did nothing (every 4h evaluation, base run)

| Reason code | Meaning | Evaluations | Share |
|---|---|---|---|
| `no_setup` | no entry setup on this bar | 6,760 | 41.18% |
| `bias_neutral` | weekly bias neutral (between SMA 50 and 200) | 3,859 | 23.51% |
| `adx_weak` | 4h ADX under the threshold | 2,768 | 16.86% |
| `daily_disagrees` | daily close disagrees with the weekly bias | 2,424 | 14.77% |
| `room_to_target` | opposing S/R under 1.5R away | 255 | 1.55% |
| `position_open` | held an open position | 217 | 1.32% |
| `target_too_close` | target under 1.5R | 77 | 0.47% |
| `entry` | entered a trade | 22 | 0.13% |
| `cooldown` | cooldown after an exit | 22 | 0.13% |
| `stop_invalid` | stop outside 0.5%–8% | 12 | 0.07% |

## Buy and hold

|  | Return | CAGR | Max DD |
|---|---|---|---|
| Buy and hold | 703.42% | 32.07% | 77.08% |
| Variant A (base) | -3.94% | -0.53% | 4.45% |
| Variant B (base) | -10.96% | -1.54% | 11.56% |

Buy and hold buys at the first tested bar's open and sells at the last close, paying slippage and the fee once each way; its drawdown is marked at 4h closes.

## Method

- **Same rules as live:** every decision is `evaluateSwing(snapshotAt(series, k), account, variant, costs)`, the function the live agent will call.
- **No lookahead:** 4h indicators are causal; S/R levels come from `activeSRLevelsAt` (4h) and `srHtfLevelsAt` (1d), daily/weekly values from `htfValueAt`, all as of the 4h close. A test cuts the data at several bars and checks that everything before the cut is identical.
- **Entries:** decided at the 4h close, filled at the next 4h open ± slippage + taker fee, sized by the plan. Skipped if that open is more than 0.25R from the decision close (the live drift guard).
- **Exits:** stop and target are walked on the four 1h bars inside each 4h bar. An hour that opens beyond the stop or target fills at its open; an hour that trades through both counts as the stop. Fills pay slippage against the trade + the taker fee. The 42-bar time stop fills at the next 4h open. A position open at the end closes at the last close (`end_of_data`).
- **R:** net P&L ÷ (qty × |entry fill − stop|). Profit factor = gross wins ÷ gross losses, net of costs.
- **Limits applied:** 1 position, 2 entries per UTC day, 1-bar cooldown, −3% daily loss stop, 15% drawdown halt (never re-armed in the backtest).
- **ADX ≥ 25 line:** the same run with the 4h ADX entry threshold at 25 instead of 20 (sensitivity only; the approved threshold is 20).
- **Data gaps:** 21 gaps in the 1h series, 3 in the 4h series (2017-02-28 20:00 UTC, 1 × 4h missing; 2018-08-10 04:00 UTC, 3 × 4h missing; 2025-10-25 16:00 UTC, 1 × 4h missing). 0 in-position 4h bars had no complete 1h breakdown and were walked as one bar.
