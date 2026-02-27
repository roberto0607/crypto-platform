# Dev Sandbox

Scripts for deterministic seeding, safe reset, and demo scenarios.

## Prerequisites

- PostgreSQL running: `docker compose up -d`
- Migrations applied: `cd apps/api && pnpm migrate`
- `.env` configured with `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`

## Commands

All commands run from `apps/api/`:

| Command | Description |
|---------|-------------|
| `pnpm dev:seed` | Seed dev data (users, assets, pair, wallets, candles) |
| `pnpm dev:reset` | Wipe transactional data (requires `--force`) |
| `pnpm dev:demo` | Run demo scenario (buy + sell + print results) |
| `pnpm dev:sandbox` | Full cycle: reset + seed + demo |

## Seed Data

| Entity | Details |
|--------|---------|
| Admin user | `admin@demo.local` / `Admin123!` (role: admin) |
| Demo user | `demo@demo.local` / `Demo123!` (role: user) |
| Assets | BTC (8 decimals), USD (2 decimals) |
| Pair | BTC/USD (fee: 10 bps, maker: 2, taker: 5) |
| Wallets | Admin: 10 BTC + 500k USD. Demo: 1 BTC + 100k USD |
| Candles | 24 x 1h starting 2025-01-01T00:00Z (42000 → 43650) |

## Safety

- **Production guard**: `reset.ts` and `demoScenario.ts` refuse to run when `NODE_ENV=production`
- **Force flag**: `reset.ts` requires `--force` to execute
- **Transaction safety**: All destructive operations wrapped in a single PostgreSQL transaction
- **Idempotent seed**: Uses `ON CONFLICT ... DO UPDATE` — safe to re-run
- **No randomness**: All seed data is deterministic (fixed values, no Math.random)

## Expected Output

### Seed
```
Seeding dev data...
  Admin user: <uuid>
  Demo user:  <uuid>
  Assets: BTC=<uuid>, USD=<uuid>
  Pair: BTC/USD=<uuid>
  Wallets seeded for admin
  Wallets seeded for demo
  Candles: 24 x 1h entries
Seed complete.
```

### Demo
```
Running demo scenario...
Demo user: <uuid>
Pair: BTC/USD (<uuid>), last_price=43650.00000000

Placing MARKET BUY 0.10000000 BTC...
  Order: <uuid> status=FILLED
  Fills: 1
    Trade <uuid>: price=43650.00000000 qty=0.10000000 fee=...

Placing MARKET SELL 0.10000000 BTC...
  Order: <uuid> status=FILLED
  Fills: 1
    Trade <uuid>: price=43650.00000000 qty=0.10000000 fee=...

── Position ──
  base_qty:         0.00000000
  avg_entry_price:  0.00000000
  realized_pnl:     0.00000000
  fees_paid:        ...

── Latest Equity Snapshot ──
  ts:      ...
  equity:  ...

── Wallets ──
  BTC: balance=... reserved=0.00000000
  USD: balance=... reserved=0.00000000

Demo complete.
```
