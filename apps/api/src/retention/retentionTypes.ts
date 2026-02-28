export interface RetentionConfig {
    equityRawRetentionDays: number;
    equity1mRetentionDays: number;
    idempotencyRetentionDays: number;
    strategySignalRetentionDays: number;
    auditLogRetentionDays: number;
}

export interface RetentionResult {
    equityRolledUp1m: number;
    equityRolledUp1d: number;
    equityRawDeleted: number;
    equity1mDeleted: number;
    idempotencyKeysDeleted: number;
    strategySignalsDeleted: number;
    auditLogsDeleted: number;
    durationMs: number;
}

export interface RetentionStats {
    tables: Array<{
        table_name: string;
        row_count: number;
        size_bytes: number;
    }>;
}
