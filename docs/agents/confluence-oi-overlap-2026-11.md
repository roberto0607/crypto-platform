# OI overlap check (2026-11-23)

Run with `pnpm agent:features:oi-overlap` (public APIs only, no database).

Binance archive vs Gate.io + OKX, BTC open interest in USD, daily points at 16:00 UTC, 2026-05-28 → 2026-11-21.

| | Points | Pearson r | Needed |
|---|---|---|---|
| 24h % change | 177 | 0.720 | ≥ 0.8 |
| 7d % change | 171 | 0.809 | ≥ 0.8 |

Daily points with all three sources: 178. Binance archive days missing: 2026-11-22 (not yet published).

**Result: FAIL. OI features are excluded from the live scorecard**, as pre-registered (both correlations had to be ≥ 0.8). The study still measures them on Binance data, and they are still recorded live. The rule doesn't change.

## Context (not part of the rule)

A one-off diagnostic run the same day, to rule out a timing bug:

- **Per venue, 24h / 7d change correlations:** Binance vs Gate.io 0.679 / 0.783, Binance vs OKX 0.584 / 0.741, Gate.io vs OKX 0.561 / 0.782. The venues disagree on day-to-day OI moves, even with each other.
- **Alignment:** Binance at 16:00 vs OKX's 16:00 daily point gives 0.584 (24h). Binance at 15:00 gives 0.538, at 17:00 0.568, at 08:00 0.246 and at 00:00 0.093. The correlation peaks when the points line up, so the timestamps are right. A 00:00 comparison would have failed by far more.
- **Level on 2026-11-18:** Binance $5.96B, Gate.io $3.81B, OKX $3.11B (BTC, USD).
