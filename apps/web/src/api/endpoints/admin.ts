import client from "../client";
import type { UUID } from "@/types/api";

// ── Users ───────────────────────────────────────────────────
export function listUsers() {
  return client.get<{ ok: true; users: AdminUser[] }>("/admin/users");
}

export function changeRole(userId: UUID, role: "USER" | "ADMIN") {
  return client.patch<{ ok: true }>(`/admin/users/${userId}/role`, { role });
}

export function setAccountStatus(userId: UUID, status: string) {
  return client.patch<{ ok: true }>("/admin/account-status", { userId, status });
}

export function setQuotas(userId: UUID, quotas: { maxOrdersPerMin?: number; maxOpenOrders?: number; maxDailyOrders?: number }) {
  return client.post<{ ok: true }>(`/admin/users/${userId}/quotas`, quotas);
}

export function getAccountLimits(userId: UUID) {
  return client.get<{ ok: true; limits: AccountLimit[] }>("/admin/account-limits", { params: { userId } });
}

export function putAccountLimits(params: { userId: UUID; limitType: string; maxValue: number; status?: string }) {
  return client.put<{ ok: true }>("/admin/account-limits", params);
}

export function unquarantineUser(userId: UUID) {
  return client.post<{ ok: true }>(`/admin/users/${userId}/unquarantine`);
}

// ── Assets & Pairs ──────────────────────────────────────────
export function createAsset(params: { symbol: string; name: string; decimals: number }) {
  return client.post<{ ok: true; asset: { id: UUID } }>("/admin/assets", params);
}

export function createPair(params: { baseAssetId: UUID; quoteAssetId: UUID; symbol: string; feeBps?: number; makerFeeBps?: number; takerFeeBps?: number }) {
  return client.post<{ ok: true; pair: { id: UUID } }>("/admin/pairs", params);
}

export function setPrice(pairId: UUID, price: string) {
  return client.patch<{ ok: true }>(`/admin/pairs/${pairId}/price`, { price });
}

export function toggleTrading(pairId: UUID, enabled: boolean) {
  return client.post<{ ok: true }>(`/admin/pairs/${pairId}/trading`, { enabled });
}

// ── Wallets ─────────────────────────────────────────────────
export function creditWallet(walletId: UUID, amount: string) {
  return client.post<{ ok: true }>(`/admin/wallets/${walletId}/credit`, { amount });
}

export function debitWallet(walletId: UUID, amount: string) {
  return client.post<{ ok: true }>(`/admin/wallets/${walletId}/debit`, { amount });
}

// ── System ──────────────────────────────────────────────────
export function setTradingGlobal(enabled: boolean) {
  return client.post<{ ok: true }>("/admin/system/trading-global", { enabled });
}

export function setReadOnly(enabled: boolean) {
  return client.post<{ ok: true }>("/admin/system/read-only", { enabled });
}

export function getMigrationStatus() {
  return client.get<{ ok: true; migrations: MigrationInfo[] }>("/admin/system/migration-status");
}

export function getBackups() {
  return client.get<{ ok: true; backups: BackupInfo[] }>("/admin/system/backups");
}

export function restoreDrill() {
  return client.post<{ ok: true; result: Record<string, unknown> }>("/admin/system/restore-drill");
}

// ── Risk ────────────────────────────────────────────────────
export function getRiskLimits() {
  return client.get<{ ok: true; limits: RiskLimit[] }>("/admin/risk-limits");
}

export function upsertRiskLimit(params: { userId?: UUID; limitType: string; maxValue: number }) {
  return client.put<{ ok: true }>("/admin/risk-limits", params);
}

export function getBreakers() {
  return client.get<{ ok: true; breakers: Breaker[] }>("/admin/breakers");
}

export function resetBreaker(breakerKey: string) {
  return client.post<{ ok: true }>("/admin/breakers/reset", { breakerKey });
}

export function getQueueStats() {
  return client.get<{ ok: true; stats: QueueStats }>("/admin/queue");
}

// ── Reconciliation ──────────────────────────────────────────
export function getLatestReconRun() {
  return client.get<{ ok: true; run: ReconRun }>("/admin/reconciliation/runs/latest");
}

export function runReconciliation() {
  return client.post<{ ok: true; run: ReconRun }>("/admin/reconciliation/run");
}

export function getReconReports(params?: { userId?: UUID; severity?: string; cursor?: string; limit?: number }) {
  return client.get<{ ok: true; reports: ReconReport[]; nextCursor: string | null }>("/admin/reconciliation/reports", { params });
}

// ── Incidents ───────────────────────────────────────────────
export function listIncidents(params?: { status?: string; userId?: UUID; cursor?: string; limit?: number }) {
  return client.get<{ ok: true; incidents: Incident[]; nextCursor: string | null }>("/admin/incidents", { params });
}

export function getIncident(id: UUID) {
  return client.get<{ ok: true; incident: Incident }>(`/admin/incidents/${id}`);
}

export function getIncidentEvents(id: UUID) {
  return client.get<{ ok: true; events: IncidentEvent[] }>(`/admin/incidents/${id}/events`);
}

export function acknowledgeIncident(id: UUID, note: string) {
  return client.post<{ ok: true }>(`/admin/incidents/${id}/acknowledge`, { note });
}

export function addIncidentNote(id: UUID, note: string) {
  return client.post<{ ok: true }>(`/admin/incidents/${id}/notes`, { note });
}

export function resolveIncident(id: UUID, summary: Record<string, unknown>) {
  return client.post<{ ok: true }>(`/admin/incidents/${id}/resolve`, { summary });
}

export function getProofPack(id: UUID) {
  return client.get<{ ok: true; proofPack: Record<string, unknown> }>(`/admin/incidents/${id}/proof-pack`);
}

// ── Repair ──────────────────────────────────────────────────
export function repairDryRun(userId: UUID, pairId?: UUID) {
  return client.post<{ ok: true; diff: RepairDiff }>("/admin/repair/positions/dry-run", { userId, pairId });
}

export function repairApply(userId: UUID, pairId?: UUID) {
  return client.post<{ ok: true }>("/admin/repair/positions/apply", { userId, pairId });
}

export function reconcileUser(userId: UUID) {
  return client.post<{ ok: true }>(`/admin/repair/users/${userId}/reconcile`);
}

export function unquarantineIfClean(userId: UUID) {
  return client.post<{ ok: true }>(`/admin/repair/users/${userId}/unquarantine-if-clean`);
}

export function getRepairRuns() {
  return client.get<{ ok: true; runs: RepairRun[] }>("/admin/repair/runs");
}

// ── Jobs ────────────────────────────────────────────────────
export function listJobs() {
  return client.get<{ ok: true; jobs: Job[] }>("/admin/jobs");
}

export function patchJob(name: string, params: { enabled?: boolean; intervalMs?: number }) {
  return client.patch<{ ok: true; job: Job }>(`/admin/jobs/${name}`, params);
}

export function runJob(name: string) {
  return client.post<{ ok: true }>(`/admin/jobs/${name}/run`);
}

// ── Retention ───────────────────────────────────────────────
export function getRetentionStatus() {
  return client.get<{ ok: true; status: RetentionStatus }>("/admin/retention-status");
}

export function getRetentionStats() {
  return client.get<{ ok: true; stats: RetentionStats[] }>("/admin/retention/stats");
}

export function runRetention() {
  return client.post<{ ok: true }>("/admin/retention/run");
}

// ── Beta / Invites ──────────────────────────────────────────
export function listInvites() {
  return client.get<{ ok: true; invites: Invite[] }>("/admin/invites");
}

export function createInvite(params: { code: string; maxUses: number; expiresAt?: string }) {
  return client.post<{ ok: true; invite: Invite }>("/admin/invites", params);
}

export function disableInvite(id: UUID) {
  return client.post<{ ok: true }>(`/admin/invites/${id}/disable`);
}

// ── Event Stream ────────────────────────────────────────────
export function listEvents(params?: { entityType?: string; entityId?: UUID; fromId?: string; cursor?: string; limit?: number }) {
  return client.get<{ ok: true; events: StreamEvent[]; nextCursor: string | null }>("/admin/event-stream", { params });
}

export function getEvent(id: string) {
  return client.get<{ ok: true; event: StreamEvent }>(`/admin/event-stream/${id}`);
}

export function verifyEventChain() {
  return client.post<{ ok: true; valid: boolean; errors: string[] }>("/admin/event-stream/verify");
}

// ── Outbox ──────────────────────────────────────────────────
export function getOutboxStats() {
  return client.get<{ ok: true; stats: OutboxStats }>("/admin/outbox/stats");
}

export function listOutbox(params?: { status?: string; cursor?: string; limit?: number }) {
  return client.get<{ ok: true; events: OutboxEvent[]; nextCursor: string | null }>("/admin/outbox", { params });
}

export function retryOutboxEvent(id: string) {
  return client.post<{ ok: true }>(`/admin/outbox/retry/${id}`);
}

export function replayOutbox(params?: { fromId?: string; limit?: number }) {
  return client.post<{ ok: true; replayed: number }>("/admin/outbox/replay", params);
}

// ── Admin types (local to frontend) ────────────────────────
export interface AdminUser {
  id: UUID;
  email: string;
  role: "USER" | "ADMIN";
  created_at: string;
  account_status?: string;
}

export interface AccountLimit {
  id: UUID;
  user_id: UUID;
  limit_type: string;
  max_value: number;
  current_value: number;
  status: string;
}

export interface MigrationInfo {
  name: string;
  applied_at: string;
}

export interface BackupInfo {
  name: string;
  size: number;
  created_at: string;
}

export interface RiskLimit {
  id: UUID;
  user_id: UUID | null;
  limit_type: string;
  max_value: number;
}

export interface Breaker {
  breaker_key: string;
  reason: string | null;
  closes_at: string | null;
  created_at: string;
}

export interface QueueStats {
  pairs: Array<{ pairId: UUID; symbol: string; depth: number; processing: boolean }>;
}

export interface ReconRun {
  id: UUID;
  status: string;
  started_at: string;
  finished_at: string | null;
  findings_count: number;
}

export interface ReconReport {
  id: UUID;
  user_id: UUID;
  severity: string;
  description: string;
  created_at: string;
}

export interface Incident {
  id: UUID;
  user_id: UUID | null;
  type: string;
  status: string;
  severity: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface IncidentEvent {
  id: UUID;
  incident_id: UUID;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RepairDiff {
  positions: Array<{ pair_id: UUID; computed: string; actual: string; delta: string }>;
}

export interface RepairRun {
  id: UUID;
  user_id: UUID;
  status: string;
  dry_run: boolean;
  findings: number;
  created_at: string;
}

export interface Job {
  name: string;
  enabled: boolean;
  interval_ms: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

export interface RetentionStatus {
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
}

export interface RetentionStats {
  table_name: string;
  row_count: number;
  size_bytes: number;
}

export interface Invite {
  id: UUID;
  code: string;
  max_uses: number;
  use_count: number;
  disabled: boolean;
  expires_at: string | null;
  created_at: string;
}

export interface StreamEvent {
  id: string;
  entity_type: string;
  entity_id: UUID;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface OutboxStats {
  total: number;
  pending: number;
  delivered: number;
  failed: number;
}

export interface OutboxEvent {
  id: string;
  event_type: string;
  status: string;
  payload: Record<string, unknown>;
  retry_count: number;
  created_at: string;
}
