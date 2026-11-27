# Confluence setup scanner: pre-registered study rules

Committed 2026-11-22. **Approved 2026-11-16, before any study run**, as part of the Phase 1–2 proposal. Nothing in Phase 2 has been run. No number here may change after the study starts. A change means a new pre-registration, committed before any run that uses it.

The Phase 2 code (`studyParams.ts`, PR 2a) must match this file. A test parses the JSON block at the end and fails if `studyParams.ts` differs.

## Study window and targets (the definitions the bar depends on)

- **In-sample only:** 2019-05-19 → 2023-12-31. No row from 2024-01-01 on is read.
- **Decision timing:** decide at bar k's close and enter at bar k+1's open.
- **Forward returns:** log returns to the close of bar k+6 (1 day), k+18 (3 days) and k+42 (7 days).
- **7-day R outcome**, computed separately for a long and a short:
  - Stop = 1.5 × ATR 14 (4h). Exit at the stop (or at the open if price gaps through it), otherwise at bar k+42's close. No target.
  - Costs: 5 bps fee + 5 bps slippage per side, with a stress run at double.
- **Information coefficient (IC):** Spearman correlation between the feature and the forward return.
- **Significance:** two-sided p-value from a moving-block bootstrap (block length = the horizon, 2,000 resamples). Benjamini–Hochberg correction at q = 0.10 across all feature × horizon tests.
- **Terciles:** cut points from in-sample data, then frozen.
  - **Hit rate:** how often the tercile vote matches the sign of the 7-day return, compared with the base rate for that side.
  - **R outcome:** average long R and short R in each tercile.
- **Stability:** all of the above for each calendar year (2019 is partial, then 2020–2023).

## The bar a feature must clear

Features are labelled *directional* or *gate* before the run:

- **Gate:** ATR %, ATR rank, ADX, event hours.
- **Directional:** everything else.

All of these must hold on the **7-day** target. The 1-day and 3-day results are reported but don't decide anything.

1. **Coverage:** at least 3 years of in-sample data, and at least 90% non-null within the feature's own window.
2. **Strength:** pooled |IC₇d| ≥ 0.10 and significant after correction (corrected p ≤ 0.10).
3. **Stability:** the IC has the same sign in at least 4 of 5 years (OI: at least 3 of its 4 years), and no year has the opposite sign with |IC| above 0.05.
4. **Economic value:** in the tercile where the feature votes, the voted side's average 7-day R after costs is above +0.10R, and at least 0.10R above that side's unconditional average R. A feature may qualify on one side only (votes long only, or short only).
5. **Hit rate:** at least 3 percentage points above the base rate for that side.

## Gate rule

**Gate features** qualify only if, in one tercile, both the long and the short average R are at or below −0.10R in at least 4 of 5 years. That tercile then becomes a no-trade zone.

## Scorecard rule: from votes to a decision

- **Group votes:** in each evidence group, the qualifying feature with the highest |IC₇d| casts the group's vote: +1, 0 or −1, by tercile. There is no averaging and there are no fitted weights; about 240 independent windows is too few to fit weights.
- **Independence:** if two groups' representatives correlate at |ρ| > 0.6, the weaker group is dropped.
- **Score:** the sum of the group votes, between −G and +G, where G is the number of groups admitted.
- **Minimum score:** m = max(2, ⌈G/2⌉).
- **Decision:** LONG if score ≥ m, SHORT if score ≤ −m, NO-TRADE otherwise, and NO-TRADE whenever a gate is active. Only one position at a time, held at most 7 days.
- **If G < 3:** no scorecard is built and the report's verdict is "no edge found".
- **Live OI:** OI features enter the live scorecard only if the Phase 1 OI overlap check passes (Binance vs Gate.io + OKX, both the 24h and 7d change correlations ≥ 0.8). The check was run on 2026-11-23 and **failed** (24h r = 0.720). See [confluence-oi-overlap-2026-11.md](confluence-oi-overlap-2026-11.md).

## Bar to propose Phase 3

1. **Full in-sample:** at least 30 calls, stress average R above 0, and MAR at least baseline (b)'s 0.23.
2. **Nested check:** pick the features again using 2019-05 → 2021-12 only, freeze them, and run on 2022 → 2023. Needs at least 10 calls and an average R above 0. This costs no out-of-sample data.

## Machine-readable copy

PR 2a's test compares `studyParams.ts` with this block. `gateFeatures` maps the gate labels above to `setup_features` columns.

```json
{
  "approved": "2026-11-16",
  "committed": "2026-11-22",
  "inSample": { "start": "2019-05-19", "endExclusive": "2024-01-01" },
  "targets": {
    "entry": "next_bar_open",
    "horizonBars": [6, 18, 42],
    "decisionHorizonBars": 42,
    "stopAtr": 1.5,
    "atrPeriod": 14,
    "feeBpsPerSide": 5,
    "slippageBpsPerSide": 5,
    "stressCostMultiplier": 2
  },
  "significance": {
    "ic": "spearman",
    "bootstrap": "moving_block",
    "blockLength": "horizon",
    "resamples": 2000,
    "correction": "benjamini_hochberg",
    "q": 0.10
  },
  "featureBar": {
    "decidingHorizonBars": 42,
    "minYears": 3,
    "minNonNull": 0.90,
    "minAbsIc": 0.10,
    "maxCorrectedP": 0.10,
    "sameSignYears": { "required": 4, "of": 5 },
    "sameSignYearsOi": { "required": 3, "of": 4 },
    "maxOppositeSignAbsIc": 0.05,
    "minVotedSideAvgR": 0.10,
    "minVotedSideEdgeR": 0.10,
    "minHitRateEdgePp": 3
  },
  "gateFeatures": [
    "v_atr_pct_4h", "v_atr_pct_1d", "v_atr_pct_rank_1y",
    "v_adx_4h", "v_adx_1d",
    "e_hours_to_fomc", "e_hours_since_fomc", "e_hours_to_cpi", "e_hours_since_cpi"
  ],
  "gateRule": { "maxAvgRBothSides": -0.10, "years": { "required": 4, "of": 5 } },
  "scorecard": {
    "voter": "highest_abs_ic_qualifying_feature_per_group",
    "votes": [-1, 0, 1],
    "maxGroupCorrelation": 0.6,
    "minScore": "max(2, ceil(G/2))",
    "minGroups": 3,
    "maxOpenPositions": 1,
    "maxHoldBars": 42
  },
  "liveOi": { "minCorrelation24h": 0.8, "minCorrelation7d": 0.8, "dailyPointUtcHour": 16, "overlapDays": 180 },
  "phase3": {
    "fullInSample": { "minCalls": 30, "stressAvgRAbove": 0, "minMar": 0.23 },
    "nested": {
      "selectStart": "2019-05-19",
      "selectEndExclusive": "2022-01-01",
      "testStart": "2022-01-01",
      "testEndExclusive": "2024-01-01",
      "minCalls": 10,
      "avgRAbove": 0
    }
  }
}
```

## Addendum, 2026-11-26: implementation choices (approved before any study run)

These were approved on 2026-11-26, before any study code existed or ran on real data. They settle points the rules above left open. None of the numbers above changes. The JSON block below is part of the pre-registration and PR 2a's test compares it with `studyParams.ts` the same way.

1. **Nested check, selection window only (2019-05-19 → 2021-12-31):** coverage needs at least 2 years (90% non-null unchanged). The IC must have the same sign in all 3 calendar years (2019 partial, 2020, 2021), and OI in both 2020 and 2021. The no-opposite-year rule (|IC| > 0.05) is unchanged. The gate rule needs 3 of 3 years. Everything else is unchanged. Selection rows must have their 7-day target closed before 2022-01-01, so selection never reads the test window.
2. **Targets:**
   - Entry is bar k+1's open. Forward return = ln(close of bar k+h ÷ open of bar k+1).
   - Stop = entry − side × 1.5 × ATR 14 (4h) at bar k, and 1R = 1.5 × ATR 14.
   - R after costs = (side × (exit fill − entry fill) − fees) ÷ 1R. Fills carry slippage against the trade; the fee is charged on both legs' notional.
   - The stop is checked on 4h bars k+1 … k+42. A bar that opens beyond the stop exits at that open; otherwise a low (long) or high (short) through the stop exits at the stop. Otherwise the exit is bar k+42's close.
   - A row gets no target if bar k+42's close is at or after the window's end (2024-01-01), or if any of bars k+1 … k+42 is missing.
3. **Bootstrap p-value:** moving blocks of (feature, return) pairs, block length = the horizon in bars, 2,000 resamples, fixed seed. Two-sided percentile p = min(1, 2 × (1 + number of resampled ICs on the minority side of 0) ÷ 2,001).
4. **Benjamini–Hochberg family:** every non-live numeric feature × the 3 horizons (45 features, 135 tests).
5. **Votes:** the sign of the pooled IC₇d decides which extreme tercile votes long (+1) and which votes short (−1). The middle tercile votes 0. A feature that qualifies on one side votes only on that side; its other extreme votes 0. A NULL value votes 0.
6. **Gate features** must pass rule 1 (coverage) and the gate rule. Rules 2–5 don't apply to them.
7. **Excluded from voting:** the `*_within_7d` booleans (no terciles; their IC is reported) and the live-only columns (`f_cvd_real_*`, `f_book_imbalance`, `e_news_gate`).
8. **Years:** a calendar year counts for a feature if the feature has at least one value with a target in it.
9. **Independence:** Spearman ρ between two groups' representatives, over rows where both are non-null.
10. **Scorecard backtest:**
    - Positions use the R definition in point 2. A NO-TRADE gate is active when any qualifying gate feature's value is in its no-trade tercile.
    - After an exit, the next decision is at the close of the exit bar. Calls = trades.
    - MAR = CAGR ÷ max drawdown, at base costs, with 1% of equity at risk per trade, notional ≤ 1× equity, $100,000 starting equity, equity marked at each 4h close. This is the same accounting as Swing v2's baseline (b) (0.23).
11. **OI:** the OI features are excluded from the scorecard tested against the Phase 3 bar, because the live OI overlap check failed (2026-11-23). They are still studied and reported.

```json
{
  "addendum": "2026-11-26",
  "nestedSelection": {
    "minYears": 2,
    "sameSignYears": { "required": 3, "of": 3 },
    "sameSignYearsOi": { "required": 2, "of": 2 },
    "gateRuleYears": { "required": 3, "of": 3 }
  },
  "targetMethod": {
    "returnFrom": "open_k_plus_1",
    "stopFrom": "entry",
    "stopCheck": "4h_bars",
    "dropIfTargetCloseAtOrAfterWindowEnd": true,
    "dropIfBarMissing": true
  },
  "bootstrapMethod": { "resample": "moving_blocks_of_pairs", "pValue": "two_sided_percentile_plus_one", "seed": 20261116 },
  "bhFamily": { "features": 45, "horizons": 3, "tests": 135 },
  "excludedFromVoting": ["e_fomc_within_7d", "e_cpi_within_7d", "f_cvd_real_24h", "f_cvd_real_7d", "f_book_imbalance", "e_news_gate"],
  "oiFeatures": ["p_oi_usd", "p_oi_chg_24h", "p_oi_chg_7d"],
  "excludeOiFromScorecard": true,
  "backtest": { "riskPerTrade": 0.01, "maxNotionalToEquity": 1, "startEquity": 100000, "marCosts": "base" }
}
```
