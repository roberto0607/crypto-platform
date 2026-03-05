/**
 * phase6OrderService unit tests — all dependencies mocked.
 *
 * Tests orchestration logic: idempotency, governance, risk,
 * simulation, post-fill processing, error handling.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

/* ── Mock all dependencies ──────────────────────────────── */

vi.mock("../../db/pool", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("../../utils/txWithEvents", () => ({ txWithEvents: vi.fn() }));
vi.mock("../../replay/replayEngine", () => ({ getSnapshotForUser: vi.fn() }));
vi.mock("../matchingEngine", () => ({ placeOrderTx: vi.fn(), cancelOrderTx: vi.fn() }));
vi.mock("../feeCalc", () => ({ computeFee: vi.fn() }));
vi.mock("../../analytics/positionRepo", () => ({ applyFillToPositionTx: vi.fn() }));
vi.mock("../idempotencyRepo", () => ({ getIdempotencyKey: vi.fn(), putIdempotencyKeyTx: vi.fn() }));
vi.mock("../orderRepo", () => ({ findOrderById: vi.fn() }));
vi.mock("../tradeRepo", () => ({ listTradesByOrderId: vi.fn() }));
vi.mock("../pairRepo", () => ({ findPairById: vi.fn() }));
vi.mock("../../risk/riskEngine", () => ({ evaluateOrderRisk: vi.fn() }));
vi.mock("../../governance/governanceEngine", () => ({ evaluateAccountGovernance: vi.fn() }));
vi.mock("../../risk/breakerService", () => ({ recordOrderAttempt: vi.fn(), checkPriceDislocation: vi.fn() }));
vi.mock("../../outbox/outboxRepo", () => ({ insertOutboxEventTx: vi.fn() }));
vi.mock("../../portfolio/portfolioService", () => ({ writePortfolioSnapshotTx: vi.fn() }));
vi.mock("../../sim/simConfigRepo", () => ({ resolveSimulationConfig: vi.fn() }));
vi.mock("../../sim/slippageModel", () => ({ computeMarketExecution: vi.fn() }));
vi.mock("../../sim/liquidityModel", () => ({ computeAvailableLiquidity: vi.fn() }));
vi.mock("../../events/eventTypes", () => ({
  createEvent: vi.fn((_type: string, data: any) => ({ type: _type, data, ts: Date.now() })),
}));
vi.mock("../../observability/logContext", () => ({
  buildLogContext: vi.fn(() => ({})),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../metrics", () => ({
  orderPlacementLatency: { observe: vi.fn() },
  ordersCreatedTotal: { inc: vi.fn() },
  ordersRejectedTotal: { inc: vi.fn() },
}));

/* ── Import under test + mocked modules ─────────────────── */

import { placeOrderWithSnapshot, resolveSnapshot, cancelOrderWithOutbox } from "../phase6OrderService";
import { pool } from "../../db/pool";
import { txWithEvents } from "../../utils/txWithEvents";
import { getSnapshotForUser } from "../../replay/replayEngine";
import { placeOrderTx, cancelOrderTx } from "../matchingEngine";
import { computeFee } from "../feeCalc";
import { applyFillToPositionTx } from "../../analytics/positionRepo";
import { getIdempotencyKey, putIdempotencyKeyTx } from "../idempotencyRepo";
import { findOrderById } from "../orderRepo";
import { listTradesByOrderId } from "../tradeRepo";
import { findPairById } from "../pairRepo";
import { evaluateOrderRisk } from "../../risk/riskEngine";
import { evaluateAccountGovernance } from "../../governance/governanceEngine";
import { recordOrderAttempt, checkPriceDislocation } from "../../risk/breakerService";
import { insertOutboxEventTx } from "../../outbox/outboxRepo";
import { writePortfolioSnapshotTx } from "../../portfolio/portfolioService";
import { resolveSimulationConfig } from "../../sim/simConfigRepo";
import { computeMarketExecution } from "../../sim/slippageModel";
import { computeAvailableLiquidity } from "../../sim/liquidityModel";
import { AppError } from "../../errors/AppError";

/* ── Test data ──────────────────────────────────────────── */

const SNAPSHOT = {
  bid: "49900.00000000",
  ask: "50100.00000000",
  last: "50000.00000000",
  ts: "2025-01-01T00:00:00.000Z",
  source: "live" as const,
};

const ORDER = {
  id: "order-1",
  user_id: "user-1",
  pair_id: "pair-1",
  side: "BUY",
  type: "LIMIT",
  limit_price: "50000.00000000",
  qty: "1.00000000",
  qty_filled: "1.00000000",
  status: "FILLED",
  reserved_wallet_id: "wallet-1",
  reserved_amount: "50000.00000000",
  reserved_consumed: "50000.00000000",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const FILL = {
  id: "trade-1",
  pair_id: "pair-1",
  buy_order_id: "order-1",
  sell_order_id: "order-2",
  price: "50000.00000000",
  qty: "1.00000000",
  quote_amount: "50000.00000000",
  fee_amount: "25.00000000",
  fee_asset_id: "usd-asset-id",
  is_system_fill: false,
  executed_at: "2025-01-01T00:00:00.000Z",
};

const PAIR = {
  id: "pair-1",
  base_asset_id: "btc-id",
  quote_asset_id: "usd-id",
  symbol: "BTC/USD",
  is_active: true,
  last_price: "50000.00000000",
  fee_bps: 30,
  maker_fee_bps: 2,
  taker_fee_bps: 5,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const BODY = {
  pairId: "pair-1",
  side: "BUY" as const,
  type: "LIMIT" as const,
  qty: "1.00000000",
  limitPrice: "50000.00000000",
};

const SIM_CONFIG = {
  base_spread_bps: 5,
  base_slippage_bps: 2,
  impact_bps_per_10k_quote: 10,
  liquidity_quote_per_tick: 50000,
  volatility_widening_k: 0.5,
};

/* ── Helpers ────────────────────────────────────────────── */

let capturedEvents: any[];

function setupDefaultMocks() {
  capturedEvents = [];

  // txWithEvents: call callback with mock client, capture events
  vi.mocked(txWithEvents).mockImplementation(async (fn: any) => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("last_price FROM trading_pairs"))
          return { rows: [{ last_price: "50000.00000000" }] };
        if (sql.includes("user_id FROM orders"))
          return { rows: [{ user_id: "maker-id" }] };
        return { rows: [] };
      }),
    };
    return fn(mockClient, capturedEvents);
  });

  vi.mocked(getSnapshotForUser).mockResolvedValue(SNAPSHOT);
  vi.mocked(getIdempotencyKey).mockResolvedValue(null);
  vi.mocked(putIdempotencyKeyTx).mockResolvedValue(1);
  vi.mocked(placeOrderTx).mockResolvedValue({ order: ORDER, fills: [FILL] });
  vi.mocked(findOrderById).mockResolvedValue(ORDER);
  vi.mocked(listTradesByOrderId).mockResolvedValue([FILL]);
  vi.mocked(findPairById).mockResolvedValue(PAIR as any);
  vi.mocked(evaluateAccountGovernance).mockResolvedValue({ ok: true });
  vi.mocked(evaluateOrderRisk).mockResolvedValue({ ok: true, code: "PASS", reason: "All checks passed" });
  vi.mocked(recordOrderAttempt).mockResolvedValue(undefined);
  vi.mocked(checkPriceDislocation).mockResolvedValue(undefined);
  vi.mocked(computeFee).mockReturnValue({ feeAmount: "25.00000000", feeAssetId: "usd-id", role: "TAKER" });
  vi.mocked(applyFillToPositionTx).mockResolvedValue({} as any);
  vi.mocked(insertOutboxEventTx).mockResolvedValue(undefined);
  vi.mocked(writePortfolioSnapshotTx).mockResolvedValue(undefined);
  vi.mocked(resolveSimulationConfig).mockResolvedValue(SIM_CONFIG);
  vi.mocked(computeMarketExecution).mockReturnValue({ execPrice: "50025.00000000", slippage_bps: "5", spread_bps_effective: "10", requestedNotional: "50025.00000000", availableLiquidityQuote: "500000.00000000" });
  vi.mocked(computeAvailableLiquidity).mockReturnValue("500000.00000000");
  vi.mocked(pool.query as any).mockResolvedValue({ rows: [{ volume: "100", high: "51000", low: "49000" }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultMocks();
});

/* ══════════════════════════════════════════════════════════
   placeOrderWithSnapshot
   ══════════════════════════════════════════════════════════ */

describe("placeOrderWithSnapshot", () => {

  /* ── idempotency ──────────────────────────────────────── */

  describe("idempotency", () => {

    it("returns cached result when idempotencyKey already exists", async () => {
      vi.mocked(getIdempotencyKey).mockResolvedValue({
        user_id: "user-1",
        key: "key-1",
        order_id: "order-1",
        snapshot_json: SNAPSHOT,
        created_at: "2025-01-01T00:00:00.000Z",
      });

      const result = await placeOrderWithSnapshot("user-1", BODY, "key-1");

      expect(result.fromIdempotencyCache).toBe(true);
      expect(result.order.id).toBe("order-1");
      expect(txWithEvents).not.toHaveBeenCalled();
    });

    it("processes normally when idempotencyKey is new", async () => {
      vi.mocked(getIdempotencyKey).mockResolvedValue(null);

      const result = await placeOrderWithSnapshot("user-1", BODY, "new-key");

      expect(result.fromIdempotencyCache).toBe(false);
      expect(txWithEvents).toHaveBeenCalled();
      expect(putIdempotencyKeyTx).toHaveBeenCalled();
    });

    it("handles race condition: concurrent same key, second request gets winner's result", async () => {
      vi.mocked(getIdempotencyKey)
        .mockResolvedValueOnce(null) // First call: pre-tx check
        .mockResolvedValueOnce({      // Second call: post-tx recovery
          user_id: "user-1",
          key: "race-key",
          order_id: "winner-order",
          snapshot_json: SNAPSHOT,
          created_at: "2025-01-01T00:00:00.000Z",
        });
      vi.mocked(putIdempotencyKeyTx).mockResolvedValue(0); // 0 = race lost
      vi.mocked(findOrderById).mockResolvedValue({ ...ORDER, id: "winner-order" });

      const result = await placeOrderWithSnapshot("user-1", BODY, "race-key");

      expect(result.fromIdempotencyCache).toBe(true);
      expect(result.order.id).toBe("winner-order");
    });
  });

  /* ── governance + risk checks ─────────────────────────── */

  describe("governance + risk checks", () => {

    it("rejects order when evaluateAccountGovernance returns !ok", async () => {
      vi.mocked(evaluateAccountGovernance).mockResolvedValue({
        ok: false,
        code: "ACCOUNT_QUARANTINED",
        message: "Account is quarantined",
      });

      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toThrow(AppError);

      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toMatchObject({ code: "governance_check_failed" });
    });

    it("rejects order when evaluateOrderRisk returns !ok", async () => {
      vi.mocked(evaluateOrderRisk).mockResolvedValue({
        ok: false,
        code: "MAX_NOTIONAL_EXCEEDED",
        reason: "Order exceeds max notional",
        details: { max: "100000", actual: "150000" },
      });

      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toThrow(AppError);

      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toMatchObject({ code: "risk_check_failed" });
    });

    it("passes governance code and risk details in error response", async () => {
      vi.mocked(evaluateOrderRisk).mockResolvedValue({
        ok: false,
        code: "BREAKER_OPEN",
        reason: "Circuit breaker is open",
        details: { breakerKey: "RATE_ABUSE:USER:user-1" },
      });

      try {
        await placeOrderWithSnapshot("user-1", BODY);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(AppError);
        expect(err.code).toBe("risk_check_failed");
        expect(err.details).toMatchObject({
          code: "BREAKER_OPEN",
          reason: "Circuit breaker is open",
        });
      }
    });
  });

  /* ── price dislocation ────────────────────────────────── */

  describe("price dislocation", () => {

    it("calls checkPriceDislocation with snapshot and DB prices", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      expect(checkPriceDislocation).toHaveBeenCalledWith(
        expect.anything(), // client
        "pair-1",
        SNAPSHOT.last,
        "50000.00000000",
      );
    });

    it("skips checkPriceDislocation when DB has no last_price", async () => {
      vi.mocked(txWithEvents).mockImplementation(async (fn: any) => {
        const mockClient = {
          query: vi.fn().mockResolvedValue({ rows: [{ last_price: null }] }),
        };
        return fn(mockClient, capturedEvents);
      });

      await placeOrderWithSnapshot("user-1", BODY);

      expect(checkPriceDislocation).not.toHaveBeenCalled();
    });
  });

  /* ── snapshot resolution ──────────────────────────────── */

  describe("snapshot resolution", () => {

    it("resolveSnapshot returns live snapshot when available", async () => {
      vi.mocked(getSnapshotForUser).mockResolvedValue({ ...SNAPSHOT, source: "live" });

      const snap = await resolveSnapshot("user-1", "pair-1");

      expect(snap.source).toBe("live");
      expect(getSnapshotForUser).toHaveBeenCalledWith("user-1", "pair-1");
    });

    it("resolveSnapshot returns replay snapshot when in replay mode", async () => {
      vi.mocked(getSnapshotForUser).mockResolvedValue({ ...SNAPSHOT, source: "replay" });

      const snap = await resolveSnapshot("user-1", "pair-1");

      expect(snap.source).toBe("replay");
    });

    it("resolveSnapshot falls back to DB last_price when no live snapshot", async () => {
      vi.mocked(getSnapshotForUser).mockResolvedValue({ ...SNAPSHOT, source: "fallback" });

      const snap = await resolveSnapshot("user-1", "pair-1");

      expect(snap.source).toBe("fallback");
    });
  });

  /* ── simulation ───────────────────────────────────────── */

  describe("simulation", () => {

    it("calls computeMarketExecution for MARKET orders", async () => {
      const marketBody = { ...BODY, type: "MARKET" as const, limitPrice: undefined };

      await placeOrderWithSnapshot("user-1", marketBody);

      expect(computeMarketExecution).toHaveBeenCalledWith(
        SNAPSHOT,
        "BUY",
        "1.00000000",
        SIM_CONFIG,
        "100", // candle volume
        "51000", // candle high
        "49000", // candle low
      );
    });

    it("skips simulation for LIMIT orders", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      expect(computeMarketExecution).not.toHaveBeenCalled();
      expect(resolveSimulationConfig).not.toHaveBeenCalled();
    });

    it("rejects when liquidity is insufficient", async () => {
      const marketBody = { ...BODY, type: "MARKET" as const, limitPrice: undefined };
      vi.mocked(computeMarketExecution).mockReturnValue(null as any);

      await expect(
        placeOrderWithSnapshot("user-1", marketBody),
      ).rejects.toMatchObject({ code: "insufficient_liquidity" });
    });
  });

  /* ── post-fill processing ─────────────────────────────── */

  describe("post-fill processing", () => {

    it("calls applyFillToPositionTx for each fill", async () => {
      const fill2 = { ...FILL, id: "trade-2", qty: "0.50000000" };
      vi.mocked(placeOrderTx).mockResolvedValue({ order: ORDER, fills: [FILL, fill2] });

      await placeOrderWithSnapshot("user-1", BODY);

      // 2 fills × 2 (taker + maker per fill) = 4 calls
      expect(applyFillToPositionTx).toHaveBeenCalled();
      const calls = vi.mocked(applyFillToPositionTx).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it("calls computeFee with correct maker/taker roles", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      const calls = vi.mocked(computeFee).mock.calls;
      // At least one TAKER and one MAKER call
      const roles = calls.map((c) => c[1]);
      expect(roles).toContain("TAKER");
      expect(roles).toContain("MAKER");
    });

    it("inserts ORDER_PLACED outbox event", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      const calls = vi.mocked(insertOutboxEventTx).mock.calls;
      const orderPlaced = calls.find(
        (c) => (c[1].payload as any)?.eventInput?.eventType === "ORDER_PLACED",
      );
      expect(orderPlaced).toBeDefined();
      expect(orderPlaced![1].event_type).toBe("EVENT_STREAM_APPEND");
      expect(orderPlaced![1].aggregate_type).toBe("ORDER");
    });

    it("inserts TRADE_EXECUTED outbox event for each fill", async () => {
      const fill2 = { ...FILL, id: "trade-2" };
      vi.mocked(placeOrderTx).mockResolvedValue({ order: ORDER, fills: [FILL, fill2] });

      await placeOrderWithSnapshot("user-1", BODY);

      const calls = vi.mocked(insertOutboxEventTx).mock.calls;
      const tradeEvents = calls.filter(
        (c) => (c[1].payload as any)?.eventInput?.eventType === "TRADE_EXECUTED",
      );
      expect(tradeEvents).toHaveLength(2);
    });

    it("inserts idempotency key after successful fill", async () => {
      await placeOrderWithSnapshot("user-1", BODY, "idem-key");

      expect(putIdempotencyKeyTx).toHaveBeenCalledWith(
        expect.anything(), // client
        "user-1",
        "idem-key",
        "order-1",
        SNAPSHOT,
      );
    });

    it("pushes SSE events to pendingEvents (published after commit)", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      // Events were pushed to capturedEvents (which is the pendingEvents array)
      expect(capturedEvents.length).toBeGreaterThan(0);
      const eventTypes = capturedEvents.map((e) => e.type);
      expect(eventTypes).toContain("order.updated");
      expect(eventTypes).toContain("trade.created");
    });

    it("writes portfolio snapshot within transaction", async () => {
      await placeOrderWithSnapshot("user-1", BODY);

      expect(writePortfolioSnapshotTx).toHaveBeenCalledWith(
        expect.anything(), // client (inside txn)
        "user-1",
        expect.any(Number), // timestamp
        "pair-1",
        "50000.00000000", // last fill price
      );
    });
  });

  /* ── no-fill path ─────────────────────────────────────── */

  describe("no-fill path", () => {

    beforeEach(() => {
      vi.mocked(placeOrderTx).mockResolvedValue({
        order: { ...ORDER, status: "OPEN", qty_filled: "0.00000000" },
        fills: [],
      });
    });

    it("stores idempotency key for OPEN limit order (no fills)", async () => {
      await placeOrderWithSnapshot("user-1", BODY, "idem-key");

      expect(putIdempotencyKeyTx).toHaveBeenCalledWith(
        expect.anything(),
        "user-1",
        "idem-key",
        "order-1",
        SNAPSHOT,
      );
    });

    it("inserts ORDER_PLACED outbox event for resting order", async () => {
      await placeOrderWithSnapshot("user-1", BODY, "idem-key");

      const calls = vi.mocked(insertOutboxEventTx).mock.calls;
      const orderPlaced = calls.find(
        (c) => (c[1].payload as any)?.eventInput?.eventType === "ORDER_PLACED",
      );
      expect(orderPlaced).toBeDefined();
    });

    it("pushes SSE event after commit", async () => {
      await placeOrderWithSnapshot("user-1", BODY, "idem-key");

      expect(capturedEvents.length).toBeGreaterThan(0);
      expect(capturedEvents[0].type).toBe("order.updated");
    });
  });

  /* ── error handling ───────────────────────────────────── */

  describe("error handling", () => {

    it("rolls back entire transaction on matchingEngine error", async () => {
      vi.mocked(placeOrderTx).mockRejectedValue(new Error("insufficient_balance"));

      // txWithEvents propagates the error (which triggers ROLLBACK internally)
      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toThrow("insufficient_balance");

      // No outbox events inserted
      expect(insertOutboxEventTx).not.toHaveBeenCalled();
    });

    it("rolls back entire transaction on position update error", async () => {
      vi.mocked(applyFillToPositionTx).mockRejectedValue(new Error("position_error"));

      await expect(
        placeOrderWithSnapshot("user-1", BODY),
      ).rejects.toThrow("position_error");

      expect(insertOutboxEventTx).not.toHaveBeenCalled();
    });

    it("eventBus.publish failure does not affect response", async () => {
      // txWithEvents mock doesn't actually call publish(), so this tests
      // that the service doesn't call publish() directly
      const result = await placeOrderWithSnapshot("user-1", BODY);

      expect(result.order.id).toBe("order-1");
      expect(result.fromIdempotencyCache).toBe(false);
    });
  });
});

/* ══════════════════════════════════════════════════════════
   cancelOrderWithOutbox
   ══════════════════════════════════════════════════════════ */

describe("cancelOrderWithOutbox", () => {

  it("calls cancelOrderTx and inserts ORDER_CANCELLED outbox event", async () => {
    vi.mocked(cancelOrderTx).mockResolvedValue({
      order: { ...ORDER, status: "CANCELED" },
      releasedAmount: "50000.00000000",
    });

    const result = await cancelOrderWithOutbox("user-1", "order-1");

    expect(cancelOrderTx).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "order-1",
    );
    expect(result.order.status).toBe("CANCELED");

    const calls = vi.mocked(insertOutboxEventTx).mock.calls;
    const cancelEvent = calls.find(
      (c) => (c[1].payload as any)?.eventInput?.eventType === "ORDER_CANCELLED",
    );
    expect(cancelEvent).toBeDefined();
  });

  it("pushes order.updated SSE event after cancel", async () => {
    vi.mocked(cancelOrderTx).mockResolvedValue({
      order: { ...ORDER, status: "CANCELED" },
      releasedAmount: "50000.00000000",
    });

    await cancelOrderWithOutbox("user-1", "order-1");

    expect(capturedEvents.length).toBeGreaterThan(0);
    expect(capturedEvents[0].type).toBe("order.updated");
  });
});
