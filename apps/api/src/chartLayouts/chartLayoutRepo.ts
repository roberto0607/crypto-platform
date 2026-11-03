import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import { AppError } from "../errors/AppError";
import { CHART_LAYOUT_CATALOG, type ChartLayoutConfig } from "./catalog";

/** API shape. user_id is never returned: every query is already scoped to the caller. */
export interface ChartLayoutRow {
    id: string;
    name: string;
    config: ChartLayoutConfig;
    is_default: boolean;
    created_at: string;
    updated_at: string;
}

const COLS = "id, name, config, is_default, created_at, updated_at";

/** pg unique_violation on the (user_id, name) constraint → 409. */
function mapNameConflict(err: unknown): never {
    const e = err as { code?: string; constraint?: string };
    if (e?.code === "23505" && e.constraint === "chart_layouts_user_name_key") {
        throw new AppError("chart_layout_name_taken");
    }
    throw err;
}

/**
 * Serialize one user's layout writes. Count-then-insert (the 20 cap) and
 * clear-then-set (the single default) are only safe if two requests for the
 * same user can't interleave. Per-user advisory lock, released at COMMIT.
 */
async function lockUser(client: PoolClient, userId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('chart_layouts:' || $1, 0))`, [userId]);
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

export async function listChartLayouts(userId: string): Promise<ChartLayoutRow[]> {
    const { rows } = await pool.query<ChartLayoutRow>(
        `SELECT ${COLS} FROM chart_layouts WHERE user_id = $1 ORDER BY created_at, id`,
        [userId],
    );
    return rows;
}

export async function createChartLayout(
    userId: string,
    input: { name: string; config: ChartLayoutConfig; isDefault: boolean },
): Promise<ChartLayoutRow> {
    return inTx(async (c) => {
        await lockUser(c, userId);
        const { rows: cnt } = await c.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM chart_layouts WHERE user_id = $1`,
            [userId],
        );
        if (cnt[0]!.n >= CHART_LAYOUT_CATALOG.maxLayoutsPerUser) {
            throw new AppError("chart_layout_limit_exceeded", { max: CHART_LAYOUT_CATALOG.maxLayoutsPerUser });
        }
        if (input.isDefault) {
            await c.query(`UPDATE chart_layouts SET is_default = false WHERE user_id = $1 AND is_default`, [userId]);
        }
        try {
            const { rows } = await c.query<ChartLayoutRow>(
                `INSERT INTO chart_layouts (user_id, name, config, is_default)
                 VALUES ($1, $2, $3::jsonb, $4) RETURNING ${COLS}`,
                [userId, input.name, JSON.stringify(input.config), input.isDefault],
            );
            return rows[0]!;
        } catch (err) {
            mapNameConflict(err);
        }
    });
}

export async function updateChartLayout(
    userId: string,
    id: string,
    patch: { name?: string; config?: ChartLayoutConfig; isDefault?: boolean },
): Promise<ChartLayoutRow> {
    return inTx(async (c) => {
        await lockUser(c, userId);
        const { rows: found } = await c.query(
            `SELECT 1 FROM chart_layouts WHERE id = $1 AND user_id = $2`,
            [id, userId],
        );
        if (found.length === 0) throw new AppError("chart_layout_not_found");

        if (patch.isDefault === true) {
            await c.query(
                `UPDATE chart_layouts SET is_default = false WHERE user_id = $1 AND is_default AND id <> $2`,
                [userId, id],
            );
        }
        try {
            const { rows } = await c.query<ChartLayoutRow>(
                `UPDATE chart_layouts
                    SET name       = COALESCE($3, name),
                        config     = COALESCE($4::jsonb, config),
                        is_default = COALESCE($5, is_default)
                  WHERE id = $1 AND user_id = $2
                  RETURNING ${COLS}`,
                [
                    id,
                    userId,
                    patch.name ?? null,
                    patch.config === undefined ? null : JSON.stringify(patch.config),
                    patch.isDefault ?? null,
                ],
            );
            return rows[0]!;
        } catch (err) {
            mapNameConflict(err);
        }
    });
}

export async function deleteChartLayout(userId: string, id: string): Promise<void> {
    const { rowCount } = await pool.query(`DELETE FROM chart_layouts WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!rowCount) throw new AppError("chart_layout_not_found");
}
