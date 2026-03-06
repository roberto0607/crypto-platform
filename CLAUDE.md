# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

All commands run from `apps/api/`:

```bash
pnpm dev              # Start dev server with hot reload (tsx watch, port 3001)
pnpm typecheck        # Type-check without emitting (tsc --noEmit)
pnpm migrate          # Run database migrations
```

Start PostgreSQL before running the API:
```bash
docker compose up -d  # Start PostgreSQL (port 5433)
```

## Architecture

This is a cryptocurrency/financial services platform built as a pnpm monorepo.

### Tech Stack
- **Runtime**: Node.js + TypeScript (strict mode, ES2022 target)
- **Framework**: Fastify v5
- **Database**: PostgreSQL 16 via `pg` (raw SQL, no ORM)
- **Auth**: Argon2 password hashing + JWT with refresh token rotation
- **Validation**: Zod for runtime schema validation
- **Execution**: tsx (dev), TypeScript compilation (prod)

### Project Layout
- `apps/api/` — Main API service (Fastify)
  - `src/server.ts` — Fastify app entry point, health check routes
  - `src/db/pool.ts` — PostgreSQL connection pool (reads `DATABASE_URL`)
  - `src/db/migrate.ts` — SQL migration runner with transaction safety
  - `migrations/` — Ordered `.sql` migration files (e.g., `001_init.sql`)
- `docker-compose.yml` — PostgreSQL container (`cp_postgres`, port 5433)

### Database
- PostgreSQL runs on **port 5433** (not default 5432) to avoid conflicts
- Connection: `postgresql://cp:cp@localhost:5433/cp`
- Migrations are plain SQL files, tracked in a `schema_migrations` table, run inside transactions
- Schema includes: `users` (with normalized email), `refresh_tokens`, `audit_log`
- Uses `pgcrypto` extension for UUID generation

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | **yes** | — | HMAC secret for access tokens |
| `PORT` | no | `3001` | HTTP listen port |
| `HOST` | no | `0.0.0.0` | HTTP listen host |
| `NODE_ENV` | no | `development` | `development` or `production` |
| `JWT_ACCESS_TTL_SECONDS` | no | `900` | Access token lifetime |
| `JWT_REFRESH_TTL_SECONDS` | no | `2592000` | Refresh token lifetime (overrides days) |
| `JWT_REFRESH_TTL_DAYS` | no | `30` | Refresh token lifetime in days |
| `CORS_ORIGINS` | no | localhost:5173,3000 | Comma-separated allowed origins |

### Key Patterns
- **No ORM** — all database access uses raw SQL via `pg` Pool
- **Audit logging** — `audit_log` table captures actor, action, target, request context, and JSONB metadata
- **Email normalization** — `email_normalized` column for case-insensitive lookups
- **Refresh token rotation** — tokens stored as hashes with expiry and revocation support
