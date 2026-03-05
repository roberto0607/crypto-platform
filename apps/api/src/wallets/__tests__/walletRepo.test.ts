import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { ensureMigrations, resetTestData } from "../../testing/resetDb";
import { createTestUser, createTestAssetAndPair } from "../../testing/fixtures";
import {
  createWallet,
  findWalletById,
  listWalletsByUserId,
  creditWallet,
  debitWallet,
  findWalletByUserAndAsset,
  lockWalletsForUpdate,
  reserveFunds,
  releaseReserved,
  creditWalletTx,
  debitAvailableTx,
  consumeReservedAndDebitTx,
} from "../walletRepo";
import { acquireClient } from "../../db/pool";
import { randomUUID } from "node:crypto";

/* ── shared state (re-created each test) ───────────────── */
let userId: string;
let btcAssetId: string;
let usdAssetId: string;

beforeAll(async () => {
  await ensureMigrations();
});

beforeEach(async () => {
  await resetTestData();
  const user = await createTestUser(pool);
  userId = user.id;
  const { btcAsset, usdAsset } = await createTestAssetAndPair(pool);
  btcAssetId = btcAsset.id;
  usdAssetId = usdAsset.id;
});

/* ════════════════════════════════════════════════════════════
   createWallet / findWalletById / listWalletsByUserId
   ════════════════════════════════════════════════════════════ */

describe("createWallet", () => {
  it("creates a wallet with zero balance and reserved", async () => {
    const w = await createWallet(userId, btcAssetId);
    expect(w.user_id).toBe(userId);
    expect(w.asset_id).toBe(btcAssetId);
    expect(w.balance).toBe("0.00000000");
    expect(w.reserved).toBe("0.00000000");
  });

  it("findWalletById returns created wallet", async () => {
    const w = await createWallet(userId, btcAssetId);
    const found = await findWalletById(w.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(w.id);
  });

  it("findWalletById returns null for non-existent id", async () => {
    const found = await findWalletById("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });

  it("listWalletsByUserId returns all user wallets ordered by symbol", async () => {
    await createWallet(userId, usdAssetId); // USD
    await createWallet(userId, btcAssetId); // BTC
    const list = await listWalletsByUserId(userId);
    expect(list).toHaveLength(2);
    // BTC < USD alphabetically
    expect(list[0].symbol).toBe("BTC");
    expect(list[1].symbol).toBe("USD");
  });
});

/* ════════════════════════════════════════════════════════════
   creditWallet
   ════════════════════════════════════════════════════════════ */

describe("creditWallet", () => {
  it("increases balance by exact amount", async () => {
    const w = await createWallet(userId, btcAssetId);
    const { wallet } = await creditWallet(w.id, "1.50000000", "DEPOSIT");
    expect(wallet.balance).toBe("1.50000000");
  });

  it("creates ledger entry with correct type and positive amount", async () => {
    const w = await createWallet(userId, btcAssetId);
    const { ledgerEntryId } = await creditWallet(w.id, "2.00000000", "DEPOSIT", { note: "test" });
    const le = await pool.query(
      `SELECT wallet_id, entry_type, amount::text, balance_after::text, metadata
       FROM ledger_entries WHERE id = $1`,
      [ledgerEntryId],
    );
    expect(le.rows[0].wallet_id).toBe(w.id);
    expect(le.rows[0].entry_type).toBe("DEPOSIT");
    expect(le.rows[0].amount).toBe("2.00000000");
    expect(le.rows[0].balance_after).toBe("2.00000000");
    expect(le.rows[0].metadata).toEqual({ note: "test" });
  });

  it("returns updated wallet and ledger entry ID", async () => {
    const w = await createWallet(userId, btcAssetId);
    const result = await creditWallet(w.id, "5.00000000", "DEPOSIT");
    expect(result.wallet.balance).toBe("5.00000000");
    expect(result.ledgerEntryId).toBeTruthy();
  });

  it("throws when wallet does not exist", async () => {
    await expect(
      creditWallet("00000000-0000-0000-0000-000000000000", "1.00000000", "DEPOSIT"),
    ).rejects.toThrow("wallet_not_found");
  });
});

/* ════════════════════════════════════════════════════════════
   debitWallet
   ════════════════════════════════════════════════════════════ */

describe("debitWallet", () => {
  it("decreases balance by exact amount", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const { wallet } = await debitWallet(w.id, "3.00000000", "WITHDRAWAL");
    expect(wallet.balance).toBe("7.00000000");
  });

  it("rejects when insufficient available balance (balance - reserved < amount)", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    // reserve 8, leaving 2 available
    const client = await acquireClient();
    try {
      await client.query(`UPDATE wallets SET reserved = '8.00000000' WHERE id = $1`, [w.id]);
    } finally {
      client.release();
    }
    await expect(
      debitWallet(w.id, "5.00000000", "WITHDRAWAL"),
    ).rejects.toThrow("insufficient_balance");
  });

  it("allows debit when balance - reserved == amount exactly (boundary)", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    // reserve 7, leaving 3 available
    const client = await acquireClient();
    try {
      await client.query(`UPDATE wallets SET reserved = '7.00000000' WHERE id = $1`, [w.id]);
    } finally {
      client.release();
    }
    const { wallet } = await debitWallet(w.id, "3.00000000", "WITHDRAWAL");
    expect(wallet.balance).toBe("7.00000000");
  });

  it("creates ledger entry with negative amount", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const { ledgerEntryId } = await debitWallet(w.id, "4.00000000", "WITHDRAWAL");
    const le = await pool.query(
      `SELECT amount::text FROM ledger_entries WHERE id = $1`,
      [ledgerEntryId],
    );
    expect(le.rows[0].amount).toBe("-4.00000000");
  });
});

/* ════════════════════════════════════════════════════════════
   reserveFunds / releaseReserved
   ════════════════════════════════════════════════════════════ */

describe("reserveFunds / releaseReserved", () => {
  it("reserveFunds increases reserved column", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "3.00000000");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(`SELECT reserved::text FROM wallets WHERE id = $1`, [w.id]);
    expect(row.rows[0].reserved).toBe("3.00000000");
  });

  it("releaseReserved decreases reserved column", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "5.00000000");
      await releaseReserved(client, w.id, "2.00000000");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(`SELECT reserved::text FROM wallets WHERE id = $1`, [w.id]);
    expect(row.rows[0].reserved).toBe("3.00000000");
  });

  it("available balance (balance - reserved) is correct after reserve", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "4.00000000");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(
      `SELECT balance::text, reserved::text, (balance - reserved)::text AS available FROM wallets WHERE id = $1`,
      [w.id],
    );
    expect(row.rows[0].available).toBe("6.00000000");
  });
});

/* ════════════════════════════════════════════════════════════
   debitAvailableTx
   ════════════════════════════════════════════════════════════ */

describe("debitAvailableTx", () => {
  it("deducts from available balance (balance - reserved)", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "3.00000000");
      await debitAvailableTx(client, w.id, "5.00000000", "TRADE_BUY", randomUUID(), "TRADE");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(`SELECT balance::text, reserved::text FROM wallets WHERE id = $1`, [w.id]);
    expect(row.rows[0].balance).toBe("5.00000000");
    expect(row.rows[0].reserved).toBe("3.00000000"); // reserved unchanged
  });

  it("throws when available < amount", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "8.00000000");
      await expect(
        debitAvailableTx(client, w.id, "5.00000000", "TRADE_BUY"),
      ).rejects.toThrow("insufficient_balance");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("creates ledger entry within caller's transaction", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      const refId = randomUUID();
      await debitAvailableTx(client, w.id, "2.00000000", "TRADE_BUY", refId, "TRADE");
      // Ledger visible within txn
      const le = await client.query(
        `SELECT entry_type, amount::text, reference_id, reference_type FROM ledger_entries
         WHERE wallet_id = $1 AND entry_type = 'TRADE_BUY'`,
        [w.id],
      );
      expect(le.rows).toHaveLength(1);
      expect(le.rows[0].amount).toBe("-2.00000000");
      expect(le.rows[0].reference_id).toBe(refId);
      expect(le.rows[0].reference_type).toBe("TRADE");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   consumeReservedAndDebitTx
   ════════════════════════════════════════════════════════════ */

describe("consumeReservedAndDebitTx", () => {
  it("deducts from both reserved and balance atomically", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "5.00000000");
      await consumeReservedAndDebitTx(client, w.id, "3.00000000", "TRADE_SELL", randomUUID(), "TRADE");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(
      `SELECT balance::text, reserved::text FROM wallets WHERE id = $1`,
      [w.id],
    );
    expect(row.rows[0].balance).toBe("7.00000000");
    expect(row.rows[0].reserved).toBe("2.00000000");
  });

  it("creates ledger entry with negative amount and reference", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "10.00000000", "DEPOSIT");
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await reserveFunds(client, w.id, "5.00000000");
      const refId = randomUUID();
      await consumeReservedAndDebitTx(client, w.id, "2.00000000", "TRADE_SELL", refId, "TRADE");
      const le = await client.query(
        `SELECT amount::text, reference_id FROM ledger_entries
         WHERE wallet_id = $1 AND entry_type = 'TRADE_SELL'`,
        [w.id],
      );
      expect(le.rows[0].amount).toBe("-2.00000000");
      expect(le.rows[0].reference_id).toBe(refId);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   creditWalletTx
   ════════════════════════════════════════════════════════════ */

describe("creditWalletTx", () => {
  it("increases balance within caller's transaction", async () => {
    const w = await createWallet(userId, btcAssetId);
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await creditWalletTx(client, w.id, "5.00000000", "TRADE_BUY", randomUUID(), "TRADE");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const row = await pool.query(`SELECT balance::text FROM wallets WHERE id = $1`, [w.id]);
    expect(row.rows[0].balance).toBe("5.00000000");
  });

  it("creates ledger entry with reference_id and reference_type", async () => {
    const w = await createWallet(userId, btcAssetId);
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      const refId = randomUUID();
      await creditWalletTx(client, w.id, "3.00000000", "TRADE_BUY", refId, "TRADE", { side: "BUY" });
      const le = await client.query(
        `SELECT amount::text, balance_after::text, reference_id, reference_type, metadata
         FROM ledger_entries WHERE wallet_id = $1 AND entry_type = 'TRADE_BUY'`,
        [w.id],
      );
      expect(le.rows[0].amount).toBe("3.00000000");
      expect(le.rows[0].balance_after).toBe("3.00000000");
      expect(le.rows[0].reference_id).toBe(refId);
      expect(le.rows[0].reference_type).toBe("TRADE");
      expect(le.rows[0].metadata).toEqual({ side: "BUY" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   findWalletByUserAndAsset
   ════════════════════════════════════════════════════════════ */

describe("findWalletByUserAndAsset", () => {
  it("returns wallet when exists", async () => {
    const w = await createWallet(userId, btcAssetId);
    const client = await acquireClient();
    try {
      const found = await findWalletByUserAndAsset(client, userId, btcAssetId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(w.id);
    } finally {
      client.release();
    }
  });

  it("returns null when no wallet for user+asset", async () => {
    const client = await acquireClient();
    try {
      const found = await findWalletByUserAndAsset(client, userId, btcAssetId);
      expect(found).toBeNull();
    } finally {
      client.release();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   lockWalletsForUpdate
   ════════════════════════════════════════════════════════════ */

describe("lockWalletsForUpdate", () => {
  it("returns map of wallets keyed by id", async () => {
    const w1 = await createWallet(userId, btcAssetId);
    const w2 = await createWallet(userId, usdAssetId);
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      const map = await lockWalletsForUpdate(client, [w2.id, w1.id]);
      expect(map.size).toBe(2);
      expect(map.get(w1.id)!.asset_id).toBe(btcAssetId);
      expect(map.get(w2.id)!.asset_id).toBe(usdAssetId);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it("locks are released on transaction rollback", async () => {
    const w = await createWallet(userId, btcAssetId);
    const client = await acquireClient();
    try {
      await client.query("BEGIN");
      await lockWalletsForUpdate(client, [w.id]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // If lock wasn't released, this would hang. Verify by re-locking.
    const client2 = await acquireClient();
    try {
      await client2.query("BEGIN");
      const map = await lockWalletsForUpdate(client2, [w.id]);
      expect(map.size).toBe(1);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   decimal precision
   ════════════════════════════════════════════════════════════ */

describe("decimal precision", () => {
  it("0.00000001 credit + 0.00000001 credit = 0.00000002 balance (no float drift)", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "0.00000001", "DEPOSIT");
    await creditWallet(w.id, "0.00000001", "DEPOSIT");
    const found = await findWalletById(w.id);
    expect(found!.balance).toBe("0.00000002");
  });

  it("large credit followed by small debit preserves precision", async () => {
    const w = await createWallet(userId, btcAssetId);
    await creditWallet(w.id, "99999999.99999999", "DEPOSIT");
    const { wallet } = await debitWallet(w.id, "0.00000001", "WITHDRAWAL");
    expect(wallet.balance).toBe("99999999.99999998");
  });
});
