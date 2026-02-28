import type { Pool } from "pg";
import type { Logger } from "pino";
import type { RetentionConfig, RetentionResult, RetentionStats } from "./retentionTypes";
import { rollupEquity1m, rollupEquity1d } from "./rollupService";
import {
    retentionRowsDeletedTotal,
    retentionRollupsTotal,
    retentionDurationMs,
    retentionFailuresTotal,
} from "../metrics";

export const DEFAULT_CONFIG: RetentionConfig = {
    equityRawRetentionDays: 7,
    equity1mRetentionDays: 90,
    idempotencyRetentionDays: 7,
    strategySignalRetentionDays: 30,
    auditLogRetentionDays: 90,
};

const MS_PER_DAY = 86_400_000;

const RETENTION_TABLES = [
    "equity_snapshots",
    "equity_snapshots_1m",
    "equity_snapshots_1d",
    "idempotency_keys",
    "strategy_signals",
    "audit_log",
];

export async function runRetention(
    pool: Pool,
    logger: Logger,
    configOverride?: Partial<RetentionConfig>,
): Promise<RetentionResult> {
    const config: RetentionConfig = { ...DEFAULT_CONFIG, ...configOverride };
    const startMs = performance.now();
    const nowMs = Date.now();

    let equityRolledUp1m = 0;
    let equityRolledUp1d = 0;
    let equityRawDeleted = 0;
    let equity1mDeleted = 0;
    let idempotencyKeysDeleted = 0;
    let strategySignalsDeleted = 0;
    let auditLogsDeleted = 0;

    try {
        // ── Step 1: Rollup raw → 1m ──
        const rawCutoffMs = nowMs - config.equityRawRetentionDays * MS_PER_DAY;
        {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                equityRolledUp1m = await rollupEquity1m(client, rawCutoffMs);
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
        }
        retentionRollupsTotal.inc({ type: "1m" }, equityRolledUp1m);
        logger.info({ equityRolledUp1m }, "Rolled up equity → 1m");

        // ── Step 2: Rollup 1m → 1d ──
        const m1CutoffMs = nowMs - config.equity1mRetentionDays * MS_PER_DAY;
        {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                equityRolledUp1d = await rollupEquity1d(client, m1CutoffMs);
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
        }
        retentionRollupsTotal.inc({ type: "1d" }, equityRolledUp1d);
        logger.info({ equityRolledUp1d }, "Rolled up equity → 1d");

        // ── Step 3: Delete raw equity_snapshots older than retention ──
        {
            const result = await pool.query(
                `DELETE FROM equity_snapshots WHERE ts < $1`,
                [rawCutoffMs],
            );
            equityRawDeleted = result.rowCount ?? 0;
        }
        retentionRowsDeletedTotal.inc({ table: "equity_snapshots" }, equityRawDeleted);
        logger.info({ equityRawDeleted }, "Deleted old raw equity snapshots");

        // ── Step 4: Delete 1m equity snapshots older than 90d ──
        {
            const result = await pool.query(
                `DELETE FROM equity_snapshots_1m WHERE bucket_ts < $1`,
                [m1CutoffMs],
            );
            equity1mDeleted = result.rowCount ?? 0;
        }
        retentionRowsDeletedTotal.inc({ table: "equity_snapshots_1m" }, equity1mDeleted);
        logger.info({ equity1mDeleted }, "Deleted old 1m equity snapshots");

        // ── Step 5: Delete expired idempotency keys ──
        {
            const result = await pool.query(
                `DELETE FROM idempotency_keys
                 WHERE created_at < now() - make_interval(days => $1)`,
                [config.idempotencyRetentionDays],
            );
            idempotencyKeysDeleted = result.rowCount ?? 0;
        }
        retentionRowsDeletedTotal.inc({ table: "idempotency_keys" }, idempotencyKeysDeleted);
        logger.info({ idempotencyKeysDeleted }, "Deleted expired idempotency keys");

        // ── Step 6: Delete old strategy signals ──
        {
            const result = await pool.query(
                `DELETE FROM strategy_signals
                 WHERE created_at < now() - make_interval(days => $1)`,
                [config.strategySignalRetentionDays],
            );
            strategySignalsDeleted = result.rowCount ?? 0;
        }
        retentionRowsDeletedTotal.inc({ table: "strategy_signals" }, strategySignalsDeleted);
        logger.info({ strategySignalsDeleted }, "Deleted old strategy signals");

        // ── Step 7: Delete old audit logs ──
        {
            const result = await pool.query(
                `DELETE FROM audit_log
                 WHERE created_at < now() - make_interval(days => $1)`,
                [config.auditLogRetentionDays],
            );
            auditLogsDeleted = result.rowCount ?? 0;
        }
        retentionRowsDeletedTotal.inc({ table: "audit_log" }, auditLogsDeleted);
        logger.info({ auditLogsDeleted }, "Deleted old audit logs");
    } catch (err) {
        retentionFailuresTotal.inc();
        throw err;
    }

    const durationMs = Math.round(performance.now() - startMs);
    retentionDurationMs.observe(durationMs);

    const result: RetentionResult = {
        equityRolledUp1m,
        equityRolledUp1d,
        equityRawDeleted,
        equity1mDeleted,
        idempotencyKeysDeleted,
        strategySignalsDeleted,
        auditLogsDeleted,
        durationMs,
    };

    logger.info({ result }, "Retention run complete");
    return result;
}

export async function getRetentionStats(pool: Pool): Promise<RetentionStats> {
    const tables: RetentionStats["tables"] = [];

    for (const tableName of RETENTION_TABLES) {
        const result = await pool.query(
            `SELECT
                 reltuples::bigint AS row_count,
                 pg_total_relation_size(quote_ident($1)) AS size_bytes
             FROM pg_class
             WHERE relname = $1`,
            [tableName],
        );
        const row = result.rows[0];
        tables.push({
            table_name: tableName,
            row_count: Number(row?.row_count ?? 0),
            size_bytes: Number(row?.size_bytes ?? 0),
        });
    }

    return { tables };
}
