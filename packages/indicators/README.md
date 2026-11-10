# Shared indicator math

The one source for indicator math used by both the chart (`apps/web`) and the
API/agents (`apps/api`). Plain TypeScript, no dependencies, written to compile
under the stricter of the two tsconfigs (web's `noUncheckedIndexedAccess`,
`noUnused*`).

Each Docker build uses its own app directory as the build context, so neither
app can import this folder. Instead `scripts/sync-indicators.mjs` writes
byte-identical, committed copies to:

- `apps/api/src/indicators/shared/`
- `apps/web/src/lib/sharedIndicators/`

Never edit those copies. Edit `src/`, then:

```bash
node scripts/sync-indicators.mjs          # regenerate the copies
node scripts/sync-indicators.mjs --check  # what CI runs; exits 1 on any drift
```

## Parity tests

`fixtures/btcusd-coinbase.json` holds real Coinbase BTC-USD candles (4h from
1h, 1w from 1d on Monday 00:00 UTC buckets). `fixtures/golden.json` pins a
fingerprint of every indicator's output on it. The API suite
(`indicators/__tests__/sharedParity.test.ts`) and the web suite
(`lib/__tests__/sharedIndicatorsParity.test.ts`) each check their copy against
the golden to 1e-9, and the web suite checks that the API copy is
byte-identical to its own.

`fixtures/tradingview-reference.json` is a small sample of TradingView's own
values (COINBASE:BTCUSD: SMA 20/50/200, RSI 14, ATR 14, ADX 14/14) and every
UT Bot Alerts signal in the window that overlaps the fixture;
`indicators/__tests__/tradingViewReference.test.ts` checks our output against
it. Its header lists the known Coinbase-vs-TradingView data differences that
set its tolerances.

Regenerate the golden only for an intended math change, and say in the PR
which values moved:

```bash
apps/api/node_modules/.bin/tsx packages/indicators/scripts/genGolden.ts
```

Regenerate the fixture (network, public Coinbase API) with
`node packages/indicators/scripts/fetchFixture.mjs`; that changes the golden too.
