/**
 * setup_features against the real test Postgres. Each
 * test uses its own symbol so nothing else's rows are touched.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../../../db/pool";
import { upsertFeatureRows, SETUP_FEATURE_COLUMNS } from "../setupFeatureRepo";
import type { FeatureRow } from "../computeFeatures";
import { FEATURE_VERSION } from "../featureParams";

const symbols: string[] = [];
const sym = () => {
  const s = `T${Math.random().toString(36).slice(2, 8).toUpperCase()}-USD`;
  symbols.push(s);
  return s;
};

afterAll(async () => {
  await pool.query(`DELETE FROM setup_features WHERE symbol = ANY($1)`, [symbols]);
});

describe("setup features", () => {
  const row = (barTime: number, close: number): FeatureRow => ({
    barTime,
    closeTime: barTime + 14_400,
    close,
    atr14_4h: 100,
    values: { m_rsi14_4h: 55.5, e_cpi_within_7d: true },
    missing: { m_rsi14_1d: "warmup" },
  });

  it("writes every known column, leaves the rest NULL with a reason, and is idempotent", async () => {
    const s = sym();
    const t = Date.parse("2021-06-01T00:00:00Z") / 1000;
    expect(await upsertFeatureRows(s, "backfill", [row(t, 35_000)])).toBe(1);
    expect(await upsertFeatureRows(s, "backfill", [row(t, 35_001)])).toBe(1);
    const { rows } = await pool.query(
      `SELECT * FROM setup_features WHERE symbol = $1`, [s],
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.feature_version).toBe(FEATURE_VERSION);
    expect(r.origin).toBe("backfill");
    expect(new Date(r.bar_time).getTime() / 1000).toBe(t);
    expect(r.close).toBe(35_001);
    expect(r.m_rsi14_4h).toBe(55.5);
    expect(r.e_cpi_within_7d).toBe(true);
    expect(r.m_rsi14_1d).toBeNull();
    expect(r.missing.m_rsi14_1d).toBe("warmup");
    // a column the row never computed: NULL, and the reason says why
    expect(r.p_funding_8h).toBeNull();
    expect(r.missing.p_funding_8h).toBe("source_not_wired");
    expect(r.f_book_imbalance).toBeNull();
    expect(r.missing.f_book_imbalance).toBe("live_only");
  });

  it("knows every feature column in the table", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'setup_features'
          AND column_name ~ '^[tmlvpfes]_'`,
    );
    expect(new Set(rows.map((r) => r.column_name))).toEqual(new Set(SETUP_FEATURE_COLUMNS));
  });

  it("writes in batches of many rows", async () => {
    const s = sym();
    const t0 = Date.parse("2021-06-01T00:00:00Z") / 1000;
    const rows = Array.from({ length: 1_200 }, (_, i) => row(t0 + i * 14_400, 30_000 + i));
    expect(await upsertFeatureRows(s, "backfill", rows)).toBe(1_200);
    const { rows: n } = await pool.query(`SELECT count(*)::int AS n FROM setup_features WHERE symbol = $1`, [s]);
    expect(n[0].n).toBe(1_200);
  });
});
