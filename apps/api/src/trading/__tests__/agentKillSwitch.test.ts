/**
 * Agent kill-switch integration test — real PostgreSQL, real transactions.
 *
 * Required verification for Gate 1a Task 2 (the one piece of the gate not
 * considered done without this passing): flip AGENT_ACTIONS_ENABLED off
 * mid-test with an open agent order present and confirm
 *   (a) new agent-sourced orders are rejected,
 *   (b) the existing open agent order is still cancelable via the bulk
 *       admin endpoint (an admin must be able to clean up even while the
 *       switch is off — it's not gated by the switch it manages),
 *   (c) a manual (non-agent) order is completely unaffected by the flag.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { placeOrderWithSnapshot, cancelAllOrdersWithOutbox } from "../phase6OrderService";
import { createOrder } from "../orderRepo";
import { setFlag } from "../../system/systemFlagService";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import {
  createTestUser,
  createTestAssetAndPair,
  createTestWallets,
} from "../../testing/fixtures";

let user: Awaited<ReturnType<typeof createTestUser>>;
let pair: { id: string; symbol: string };
let usdWallet: { id: string };

beforeAll(async () => {
  await ensureMigrations();
});

beforeEach(async () => {
  await resetTestData();

  // resetTestData() TRUNCATEs system_flags along with everything else —
  // production never does this (the row is seeded once by migration 077
  // and lives forever), but tests need it re-seeded each time so
  // setFlag()'s UPDATE-only semantics have a row to update.
  await pool.query(
    `INSERT INTO system_flags (key, value) VALUES ('AGENT_ACTIONS_ENABLED', '{"enabled": true}')
     ON CONFLICT (key) DO NOTHING`,
  );

  user = await createTestUser(pool);
  const assets = await createTestAssetAndPair(pool);
  const wallets = await createTestWallets(
    pool, user.id, assets.btcAsset.id, assets.usdAsset.id,
    "0.00000000", "500000.00000000",
  );
  pair = assets.pair;
  usdWallet = wallets.usdWallet;
});

describe("AGENT_ACTIONS_ENABLED kill switch", () => {
  it("rejects agent-sourced orders while off, but leaves manual orders unaffected", async () => {
    await setFlag("AGENT_ACTIONS_ENABLED", { enabled: false });

    // (a) agent order rejected, before any row is written
    await expect(
      placeOrderWithSnapshot(
        user.id,
        { pairId: pair.id, side: "BUY", type: "LIMIT", qty: "1.00000000", limitPrice: "49000.00000000" },
        undefined, undefined, null, null, "agent",
      ),
    ).rejects.toMatchObject({ code: "agent_actions_disabled" });

    const { rows: countAfterRejection } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders WHERE user_id = $1`, [user.id],
    );
    expect(countAfterRejection[0]!.n).toBe(0);

    // (c) manual order (source omitted) succeeds under the exact same flag state
    const manualResult = await placeOrderWithSnapshot(
      user.id,
      { pairId: pair.id, side: "BUY", type: "LIMIT", qty: "1.00000000", limitPrice: "48000.00000000" },
      undefined, undefined, null, null,
    );
    expect(manualResult.order.status).toBe("OPEN");
    expect(manualResult.order.source).toBeNull();
  });

  it("still lets the bulk cancel-all endpoint cancel an existing open agent order while off", async () => {
    // Represents an order placed BEFORE the flag was flipped off — seeded
    // directly since placement itself is now rejected while the flag is off.
    let seededOrderId = "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const order = await createOrder(client, {
        userId: user.id,
        pairId: pair.id,
        side: "BUY",
        type: "LIMIT",
        limitPrice: "49000.00000000",
        qty: "1.00000000",
        status: "OPEN",
        reservedWalletId: usdWallet.id,
        reservedAmount: "49000.00000000",
        source: "agent",
      });
      seededOrderId = order.id;
      await client.query(
        `UPDATE wallets SET reserved = reserved + $1 WHERE id = $2`,
        ["49000.00000000", usdWallet.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await setFlag("AGENT_ACTIONS_ENABLED", { enabled: false });

    // (b) bulk cancel-all is an admin action, not gated by the switch it manages
    const result = await cancelAllOrdersWithOutbox({ source: "agent" });
    expect(result.canceled.map((c) => c.order.id)).toEqual([seededOrderId]);
    expect(result.skipped).toEqual([]);

    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`, [seededOrderId],
    );
    expect(rows[0]!.status).toBe("CANCELED");
  });
});
