# Multi-Instance Deployment Guide

## Recommended Topology

```
                    +-----------+
                    |   Load    |
                    | Balancer  |
                    +-----+-----+
                          |
              +-----------+-----------+
              |                       |
        +-----+-----+          +-----+-----+
        |  API  (A)  |          |  API  (B)  |
        | ROLE=API   |          | ROLE=API   |
        | port 3001  |          | port 3002  |
        +-----+-----+          +-----+-----+
              |                       |
              +-----------+-----------+
                          |
                    +-----+-----+
                    | PostgreSQL |
                    |  (single)  |
                    +-----+-----+
                          |
                    +-----+-----+
                    |  WORKER    |
                    | ROLE=WORKER|
                    | (singleton)|
                    +------------+
```

- **API replicas** (N instances): Handle HTTP traffic only. No background jobs.
- **Worker singleton** (1 instance): Runs outbox worker, job runner (reconciliation, cleanup), lock sampler via leader election.
- **PostgreSQL**: Single instance (for now). All coordination uses Postgres advisory locks.

For development, a single instance with `INSTANCE_ROLE=ALL` (the default) runs everything.

## Environment Variables

| Variable | Values | Default | Description |
|---|---|---|---|
| `INSTANCE_ID` | any string | `{hostname}-{uuid8}` | Unique identifier for this instance |
| `INSTANCE_ROLE` | `API` / `WORKER` / `ALL` | `ALL` | Controls which components start |
| `RUN_MIGRATIONS_ON_BOOT` | `true` / `false` | `false` | Run pending migrations before startup |
| `PORT` | number | `3001` | HTTP listen port |

## Instance Roles

### API (`INSTANCE_ROLE=API`)
- Starts Fastify HTTP server with all routes
- No background jobs (outbox, job runner, lock sampler are skipped)
- Safe to run N replicas behind a load balancer
- Health checks available at `/health`, `/health/instance`

### WORKER (`INSTANCE_ROLE=WORKER`)
- Starts Fastify HTTP server (for health checks only)
- Acquires advisory locks for: outbox worker, job runner, lock sampler
- If locks are held by another worker, retries every 5 seconds
- Only one worker holds each lock at a time (at-most-one guarantee)

### ALL (`INSTANCE_ROLE=ALL`)
- Default for development / single-instance deploys
- Combines API + WORKER behavior
- Still uses leader election (safe if accidentally run as multiple instances)

## Leader Election

Background jobs are coordinated via PostgreSQL session-scoped advisory locks:

| Lock Name | Controls |
|---|---|
| `leader:outbox` | Outbox event processor (polls every 1s) |
| `leader:reconciliation` | Job runner (reconciliation, cleanup, retention) |
| `leader:lockSampler` | Lock contention sampler (dev only) |
| `leader:migrations` | Migration runner (boot-time only) |

### How It Works

1. Each worker instance tries to acquire an advisory lock via a **dedicated connection**
2. If acquired, the corresponding background job starts
3. If the lock is held by another instance, the orchestrator retries every 5 seconds
4. Advisory locks are **session-scoped**: if the connection drops, Postgres auto-releases the lock
5. On graceful shutdown (SIGTERM/SIGINT), locks are explicitly released

### Failure Behavior

| Scenario | Behavior |
|---|---|
| Worker crashes | PG detects dropped connection, releases advisory locks. Another worker acquires them on next retry tick (within 5s). |
| Worker graceful shutdown | Locks released explicitly. Another worker acquires immediately. |
| PG connection timeout | Same as crash: session-scoped lock auto-released. |
| Network partition | Worker loses PG connection, lock released. Worker retries reconnection via pool. |
| Split brain (brief) | Outbox uses `FOR UPDATE SKIP LOCKED` — two workers cannot process the same row. Event stream uses `FOR UPDATE` + `pg_advisory_xact_lock` — appends are serialized. |

## Migration Strategy

Recommended approach for multi-instance deploys:

1. **Run migrations as a separate step** before deploying new instances:
   ```bash
   cd apps/api && pnpm migrate
   ```

2. Or designate one instance to run migrations on boot:
   ```bash
   INSTANCE_ROLE=WORKER RUN_MIGRATIONS_ON_BOOT=true pnpm dev
   ```

3. All other instances have a **migration guard** that exits with code 1 if the DB schema is behind the code. This prevents serving traffic with mismatched schema.

## Docker Compose Example (Multi-Instance)

Add to your existing `docker-compose.yml`:

```yaml
services:
  # ... existing postgres service ...

  api-1:
    build: ./apps/api
    environment:
      DATABASE_URL: postgresql://cp:cp@postgres:5432/cp
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      INSTANCE_ID: api-1
      INSTANCE_ROLE: API
      PORT: 3001
    ports:
      - "3001:3001"
    depends_on:
      postgres:
        condition: service_healthy

  api-2:
    build: ./apps/api
    environment:
      DATABASE_URL: postgresql://cp:cp@postgres:5432/cp
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      INSTANCE_ID: api-2
      INSTANCE_ROLE: API
      PORT: 3001
    ports:
      - "3002:3001"
    depends_on:
      postgres:
        condition: service_healthy

  worker:
    build: ./apps/api
    environment:
      DATABASE_URL: postgresql://cp:cp@postgres:5432/cp
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      INSTANCE_ID: worker-1
      INSTANCE_ROLE: WORKER
      RUN_MIGRATIONS_ON_BOOT: "true"
      PORT: 3003
    ports:
      - "3003:3003"
    depends_on:
      postgres:
        condition: service_healthy
```

## Verifying Multi-Instance Behavior

### Check instance identity
```bash
curl http://localhost:3001/health/instance
curl http://localhost:3002/health/instance
curl http://localhost:3003/health/instance
```

Expected: each returns its own `instanceId`, `role`, and `leader` status. Only the worker should show `leader: { outbox: true, reconciliation: true, lockSampler: true }`.

### Manual local test (without Docker)
```bash
# Terminal 1: API instance
INSTANCE_ID=api-1 INSTANCE_ROLE=API PORT=3001 pnpm dev

# Terminal 2: API instance
INSTANCE_ID=api-2 INSTANCE_ROLE=API PORT=3002 pnpm dev

# Terminal 3: Worker instance
INSTANCE_ID=worker-1 INSTANCE_ROLE=WORKER PORT=3003 pnpm dev
```

### Verify leadership transfer
1. Start worker-1 on port 3003
2. Confirm `curl localhost:3003/health/instance` shows leader locks held
3. Kill worker-1 (Ctrl+C)
4. Start worker-2 on port 3004
5. Confirm `curl localhost:3004/health/instance` shows leader locks acquired
