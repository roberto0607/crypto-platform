import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import { autoCreateWallets } from "../autoWallets";
import { createCompetition } from "../../competitions/competitionRepo";
import { STARTING_CAPITAL_USD } from "../startingCapital";

let userId: string;

beforeAll(async () => {
  await ensureMigrations();
});

beforeEach(async () => {
  await resetTestData();
  const user = await createTestUser(pool);
  userId = user.id;
  await createTestAssetAndPair(pool); // creates BTC + USD assets
});

async function freePlayWallets() {
  const { rows } = await pool.query<{ symbol: string; balance: string; competition_id: string | null }>(
    `SELECT a.symbol, w.balance::text AS balance, w.competition_id
     FROM wallets w JOIN assets a ON a.id = w.asset_id
     WHERE w.user_id = $1 AND w.competition_id IS NULL
     ORDER BY a.symbol`,
    [userId],
  );
  return rows;
}

async function freePlayCredits() {
  const { rows } = await pool.query<{ amount: string; reference_id: string | null; reference_type: string | null }>(
    `SELECT le.amount::text AS amount, le.reference_id, le.reference_type
     FROM ledger_entries le
     JOIN wallets w ON w.id = le.wallet_id
     WHERE w.user_id = $1 AND le.entry_type = 'FREE_PLAY_CREDIT'`,
    [userId],
  );
  return rows;
}

describe("autoCreateWallets — free-play funding", () => {
  it("funds the free-play USD wallet with STARTING_CAPITAL and leaves asset wallets at 0", async () => {
    await autoCreateWallets(userId);

    const wallets = await freePlayWallets();
    const bySymbol = Object.fromEntries(wallets.map((w) => [w.symbol, w.balance]));

    expect(bySymbol.USD).toBe(STARTING_CAPITAL_USD);
    expect(bySymbol.BTC).toBe("0.00000000"); // asset wallet untouched
  });

  it("writes exactly one FREE_PLAY_CREDIT ledger entry referencing the user", async () => {
    await autoCreateWallets(userId);

    const credits = await freePlayCredits();
    expect(credits).toHaveLength(1);
    expect(credits[0].amount).toBe(STARTING_CAPITAL_USD);
    expect(credits[0].reference_id).toBe(userId);
    expect(credits[0].reference_type).toBe("USER");
  });

  it("is idempotent — running twice does not double-credit ($200K)", async () => {
    await autoCreateWallets(userId);
    await autoCreateWallets(userId); // second run: wallets already exist, already funded

    const wallets = await freePlayWallets();
    const usd = wallets.find((w) => w.symbol === "USD");
    expect(usd!.balance).toBe(STARTING_CAPITAL_USD);

    const credits = await freePlayCredits();
    expect(credits).toHaveLength(1);
  });

  it("does NOT fund competition-scoped wallets (ranked stays governed by join)", async () => {
    const comp = await createCompetition({
      name: "Scope Test",
      startAt: "2026-01-01T00:00:00Z",
      endAt: "2026-12-31T00:00:00Z",
    });

    await autoCreateWallets(userId, comp.id);

    // Competition-scoped wallets exist but are all zero — no FREE_PLAY_CREDIT,
    // no COMPETITION_CREDIT written by this function.
    const { rows: compWallets } = await pool.query<{ balance: string }>(
      `SELECT balance::text AS balance FROM wallets
       WHERE user_id = $1 AND competition_id = $2`,
      [userId, comp.id],
    );
    expect(compWallets.length).toBeGreaterThan(0);
    for (const w of compWallets) expect(w.balance).toBe("0.00000000");

    const { rows: anyLedger } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ledger_entries le
       JOIN wallets w ON w.id = le.wallet_id
       WHERE w.user_id = $1`,
      [userId],
    );
    expect(anyLedger[0].count).toBe("0"); // nothing credited on the competition scope
  });

  it("joins a caller transaction and rolls back atomically on caller failure", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await autoCreateWallets(userId, null, client);
      await client.query("ROLLBACK"); // caller aborts
    } finally {
      client.release();
    }

    // Nothing persisted — no free-play wallets, no credit.
    expect(await freePlayWallets()).toHaveLength(0);
    expect(await freePlayCredits()).toHaveLength(0);
  });
});
