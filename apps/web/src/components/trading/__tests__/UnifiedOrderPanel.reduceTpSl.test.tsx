/**
 * TP/SL never ride on an order that only reduces or closes a position (the
 * 2026-11 prod case: SHORT market against a 1x long with "stop loss 76,000"
 * typed in created a BUY stop that the long's card showed as its own).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const http = vi.hoisted(() => ({
  posts: [] as { url: string; body: Record<string, unknown> }[],
  triggers: [] as unknown[],
}));

vi.mock("@/api/client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/api/client")>();
  const fake = {
    get: vi.fn(async (url: string) => {
      if (url.startsWith("/leverage")) {
        return { data: { ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 5, mmrBps: 50, positionLeverage: 1, blockedBy: null, scope: { competitionId: null, matchId: null } } };
      }
      if (url === "/v1/sim/quote") {
        return { data: { executable: true, reason: null, qty: "0.00100000", touchPrice: "70000", estimatedPrice: "70000", slippage_bps: "0", slippageQuote: "0", requestedNotional: "70", feeQuote: "0.03", maxOrderNotional: "5000000" } };
      }
      if (url.includes("trigger")) return { data: { ok: true, data: http.triggers, nextCursor: null } };
      return { data: { ok: true } };
    }),
    post: vi.fn(async (url: string, body: Record<string, unknown>) => {
      http.posts.push({ url, body });
      return { data: { ok: true, order: { id: "o1" }, fills: [{ qty: String(body.qty ?? "0.001"), price: "70000" }] } };
    }),
    patch: vi.fn(), delete: vi.fn(), put: vi.fn(),
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    defaults: { headers: { common: {} } },
  };
  return { ...orig, default: fake };
});

import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { useAppStore } from "@/stores/appStore";
import type { Position, TradingPair, TriggerOrder } from "@/types/api";

const PRICE = 70_000;
const PAIR = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
  max_order_notional: "5000000.00",
} as TradingPair;
const LONG = {
  user_id: "u1", pair_id: "p1", base_qty: "0.01000000", avg_entry_price: "70000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0", unrealized_pnl_quote: "0", current_price: `${PRICE}`,
  updated_at: "2026-11-04T00:00:00Z", margin_mode: "ISOLATED", leverage: "1", isolated_margin: "700", liq_price: "0",
} as unknown as Position;

const settle = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const amount = () => screen.getByPlaceholderText("0.00");
const field = (label: string) => screen.getByText(label).closest(".tr-field")!.querySelector("input") as HTMLInputElement;
const tp = () => field("TAKE PROFIT");
const sl = () => field("STOP LOSS");
const tsl = () => field("TRAILING STOP");
const triggerPosts = () => http.posts.filter((p) => p.url.includes("trigger") || p.url.includes("oco"));

async function mount(position: Position | null = LONG) {
  render(<ToastProvider><UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} /></ToastProvider>);
  await settle();
  return userEvent.setup();
}

beforeEach(() => {
  cleanup();
  http.posts = [];
  http.triggers = [];
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "100000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
      { id: "w-btc", user_id: "u1", asset_id: "a-btc", balance: "0.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: `${PRICE}`, ask: `${PRICE}`, last: `${PRICE}`, ts: "0", source: "live" },
  });
});

describe("an order that reduces the position", () => {
  async function shortAgainstLong(usd: string) {
    const user = await mount();
    await user.click(screen.getByText("SHORT"));
    await user.type(sl(), "76000");
    await user.type(tp(), "60000");
    await user.type(tsl(), "500");
    await user.type(amount(), usd);
    await settle(300);
    return user;
  }

  it("clears and disables TP, SL and trailing, and says why", async () => {
    await shortAgainstLong("70");
    for (const input of [tp(), sl(), tsl()]) {
      expect(input.value).toBe("");
      expect(input.disabled).toBe(true);
    }
    expect(screen.getByTestId("tpsl-reduce-hint").textContent).toMatch(/position card/i);
  });

  it("sends no trigger, only the reduce-only order", async () => {
    const user = await shortAgainstLong("70");
    await user.click(screen.getByRole("button", { name: /REDUCE LONG/i }));
    await settle();
    expect(http.posts.filter((p) => p.url === "/orders")).toHaveLength(1);
    expect(http.posts[0]!.body).toMatchObject({ side: "SELL", reduceOnly: true });
    expect(triggerPosts()).toEqual([]);
  });

  it("a full close too", async () => {
    await shortAgainstLong("700");
    expect(sl().disabled).toBe(true);
  });

  it("a flip opens a new position: typing its size passes through reduce sizes and keeps TP/SL", async () => {
    const user = await shortAgainstLong("2000");
    expect(sl().disabled).toBe(false);
    expect(sl().value).toBe("76000");
    expect(tp().value).toBe("60000");
    expect(screen.queryByTestId("tpsl-reduce-hint")).toBeNull();

    await user.click(document.querySelector(".tr-place-btn") as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "CONFIRM" }));
    await settle();
    expect(triggerPosts().map((p) => p.url)).toEqual(["/v1/oco", "/v1/triggers"]);
  });

  it("an invalid value the fields no longer show can't block the reduce", async () => {
    const user = await mount();
    await user.click(screen.getByText("SHORT"));
    await user.type(sl(), "100");  // below the mark: wrong for a short
    await user.type(amount(), "70");
    await settle(300);
    const submit = document.querySelector(".tr-place-btn") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("back to an add: the fields work again", async () => {
    const user = await shortAgainstLong("70");
    await user.click(screen.getByText("LONG", { selector: ".tr-dir-btn" }));
    await settle();
    expect(sl().disabled).toBe(false);
    expect(screen.queryByTestId("tpsl-reduce-hint")).toBeNull();
  });
});

describe("orders that open or add keep TP/SL", () => {
  it("adding to the long sets a SELL stop", async () => {
    const user = await mount();
    await user.type(sl(), "65000");
    await user.type(amount(), "70");
    await settle(300);
    await user.click(screen.getByRole("button", { name: /ADD TO LONG/i }));
    await settle();
    expect(triggerPosts()).toHaveLength(1);
    expect(triggerPosts()[0]!.body).toMatchObject({ kind: "STOP_MARKET", side: "SELL", triggerPrice: "65000" });
    // The server sizes it to the whole position.
    expect(triggerPosts()[0]!.body).not.toHaveProperty("qty");
  });
});

describe("the position card", () => {
  const stop = (side: "BUY" | "SELL", trigger_price: string) => ({
    id: `t-${side}`, pair_id: "p1", kind: "STOP_MARKET", side, trigger_price, qty: "0.002643", status: "ACTIVE",
  } as unknown as TriggerOrder);

  it("a long doesn't claim a BUY stop as its own", async () => {
    http.triggers = [stop("BUY", "76000")];
    useTradingStore.setState({ activeTriggers: http.triggers as TriggerOrder[] });
    await mount();
    expect(screen.queryByText(/\$76,000/)).toBeNull();
  });

  it("a long shows its SELL stop", async () => {
    http.triggers = [stop("SELL", "65000")];
    useTradingStore.setState({ activeTriggers: http.triggers as TriggerOrder[] });
    await mount();
    expect(screen.getAllByText(/\$65,000/).length).toBeGreaterThan(0);
  });
});
