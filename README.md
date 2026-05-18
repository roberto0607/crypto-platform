# TRADR

Competitive crypto paper-trading platform — trade BTC/ETH/SOL with simulated
balances, compete in 1v1 ELO-ranked matches, and analyze markets with
professional charting indicators.

- **Monorepo**: `apps/api` (Fastify/TypeScript) + `apps/web` (Vite/React). Each
  app is an independent pnpm project with its own `package.json` and lockfile —
  install and run commands are per-app.
- **Database**: PostgreSQL 16 (raw SQL via `pg`) + Redis.
- See [`CLAUDE.md`](./CLAUDE.md) for architecture and conventions.

## Quick Start

### Prerequisites

- **Node.js** 20+
- **pnpm** 9+ — `npm install -g pnpm`
- **Docker** with Compose v2 (Docker Desktop)

### 1. Install dependencies

```bash
cd apps/api && pnpm install
cd ../web   && pnpm install
```

### 2. Configure environment

```bash
cd apps/api
cp .env.example .env        # then set JWT_ACCESS_SECRET; DATABASE_URL is pre-set for local dev
```

### 3. Start the database + run migrations

```bash
cd apps/api
pnpm bootstrap
```

`pnpm bootstrap` starts the `tradr_postgres` container (Postgres 16, port
**5435**) and applies every migration. It blocks until the database healthcheck
passes, so `pnpm dev` is safe to run immediately after.

### 4. Run the apps

```bash
# terminal 1 — API  → http://localhost:3001
cd apps/api && pnpm dev

# terminal 2 — web  → http://localhost:5173
cd apps/web && pnpm dev
```

### Tests

```bash
cd apps/api && pnpm test   # API suite — needs the dev DB (run `pnpm bootstrap` first)
cd apps/web && pnpm test   # web suite
```

## Local database

The dev database runs in Docker via the `tradr_postgres` service in
[`docker-compose.yml`](./docker-compose.yml), on **port 5435**:

```
DATABASE_URL=postgresql://cp:cp@localhost:5435/cp   # apps/api/.env
```

> **Why 5435?** Ports 5433 and 5434 are taken on the maintainer's machine by
> unrelated projects. On any other machine the port is free to change — just
> keep `DATABASE_URL` in `apps/api/.env` in sync with the port mapping for
> `tradr_postgres` in `docker-compose.yml`.

Manage the container directly:

```bash
docker compose up -d --wait tradr_postgres   # start (blocks until healthy)
docker compose stop tradr_postgres           # stop
```
