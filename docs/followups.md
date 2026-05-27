# Follow-ups

Tracked work items that are real but not blocking the task in flight. Each
should become its own PR.

---

## Incomplete migration-059 cleanup — dead references to dropped tables

**Discovered:** 2026-05-26, while running the load-test baseline (the seed
failed; root-causing it surfaced that the harness assumed pre-059 schema).

**Context:** Migration `059_drop_exchange_tables.sql` (applied 2026-05-18)
dropped the risk/governance subsystem tables for paper-trading simplification:
`incidents`, `incident_events`, `repair_runs`, `reconciliation_reports`,
`account_limits`, `circuit_breakers`, `risk_limits`, `user_quotas`.

The table drops landed, but **live `src/` code still references them**, so the
removal is half-done. These are latent bugs:

- **`apps/api/src/routes/healthRoutes.ts:92`** — runs `... FROM circuit_breakers`
  (dropped). The endpoint likely 500s when that branch executes. *(Workaround in
  the meantime: use `GET /pairs` as the API-up probe for load tests, not
  `/health`.)*
- **`apps/api/src/outbox/outboxProcessor.ts:47`** — calls
  `openIncidentsForQuarantinedUsers(reconRunId, userIds)`, which writes to the
  dropped `incidents` table. Gated behind the reconciliation job, so it does not
  fire under `DISABLE_JOB_RUNNER=true` and may be dormant in prod too — but it
  will throw if ever reached.
- **`apps/api/src/incidents/` module** (`incidentService.ts`, `incidentRepo.ts`,
  `incidentTypes.ts`, `proofPackService.ts`) and **`apps/api/src/routes/v1/v1Incidents.ts`**
  — an entire feature surface still targeting dropped tables.
- Also referencing the removed subsystem: `security/suspiciousActivityService.ts`,
  `scripts/risk-smoke.sh`, `scripts/repair-smoke.sh`. (`metrics.ts` only defines
  in-memory `incidents_*` counters — harmless, no DB access.)

**Scope of fix:** decide per reference whether to delete (subsystem is gone) or
re-point. Most likely a clean deletion of the incidents module + route +
healthRoutes query + outboxProcessor quarantine path. Needs a careful pass so
nothing else imports the removed code.

**Priority:** not blocking load testing (order placement does not gate on any
dropped table). Should be its own PR after the load-test work lands.

**Not blocking because:** verified the order-placement path
(`phase6OrderService`, `tradingRoutes.ts`, queue) has no `account_limits` /
`circuit_breakers` dependency.
