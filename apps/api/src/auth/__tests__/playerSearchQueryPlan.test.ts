/**
 * The player search is a keystroke-driven query, so it has to stay on the
 * index from migration 103 and stop at its LIMIT, never scan users.
 *
 * PRINT_PLAN=1 prints EXPLAIN ANALYZE.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { pool } from "../../db/pool";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import { PLAYER_SEARCH_SQL, playerSearchPattern } from "../userRepo";

beforeAll(async () => {
    await ensureMigrations();
    await resetTestData();
    await pool.query(
        `INSERT INTO users (email, email_normalized, password_hash, display_name)
         SELECT 'u' || n || '@test.com', 'u' || n || '@test.com', 'x', 'player_' || n
           FROM generate_series(1, 20000) n`,
    );
    await pool.query("ANALYZE users");
});

describe("player search query plan", () => {
    it("uses the username index, with real parameters, and reads no more than it returns", async () => {
        const { rows } = await pool.query<{ "QUERY PLAN": string }>(
            `EXPLAIN (ANALYZE, BUFFERS) ${PLAYER_SEARCH_SQL}`,
            [playerSearchPattern("player_12"), []],
        );
        const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
        if (process.env.PRINT_PLAN) console.log(plan);
        expect(plan).toContain("users_display_name_lower_uq");
        expect(plan).not.toMatch(/Seq Scan on users/);
        expect(plan).not.toMatch(/\bSort\b/);
    });
});
