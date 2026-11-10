import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser } from "../../testing/fixtures";
import { upgradeLegacyEmaConfig } from "../catalog";
import { parseChartLayoutConfig } from "../configSchema";

const SQL = readFileSync(join(__dirname, "../../../migrations/109_chart_layouts_moving_averages.sql"), "utf8");
const DOWN_SQL = readFileSync(join(__dirname, "../../../scripts/sql/109_chart_layouts_moving_averages.down.sql"), "utf8");
const MIGRATION_ID = "109_chart_layouts_moving_averages.sql";

/** Layouts as the pre-list build saved them (the API accepted exactly these keys). */
const OLD_CONFIGS: Array<[string, Record<string, unknown>]> = [
    ["all three on (Swing preset)", {
        version: 1,
        indicators: { ema20: true, ema50: true, ema200: true, keyLevels: true, vpvr: true, rsi: true, atr: true, volume: true },
        params: { vpvr: { mode: "visible" }, rsi: { period: 14 }, atr: { period: 14 } },
        panes: { order: ["rsi", "atr", "volume"], collapsed: { rsi: false } },
    }],
    ["only ema20, no params", { version: 1, indicators: { ema20: true, rsi: true } }],
    ["ema50 + ema200 (cross markers)", { version: 1, indicators: { ema50: true, ema200: true }, timeframe: "4h" }],
    ["ema200 on, others explicitly off", { version: 1, indicators: { ema20: false, ema50: false, ema200: true } }],
    ["all three explicitly off", { version: 1, indicators: { ema20: false, ema50: false, ema200: false, macd: true }, params: { rsi: { period: 14 } } }],
    ["no EMA keys at all", { version: 1, indicators: { rsi: true } }],
    ["no indicators", { version: 1, timeframe: "1d" }],
];

describe("migration 109: EMA toggles → moving-average list", () => {
    let userId: string;

    beforeAll(async () => {
        await ensureMigrations();
    });

    beforeEach(async () => {
        await resetTestData();
        userId = (await createTestUser(pool, { email: "mig109@test.com" })).id;
    });

    async function insert(name: string, config: unknown, updatedAt = "2026-01-02T03:04:05Z") {
        const { rows } = await pool.query<{ id: string }>(
            `INSERT INTO chart_layouts (user_id, name, config, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`,
            [userId, name, JSON.stringify(config), updatedAt],
        );
        return rows[0]!.id;
    }

    async function runSql(sql: string) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }
    const runMigration = () => runSql(SQL);

    /** Exact stored state: config as text (JSONB's canonical form) + updated_at. */
    async function snapshot() {
        const { rows } = await pool.query(
            `SELECT id, name, config::text AS config, updated_at FROM chart_layouts ORDER BY name`,
        );
        return rows;
    }
    async function backups() {
        const { rows } = await pool.query(`SELECT layout_id, config::text AS config, updated_at FROM chart_layouts_pre_109 ORDER BY layout_id`);
        return rows;
    }

    it("rewrites every row exactly as upgradeLegacyEmaConfig does, into a config the API accepts", async () => {
        const ids = new Map<string, string>();
        for (const [label, cfg] of OLD_CONFIGS) ids.set(label, await insert(label.slice(0, 40), cfg));

        await runMigration();

        for (const [label, cfg] of OLD_CONFIGS) {
            const { rows } = await pool.query(`SELECT config FROM chart_layouts WHERE id = $1`, [ids.get(label)]);
            const migrated = rows[0]!.config;
            expect(migrated, label).toEqual(upgradeLegacyEmaConfig(cfg));
            expect(parseChartLayoutConfig(migrated).ok, label).toBe(true);
        }
    });

    it("keeps the lines and cross of the old chart", async () => {
        const id = await insert("Swing", OLD_CONFIGS[0]![1]);
        await runMigration();
        const { rows } = await pool.query(`SELECT config FROM chart_layouts WHERE id = $1`, [id]);
        expect(rows[0]!.config.indicators).toEqual({ keyLevels: true, vpvr: true, rsi: true, atr: true, volume: true });
        expect(rows[0]!.config.params).toEqual({
            vpvr: { mode: "visible" }, rsi: { period: 14 }, atr: { period: 14 },
            movingAverages: [
                { id: "ema20", type: "EMA", length: 20, color: "#3b82f6" },
                { id: "ema50", type: "EMA", length: 50, color: "#f59e0b" },
                { id: "ema200", type: "EMA", length: 200, color: "#ef4444" },
            ],
            maCross: { fast: "ema50", slow: "ema200" },
        });
    });

    it("idempotent: a second run changes no layout and no backup", async () => {
        for (const [label, cfg] of OLD_CONFIGS) await insert(label.slice(0, 40), cfg);
        await runMigration();
        const layouts = await snapshot();
        const saved = await backups();
        await runMigration();
        expect(await snapshot()).toEqual(layouts);
        expect(await backups()).toEqual(saved);
    });

    it("layouts without the old EMA toggles are untouched (config, updated_at) and not backed up", async () => {
        const untouched: Array<[string, unknown]> = [
            ["new list", { version: 1, indicators: { rsi: true }, params: { movingAverages: [{ id: "ma1", type: "SMA", length: 50, color: "#22c55e" }], maCross: undefined } }],
            ["no indicators", { version: 1, timeframe: "1d" }],
            ["empty", { version: 1 }],
            ["ema21 is not an old toggle", { version: 1, indicators: { ema21: true, macd: true } }],
            ["indicators not an object", { version: 1, indicators: ["ema20"] }],
            ["params mention ema20 only", { version: 1, params: { ema20: true } }],
        ];
        for (const [name, cfg] of untouched) await insert(name, cfg);
        const before = await snapshot();
        await runMigration();
        expect(await snapshot()).toEqual(before);
        expect(await backups()).toEqual([]);
    });

    it("reversible: the down script restores every original config and updated_at, and un-registers 109", async () => {
        const ids: string[] = [];
        for (const [label, cfg] of OLD_CONFIGS) ids.push(await insert(label.slice(0, 40), cfg));
        const before = await snapshot();
        await runMigration();
        expect(await snapshot()).not.toEqual(before);

        try {
            await runSql(DOWN_SQL);
            expect(await snapshot()).toEqual(before);
            const { rows } = await pool.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [MIGRATION_ID]);
            expect(rows).toHaveLength(0);

            // Re-applying after a rollback converts them again, the same way.
            await runMigration();
            for (const [i, [, cfg]] of OLD_CONFIGS.entries()) {
                const r = await pool.query(`SELECT config FROM chart_layouts WHERE id = $1`, [ids[i]]);
                expect(r.rows[0]!.config).toEqual(upgradeLegacyEmaConfig(cfg));
            }
        } finally {
            await pool.query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [MIGRATION_ID]);
        }
    });

    it("the down script keeps a layout the user saved again after 109", async () => {
        const id = await insert("edited", OLD_CONFIGS[0]![1]);
        await runMigration();
        const edited = { version: 1, indicators: { macd: true } };
        await pool.query(`UPDATE chart_layouts SET config = $2 WHERE id = $1`, [id, JSON.stringify(edited)]);
        try {
            await runSql(DOWN_SQL);
            const { rows } = await pool.query(`SELECT config FROM chart_layouts WHERE id = $1`, [id]);
            expect(rows[0]!.config).toEqual(edited);
        } finally {
            await pool.query(`INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [MIGRATION_ID]);
        }
    });

    it("leaves updated_at alone, leaves already-converted rows alone, and is idempotent", async () => {
        const converted = {
            version: 1,
            indicators: { ema20: true },
            params: { movingAverages: [{ id: "x", type: "SMA", length: 9, color: "#ffffff" }] },
        };
        const a = await insert("old", OLD_CONFIGS[1]![1]);
        const b = await insert("mixed", converted);
        await runMigration();
        const first = await pool.query(`SELECT id, config, updated_at FROM chart_layouts ORDER BY name`);
        await runMigration();
        const second = await pool.query(`SELECT id, config, updated_at FROM chart_layouts ORDER BY name`);

        expect(second.rows).toEqual(first.rows);
        for (const r of second.rows) expect(new Date(r.updated_at).toISOString()).toBe("2026-01-02T03:04:05.000Z");
        const mixed = second.rows.find((r) => r.id === b)!.config;
        expect(mixed).toEqual({ version: 1, indicators: {}, params: converted.params });
        expect(second.rows.find((r) => r.id === a)!.config.params.movingAverages).toHaveLength(1);

        // The updated_at trigger is back on for normal writes.
        await pool.query(`UPDATE chart_layouts SET name = 'renamed' WHERE id = $1`, [a]);
        const { rows } = await pool.query(`SELECT updated_at FROM chart_layouts WHERE id = $1`, [a]);
        expect(new Date(rows[0]!.updated_at).getTime()).toBeGreaterThan(Date.parse("2026-01-03"));
    });
});
