# Runbook: restrict TRADR to BTC/USD, ETH/USD, SOL/USD

The code enforces the restriction on its own: `MARKET_SYMBOLS` (default `BTC-USD,ETH-USD,SOL-USD`)
now gates listing, search, order/trigger/alert/replay placement, the Kraken/Coinbase
subscriptions, the symbol-sync job, and new-user wallet provisioning. The data step below only
brings `trading_pairs.is_active` in line. It is one-time and reversible, and it deletes nothing.

## Order

1. **Merge the PR. Let Railway deploy the API (`crypto-platform`), then the web (`gallant-reprieve`).**
   The order doesn't matter much. If the web goes first, the login-page ticker just stays hidden
   until `/v1/market/tickers` exists.
2. **Verify the deploy** (no DB writes yet):
   - `curl -s https://api.playtradr.com/v1/market/tickers` returns exactly BTC/USD, ETH/USD and SOL/USD
     with live prices.
   - The API boot logs show the Kraken/Coinbase subscriptions reconciling to 3 symbols, not ~19.
   - Log in: the pair search shows only BTC/ETH/SOL, and the trade page opens on BTC/USD.
3. **Run the data step: dry-run first** (from your laptop, in `apps/api` of a checkout that has
   your `.env`. The script needs `JWT_ACCESS_SECRET` set to *something* to load config).

   Confirm the live Postgres service name first. The shell may be linked to
   `Postgres-OLD-crashed`, which must stay untouched. The commands below assume `Postgres-v2`.

   ```bash
   cd apps/api
   railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm pairs:restrict'
   ```

   Check the output:
   - the first line says `allowlist (MARKET_SYMBOLS): BTC/USD, ETH/USD, SOL/USD`. A local `.env`
     `MARKET_SYMBOLS` would override it.
   - `kept active` lists all three, and there is no `WARNING — allowlisted but not active`.
   - `to deactivate` lists the 16 pairs, with each pair's open positions / orders / triggers / alerts.
4. **Commit.**
   - If every row shows 0 orders and 0 triggers:
     ```bash
     railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm pairs:restrict --commit'
     ```
   - If any row has open orders or active triggers, those pairs are **skipped** unless you add
     `--cancel-open`. That flag cancels them through the normal cancel path, which releases reserved
     funds, and also cancels active alerts on those pairs:
     ```bash
     railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm pairs:restrict --commit --cancel-open'
     ```
   - Open positions never block the step. They stay as rows, valued at the pair's last price, and
     they can't be traded once step 1 is live, whatever the flag says.
   - The step writes `pair-restriction-<timestamp>.json` (gitignored) and prints the undo command.
     Keep that file.
5. **Verify:** a dry-run again shows `to deactivate: 0 pair(s)`.

## Undo

```bash
railway run --service Postgres-v2 -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm pairs:restrict --revert pair-restriction-<timestamp>.json'
```

This re-activates exactly the recorded pairs. Canceled orders, triggers and alerts stay canceled.
The pairs remain hidden and untradable until `MARKET_SYMBOLS` also includes them.

## Notes

- Wallets for the other assets are left alone. New users only get wallets for BTC, ETH, SOL and USD.
- The 6h symbol-refresh job can no longer add or re-activate pairs outside `MARKET_SYMBOLS`.
  Its market-cap prune is unchanged.
