/**
 * matchingEngine integration tests — real PostgreSQL, real transactions.
 *
 * Tests placeOrder() and cancelOrder() directly (not via HTTP routes).
 * Each test resets the database and creates fresh fixtures.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pool } from "../../db/pool";
import { placeOrder, cancelOrder } from "../matchingEngine";
import { resetTestData, ensureMigrations } from "../../testing/resetDb";
import {
  createTestUser,
  createTestAssetAndPair,
  createTestWallets,
} from "../../testing/fixtures";

/* ── query helpers ────────────────────────────────────── */

async function getWallet(id: string) {
  const { rows } = await pool.query<{ balance: string; reserved: string }>(
    `SELECT balance::text, reserved::text FROM wallets WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function getOrder(id: string) {
  const { rows } = await pool.query<{
    status: string;
    qty_filled: string;
    reserved_amount: string;
    reserved_consumed: string;
  }>(
    `SELECT status, qty_filled::text, reserved_amount::text, reserved_consumed::text
     FROM orders WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function getLedger(walletId: string) {
  const { rows } = await pool.query<{
    entry_type: string;
    amount: string;
    balance_after: string;
    reference_id: string;
    reference_type: string;
  }>(
    `SELECT entry_type, amount::text, balance_after::text, reference_id::text, reference_type
     FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at`,
    [walletId],
  );
  return rows;
}

async function getLastPrice(pairId: string) {
  const { rows } = await pool.query<{ last_price: string | null }>(
    `SELECT last_price::text FROM trading_pairs WHERE id = $1`,
    [pairId],
  );
  return rows[0].last_price;
}

async function setFee(pairId: string, bps: number) {
  await pool.query(`UPDATE trading_pairs SET fee_bps = $1 WHERE id = $2`, [bps, pairId]);
}

/* ── shared state (reset each test) ───────────────────── */

let buyer: Awaited<ReturnType<typeof createTestUser>>;
let seller: Awaited<ReturnType<typeof createTestUser>>;
let btcAsset: { id: string; symbol: string };
let usdAsset: { id: string; symbol: string };
let pair: { id: string; symbol: string };
let buyerBtc: { id: string };
let buyerUsd: { id: string };
let sellerBtc: { id: string };
let sellerUsd: { id: string };

beforeAll(async () => {
  await ensureMigrations();
});

beforeEach(async () => {
  await resetTestData();

  buyer = await createTestUser(pool);
  seller = await createTestUser(pool);
  const assets = await createTestAssetAndPair(pool);
  btcAsset = assets.btcAsset;
  usdAsset = assets.usdAsset;
  pair = assets.pair;

  // Buyer: lots of USD, no BTC; Seller: lots of BTC, some USD
  const bw = await createTestWallets(
    pool, buyer.id, btcAsset.id, usdAsset.id,
    "0.00000000", "500000.00000000",
  );
  const sw = await createTestWallets(
    pool, seller.id, btcAsset.id, usdAsset.id,
    "10.00000000", "500000.00000000",
  );
  buyerBtc = bw.btcWallet;
  buyerUsd = bw.usdWallet;
  sellerBtc = sw.btcWallet;
  sellerUsd = sw.usdWallet;
});

/* ══════════════════════════════════════════════════════════
   placeOrder
   ══════════════════════════════════════════════════════════ */

describe("placeOrder", () => {

  /* ── MARKET BUY ─────────────────────────────────────── */

  describe("MARKET BUY", () => {

    it("fills against resting SELL orders (price-time priority)", async () => {
      await setFee(pair.id, 0);
      // Two resting sells at different prices
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "49000.00000000");
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "51000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].price).toBe("49000.00000000"); // cheapest first
      expect(result.fills[0].is_system_fill).toBe(false);
      expect(result.order.status).toBe("FILLED");
    });

    it("partial fill when book has insufficient qty", async () => {
      await setFee(pair.id, 0);
      // Only 0.5 BTC on book
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "0.50000000", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      expect(result.fills).toHaveLength(2);
      expect(result.fills[0].is_system_fill).toBe(false);
      expect(result.fills[0].qty).toBe("0.50000000");
      expect(result.fills[1].is_system_fill).toBe(true);
      expect(result.fills[1].qty).toBe("0.50000000");
      expect(result.order.status).toBe("FILLED");
    });

    it("creates system fill for remaining qty when book exhausted", async () => {
      await setFee(pair.id, 0);
      // Empty book — all system fill at last_price
      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].is_system_fill).toBe(true);
      expect(result.fills[0].price).toBe("50000.00000000"); // last_price from fixture
      expect(result.order.status).toBe("FILLED");
    });

    it("rejects when buyer has insufficient quote balance", async () => {
      await setFee(pair.id, 0);
      // Buyer has 500k USD, need 550k for 11 BTC at 50k
      await expect(
        placeOrder(buyer.id, pair.id, "BUY", "MARKET", "11.00000000"),
      ).rejects.toThrow("insufficient_balance");
    });

    it("updates wallet balances atomically (debit buyer, credit seller)", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      // Buyer: -50000 USD, +1 BTC
      const bUsd = await getWallet(buyerUsd.id);
      expect(bUsd.balance).toBe("450000.00000000");
      const bBtc = await getWallet(buyerBtc.id);
      expect(bBtc.balance).toBe("1.00000000");

      // Seller: +50000 USD, -1 BTC (consumed from reserve)
      const sUsd = await getWallet(sellerUsd.id);
      expect(sUsd.balance).toBe("550000.00000000");
      const sBtc = await getWallet(sellerBtc.id);
      expect(sBtc.balance).toBe("9.00000000");
    });

    it("creates correct ledger entries for each fill", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");
      const tradeId = result.fills[0].id;

      // Buyer USD ledger: debit 50000
      const buyerUsdLedger = await getLedger(buyerUsd.id);
      const buyDebit = buyerUsdLedger.find(
        (e) => e.reference_id === tradeId && e.entry_type === "TRADE_BUY",
      );
      expect(buyDebit).toBeDefined();
      expect(parseFloat(buyDebit!.amount)).toBeLessThan(0);

      // Buyer BTC ledger: credit 1
      const buyerBtcLedger = await getLedger(buyerBtc.id);
      const buyCredit = buyerBtcLedger.find(
        (e) => e.reference_id === tradeId && e.entry_type === "TRADE_BUY",
      );
      expect(buyCredit).toBeDefined();
      expect(buyCredit!.amount).toBe("1.00000000");
    });

    it("updates last_price on trading pair after fill", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "49500.00000000");

      await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      const lastPrice = await getLastPrice(pair.id);
      expect(lastPrice).toBe("49500.00000000");
    });

    it("sets order status to FILLED when fully matched", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "2.00000000", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "2.00000000");

      expect(result.order.status).toBe("FILLED");
      expect(result.order.qty_filled).toBe("2.00000000");
    });
  });

  /* ── MARKET SELL ────────────────────────────────────── */

  describe("MARKET SELL", () => {

    it("fills against resting BUY orders", async () => {
      await setFee(pair.id, 0);
      await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      const result = await placeOrder(seller.id, pair.id, "SELL", "MARKET", "1.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].price).toBe("50000.00000000");
      expect(result.order.status).toBe("FILLED");
    });

    it("rejects when seller has insufficient base balance", async () => {
      await setFee(pair.id, 0);
      // Seller has 10 BTC, try to sell 11
      await expect(
        placeOrder(seller.id, pair.id, "SELL", "MARKET", "11.00000000"),
      ).rejects.toThrow("insufficient_balance");
    });

    it("releases excess reserved funds on maker side after fill", async () => {
      // fee_bps = 30 (default) → reserve includes fee buffer
      // reserve = 1 * 50000 * (10000 + 30) / 10000 = 50150
      await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      const walletBefore = await getWallet(buyerUsd.id);
      expect(parseFloat(walletBefore.reserved)).toBeCloseTo(50150, 4);

      // Seller market sells into it → buyer's LIMIT BUY fully filled
      await placeOrder(seller.id, pair.id, "SELL", "MARKET", "1.00000000");

      // Excess fee buffer (150 USD) should be released
      const walletAfter = await getWallet(buyerUsd.id);
      expect(walletAfter.reserved).toBe("0.00000000");
    });
  });

  /* ── LIMIT BUY ──────────────────────────────────────── */

  describe("LIMIT BUY", () => {

    it("matches immediately if limit price >= best ask", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "49000.00000000");

      // Buyer limit at 50000 >= ask at 49000 → immediate fill at resting price
      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].price).toBe("49000.00000000");
      expect(result.order.status).toBe("FILLED");
    });

    it("rests on book if limit price < best ask", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "51000.00000000");

      // Buyer limit at 50000 < ask at 51000 → no match, rests
      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      expect(result.fills).toHaveLength(0);
      expect(result.order.status).toBe("OPEN");
    });

    it("reserves funds on placement (qty * limitPrice + fees)", async () => {
      // fee_bps = 30 → reserve = 1 * 50000 * (10000 + 30) / 10000 = 50150
      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      const expected = 1 * 50000 * (10000 + 30) / 10000; // 50150
      expect(parseFloat(result.order.reserved_amount)).toBeCloseTo(expected, 4);

      const wallet = await getWallet(buyerUsd.id);
      expect(parseFloat(wallet.reserved)).toBeCloseTo(expected, 4);
    });

    it("partially fills then rests remainder on book", async () => {
      await setFee(pair.id, 0);
      // Only 0.5 BTC available at crossable price
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "0.50000000", "49000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "50000.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].qty).toBe("0.50000000");
      expect(result.order.status).toBe("PARTIALLY_FILLED");
      expect(result.order.qty_filled).toBe("0.50000000");
    });

    it("status is OPEN for unfilled, PARTIALLY_FILLED for partial", async () => {
      await setFee(pair.id, 0);

      // No resting orders → OPEN
      const open = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "45000.00000000");
      expect(open.order.status).toBe("OPEN");

      // Resting sell at 46000 (above buyer's 45000 → no match with existing order)
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "0.30000000", "46000.00000000");

      // New buyer at 46000 matches 0.3 BTC → PARTIALLY_FILLED
      const b2 = await createTestUser(pool);
      await createTestWallets(pool, b2.id, btcAsset.id, usdAsset.id, "0.00000000", "500000.00000000");
      const partial = await placeOrder(b2.id, pair.id, "BUY", "LIMIT", "1.00000000", "46000.00000000");
      expect(partial.order.status).toBe("PARTIALLY_FILLED");
    });
  });

  /* ── LIMIT SELL ─────────────────────────────────────── */

  describe("LIMIT SELL", () => {

    it("matches immediately if limit price <= best bid", async () => {
      await setFee(pair.id, 0);
      await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "51000.00000000");

      // Seller limit at 50000 <= bid at 51000 → immediate fill at resting price
      const result = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].price).toBe("51000.00000000");
      expect(result.order.status).toBe("FILLED");
    });

    it("rests on book if limit price > best bid", async () => {
      await setFee(pair.id, 0);
      await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "1.00000000", "49000.00000000");

      // Seller limit at 50000 > bid at 49000 → rests
      const result = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      expect(result.fills).toHaveLength(0);
      expect(result.order.status).toBe("OPEN");
    });

    it("reserves base qty on placement", async () => {
      const result = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "2.00000000", "50000.00000000");

      expect(result.order.reserved_amount).toBe("2.00000000");
      const wallet = await getWallet(sellerBtc.id);
      expect(wallet.reserved).toBe("2.00000000");
    });
  });

  /* ── multi-fill scenarios ───────────────────────────── */

  describe("multi-fill scenarios", () => {

    it("fills across 3 resting orders at different price levels", async () => {
      await setFee(pair.id, 0);
      // Create 2 additional sellers
      const s2 = await createTestUser(pool);
      const s3 = await createTestUser(pool);
      await createTestWallets(pool, s2.id, btcAsset.id, usdAsset.id, "10.00000000", "0.00000000");
      await createTestWallets(pool, s3.id, btcAsset.id, usdAsset.id, "10.00000000", "0.00000000");

      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "48000.00000000");
      await placeOrder(s2.id, pair.id, "SELL", "LIMIT", "1.00000000", "49000.00000000");
      await placeOrder(s3.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "3.00000000");

      expect(result.fills).toHaveLength(3);
      expect(result.fills[0].price).toBe("48000.00000000");
      expect(result.fills[1].price).toBe("49000.00000000");
      expect(result.fills[2].price).toBe("50000.00000000");
      expect(result.order.status).toBe("FILLED");
    });

    it("correct fee calculation for each fill (taker + maker)", async () => {
      // fee_bps = 30 (default)
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

      const fill = result.fills[0];
      // fee = quoteAmt * fee_bps / 10000 = 50000 * 30 / 10000 = 150
      expect(fill.fee_amount).toBe("150.00000000");
      expect(fill.fee_asset_id).toBe(usdAsset.id);
    });

    it("wallet balances consistent after complex multi-fill", async () => {
      await setFee(pair.id, 0);
      // 2 resting sells at different prices
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "49000.00000000");
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");

      await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "2.00000000");

      // Total cost = 49000 + 50000 = 99000
      const bUsd = await getWallet(buyerUsd.id);
      expect(bUsd.balance).toBe("401000.00000000"); // 500000 - 99000
      const bBtc = await getWallet(buyerBtc.id);
      expect(bBtc.balance).toBe("2.00000000");

      // Seller received 99000 USD, sold 2 BTC
      const sUsd = await getWallet(sellerUsd.id);
      expect(sUsd.balance).toBe("599000.00000000");
      const sBtc = await getWallet(sellerBtc.id);
      expect(sBtc.balance).toBe("8.00000000");
    });
  });

  /* ── decimal precision ──────────────────────────────── */

  describe("decimal precision", () => {

    it("handles 8-decimal qty without precision loss", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "0.00000001", "50000.00000000");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "0.00000001", "50000.00000000");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].qty).toBe("0.00000001");
      expect(result.fills[0].quote_amount).toBe("0.00050000");
    });

    it("handles price * qty multiplication at precision boundary", async () => {
      await setFee(pair.id, 0);
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "0.12345678", "99999.99999999");

      const result = await placeOrder(buyer.id, pair.id, "BUY", "LIMIT", "0.12345678", "99999.99999999");

      expect(result.fills).toHaveLength(1);
      expect(result.fills[0].qty).toBe("0.12345678");
      expect(result.order.status).toBe("FILLED");

      // All wallets remain non-negative
      for (const wId of [buyerBtc.id, buyerUsd.id, sellerBtc.id, sellerUsd.id]) {
        const w = await getWallet(wId);
        expect(parseFloat(w.balance)).toBeGreaterThanOrEqual(0);
        expect(parseFloat(w.reserved)).toBeGreaterThanOrEqual(0);
      }
    });

    it("total debited equals sum of individual fill amounts", async () => {
      await setFee(pair.id, 0);
      // 2 fills at different prices
      const s2 = await createTestUser(pool);
      await createTestWallets(pool, s2.id, btcAsset.id, usdAsset.id, "10.00000000", "0.00000000");

      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "48000.00000000");
      await placeOrder(s2.id, pair.id, "SELL", "LIMIT", "1.00000000", "49000.00000000");

      const before = await getWallet(buyerUsd.id);
      const result = await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "2.00000000");
      const after = await getWallet(buyerUsd.id);

      const totalDebited = parseFloat(before.balance) - parseFloat(after.balance);
      const sumFills = result.fills.reduce(
        (sum, f) => sum + parseFloat(f.quote_amount),
        0,
      );
      expect(totalDebited).toBeCloseTo(sumFills, 8);
    });
  });

  /* ── locking ────────────────────────────────────────── */

  describe("locking", () => {

    it("concurrent orders on same pair execute serially (no deadlock)", async () => {
      await setFee(pair.id, 0);

      // 5 resting sells
      for (let i = 0; i < 5; i++) {
        await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");
      }

      // 5 concurrent buyers
      const buyers = [];
      for (let i = 0; i < 5; i++) {
        const b = await createTestUser(pool);
        await createTestWallets(pool, b.id, btcAsset.id, usdAsset.id, "0.00000000", "100000.00000000");
        buyers.push(b);
      }

      const results = await Promise.all(
        buyers.map((b) => placeOrder(b.id, pair.id, "BUY", "MARKET", "1.00000000")),
      );

      for (const r of results) {
        expect(r.order.status).toBe("FILLED");
      }

      // No negative balances anywhere
      const { rows: bad } = await pool.query(
        `SELECT id FROM wallets WHERE balance < 0 OR reserved < 0`,
      );
      expect(bad).toHaveLength(0);
    });

    it("concurrent orders on different pairs execute in parallel", async () => {
      await setFee(pair.id, 0);

      // Create a second pair (ETH/USD)
      const { rows: ethRows } = await pool.query<{ id: string }>(
        `INSERT INTO assets (symbol, name, decimals) VALUES ('ETH', 'Ethereum', 8) RETURNING id`,
      );
      const ethId = ethRows[0].id;
      const { rows: pair2Rows } = await pool.query<{ id: string }>(
        `INSERT INTO trading_pairs (base_asset_id, quote_asset_id, symbol, is_active, last_price, fee_bps)
         VALUES ($1, $2, 'ETH/USD', true, '3000.00000000', 0) RETURNING id`,
        [ethId, usdAsset.id],
      );
      const pair2Id = pair2Rows[0].id;

      // Users for pair2
      const s2 = await createTestUser(pool);
      const b2 = await createTestUser(pool);
      await createTestWallets(pool, s2.id, ethId, usdAsset.id, "10.00000000", "0.00000000");
      await createTestWallets(pool, b2.id, ethId, usdAsset.id, "0.00000000", "100000.00000000");

      // Resting sells on both pairs
      await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");
      await placeOrder(s2.id, pair2Id, "SELL", "LIMIT", "1.00000000", "3000.00000000");

      // Concurrent buys on different pairs — should not deadlock
      const [r1, r2] = await Promise.all([
        placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000"),
        placeOrder(b2.id, pair2Id, "BUY", "MARKET", "1.00000000"),
      ]);

      expect(r1.order.status).toBe("FILLED");
      expect(r2.order.status).toBe("FILLED");
    });
  });
});

/* ══════════════════════════════════════════════════════════
   cancelOrder
   ══════════════════════════════════════════════════════════ */

describe("cancelOrder", () => {

  it("cancels OPEN order and releases reserved funds", async () => {
    const limitResult = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "2.00000000", "55000.00000000");
    const orderId = limitResult.order.id;

    const walletBefore = await getWallet(sellerBtc.id);
    expect(walletBefore.reserved).toBe("2.00000000");

    const cancelResult = await cancelOrder(seller.id, orderId);

    expect(cancelResult.order.status).toBe("CANCELED");
    expect(cancelResult.releasedAmount).toBe("2.00000000");

    const walletAfter = await getWallet(sellerBtc.id);
    expect(walletAfter.reserved).toBe("0.00000000");
  });

  it("cancels PARTIALLY_FILLED order and releases remaining reserved", async () => {
    await setFee(pair.id, 0);
    // Seller places LIMIT SELL for 2 BTC
    const sellResult = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "2.00000000", "50000.00000000");
    const orderId = sellResult.order.id;

    // Buyer buys 1 BTC → partially fills seller
    await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

    const orderBefore = await getOrder(orderId);
    expect(orderBefore.status).toBe("PARTIALLY_FILLED");

    // Cancel remaining
    const cancelResult = await cancelOrder(seller.id, orderId);
    expect(cancelResult.order.status).toBe("CANCELED");
    expect(cancelResult.releasedAmount).toBe("1.00000000");

    const wallet = await getWallet(sellerBtc.id);
    expect(wallet.reserved).toBe("0.00000000");
  });

  it("rejects cancel of already FILLED order", async () => {
    await setFee(pair.id, 0);
    const sellResult = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "50000.00000000");
    await placeOrder(buyer.id, pair.id, "BUY", "MARKET", "1.00000000");

    await expect(
      cancelOrder(seller.id, sellResult.order.id),
    ).rejects.toThrow("order_not_cancelable");
  });

  it("rejects cancel of already CANCELLED order", async () => {
    const sellResult = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "55000.00000000");
    await cancelOrder(seller.id, sellResult.order.id);

    await expect(
      cancelOrder(seller.id, sellResult.order.id),
    ).rejects.toThrow("order_not_cancelable");
  });

  it("rejects cancel of order owned by different user", async () => {
    const sellResult = await placeOrder(seller.id, pair.id, "SELL", "LIMIT", "1.00000000", "55000.00000000");

    await expect(
      cancelOrder(buyer.id, sellResult.order.id),
    ).rejects.toThrow("forbidden");
  });
});
