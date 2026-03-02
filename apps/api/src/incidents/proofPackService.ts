import { pool } from "../db/pool";
import { proofPacksGeneratedTotal, proofPackBuildMs } from "../metrics";
import { getIncidentById, listIncidents, listEvents } from "./incidentRepo";
import { listRepairRuns } from "../repair/repairRepo";
import type { ProofPack } from "./incidentTypes";

const MAX_ORDERS = 50;
const MAX_TRADES = 200;
const MAX_LEDGER = 500;
const MAX_REPORTS = 200;
const MAX_EQUITY = 50;

/**
 * Build an audit proof pack for a user/incident.
 * Gathers bounded slices of all relevant data.
 */
export async function buildProofPack(params: {
  userId: string;
  incidentId?: string;
  orderId?: string;
  fromTs?: string;
  toTs?: string;
}): Promise<ProofPack> {
  const startMs = performance.now();
  const truncated: Record<string, boolean> = {};

  // ── User ──
  const userResult = await pool.query<{
    id: string;
    email: string;
    role: string;
  }>(
    `SELECT id, email, role FROM users WHERE id = $1`,
    [params.userId],
  );
  const userRow = userResult.rows[0];

  const statusResult = await pool.query<{ account_status: string }>(
    `SELECT account_status FROM account_limits WHERE user_id = $1`,
    [params.userId],
  );
  const accountStatus = statusResult.rows[0]?.account_status ?? "ACTIVE";

  // ── Incidents ──
  let incidents;
  if (params.incidentId) {
    const single = await getIncidentById(params.incidentId);
    incidents = single ? [single] : [];
  } else {
    const result = await listIncidents({
      userId: params.userId,
      limit: 3,
      offset: 0,
    });
    incidents = result.rows;
  }

  // ── Incident events ──
  const incidentEvents = incidents.length > 0
    ? await listEvents(incidents[0].id)
    : [];

  // ── Reconciliation reports ──
  const reconRunIds = incidents
    .map((i) => i.recon_run_id)
    .filter((id): id is string => id !== null);

  let reportsQuery: string;
  let reportsValues: unknown[];

  if (reconRunIds.length > 0) {
    reportsQuery = `SELECT id, run_id, user_id, severity, check_name, details, created_at
       FROM reconciliation_reports
       WHERE (run_id = ANY($1) OR user_id = $2)
       ORDER BY created_at DESC
       LIMIT $3`;
    reportsValues = [reconRunIds, params.userId, MAX_REPORTS + 1];
  } else {
    reportsQuery = `SELECT id, run_id, user_id, severity, check_name, details, created_at
       FROM reconciliation_reports
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`;
    reportsValues = [params.userId, MAX_REPORTS + 1];
  }

  const reportsResult = await pool.query(reportsQuery, reportsValues);
  if (reportsResult.rows.length > MAX_REPORTS) {
    truncated.reports = true;
    reportsResult.rows.length = MAX_REPORTS;
  }

  // ── Repair runs ──
  const repairRunsResult = await listRepairRuns(params.userId, 20, 0);

  // ── Orders ──
  let ordersQuery: string;
  let ordersValues: unknown[];

  if (params.orderId) {
    ordersQuery = `SELECT * FROM orders WHERE id = $1 AND user_id = $2`;
    ordersValues = [params.orderId, params.userId];
  } else {
    ordersQuery = `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`;
    ordersValues = [params.userId, MAX_ORDERS + 1];
  }

  const ordersResult = await pool.query(ordersQuery, ordersValues);
  if (ordersResult.rows.length > MAX_ORDERS) {
    truncated.orders = true;
    ordersResult.rows.length = MAX_ORDERS;
  }

  // ── Trades ──
  const orderIds = ordersResult.rows.map((o: { id: string }) => o.id);
  let tradesRows: unknown[] = [];

  if (orderIds.length > 0) {
    const tradesResult = await pool.query(
      `SELECT * FROM trades
       WHERE buy_order_id = ANY($1) OR sell_order_id = ANY($1)
       ORDER BY executed_at DESC
       LIMIT $2`,
      [orderIds, MAX_TRADES + 1],
    );
    tradesRows = tradesResult.rows;
    if (tradesRows.length > MAX_TRADES) {
      truncated.trades = true;
      tradesRows.length = MAX_TRADES;
    }
  }

  // ── Ledger entries ──
  const walletIdsResult = await pool.query<{ id: string }>(
    `SELECT id FROM wallets WHERE user_id = $1`,
    [params.userId],
  );
  const walletIds = walletIdsResult.rows.map((w) => w.id);

  let ledgerRows: unknown[] = [];
  if (walletIds.length > 0) {
    const conditions: string[] = [`wallet_id = ANY($1)`];
    const values: unknown[] = [walletIds];
    let idx = 2;

    if (params.fromTs) {
      conditions.push(`created_at >= $${idx++}`);
      values.push(params.fromTs);
    }
    if (params.toTs) {
      conditions.push(`created_at <= $${idx++}`);
      values.push(params.toTs);
    }

    values.push(MAX_LEDGER + 1);

    const ledgerResult = await pool.query(
      `SELECT * FROM ledger_entries
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${idx}`,
      values,
    );
    ledgerRows = ledgerResult.rows;
    if (ledgerRows.length > MAX_LEDGER) {
      truncated.ledger = true;
      ledgerRows.length = MAX_LEDGER;
    }
  }

  // ── Positions ──
  const positionsResult = await pool.query(
    `SELECT * FROM positions WHERE user_id = $1`,
    [params.userId],
  );

  // ── Equity snapshots ──
  const equityResult = await pool.query(
    `SELECT * FROM equity_snapshots
     WHERE user_id = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [params.userId, MAX_EQUITY],
  );

  const durationMs = performance.now() - startMs;
  proofPackBuildMs.observe(durationMs);
  proofPacksGeneratedTotal.inc();

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role,
      accountStatus,
    },
    incidents,
    incidentEvents,
    reconciliationReports: reportsResult.rows,
    repairRuns: repairRunsResult.rows,
    orders: ordersResult.rows,
    trades: tradesRows,
    ledgerEntries: ledgerRows,
    positions: positionsResult.rows,
    equitySnapshots: equityResult.rows,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}
