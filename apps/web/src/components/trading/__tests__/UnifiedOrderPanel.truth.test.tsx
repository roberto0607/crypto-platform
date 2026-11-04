/**
 * Order panel truth (audit PR 2b). The numbers come from GET /v1/sim/quote
 * (mocked at the HTTP client): preview, presets, then the server's errors,
 * the reduce / close / flip labels, liq "None", keyboard chips, and CLOSE
 * living outside the scrolled card.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type Params = Record<string, string | number | boolean | undefined>;
const http = vi.hoisted(() => ({
  leverage: null as null | Record<string, unknown>,
  quote: null as null | ((p: Params) => unknown),
  quotes: [] as { params: Params; signal?: AbortSignal }[],
  post: null as null | ((body: Record<string, string>) => unknown),
  orders: [] as Record<string, string>[],
}));

vi.mock("@/api/client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/api/client")>();
  const fake = {
    get: vi.fn(async (url: string, cfg?: { params?: Params; signal?: AbortSignal }) => {
      if (url.startsWith("/leverage")) return { data: http.leverage };
      if (url === "/v1/sim/quote") {
        http.quotes.push({ params: cfg!.params!, signal: cfg!.signal });
        return { data: http.quote!(cfg!.params!) };
      }
      if (url.includes("trigger")) return { data: { ok: true, data: [], nextCursor: null } };
      return { data: { ok: true } };
    }),
    post: vi.fn(async (url: string, body: Record<string, string>) => {
      if (url === "/orders") {
        http.orders.push(body);
        http.post?.(body);
      }
      return { data: { ok: true, order: { id: "o1" }, fills: [] } };
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
import type { Position, TradingPair } from "@/types/api";

const PRICE = 100_000;
const PAIR = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
  max_order_notional: "5000000.00",
} as TradingPair;
const LEV = { ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 10, mmrBps: 50, positionLeverage: null, blockedBy: null, scope: { competitionId: null, matchId: null } };
const SPOT = { ...LEV, enabled: false, marginMode: "SPOT", cap: 1 };

/** A book where the average fill sits 0.5% over the touch, whatever the size. */
const SLIP = 1.005;
const quoteFor = (p: Params) => {
  const budget = p.budget !== undefined ? Number(p.budget) : null;
  const lev = Number(p.leverage ?? 1);
  const qty = budget !== null ? (budget * 0.9975) / (PRICE * SLIP) / (1 / lev + 0.0005) : Number(p.qty);
  const notional = qty * PRICE * SLIP;
  return {
    executable: true, reason: null, qty: qty.toFixed(8), touchPrice: `${PRICE}.00000000`,
    estimatedPrice: (PRICE * SLIP).toFixed(8), slippage_bps: "50.00000000",
    slippageQuote: (notional - qty * PRICE).toFixed(8), requestedNotional: notional.toFixed(8),
    feeQuote: (notional * 0.0005).toFixed(8), maxOrderNotional: "5000000.00",
  };
};

const settle = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const debounced = () => settle(300);

function mount(position: Position | null = null) {
  return render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
}

const row = (label: string) => screen.getByText(label).closest("[class*=sum-row]")!.lastElementChild!;
const amount = () => screen.getByPlaceholderText("0.00");
const isoPosition = (qty: string, over: Partial<Position> = {}): Position => ({
  user_id: "u1", pair_id: "p1", base_qty: qty, avg_entry_price: "100000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0", unrealized_pnl_quote: "0", current_price: `${PRICE}`,
  updated_at: "2026-11-04T00:00:00Z", margin_mode: "ISOLATED", leverage: "5", isolated_margin: "2000",
  liq_price: "80500", ...over,
} as Position);

beforeEach(() => {
  cleanup();
  http.leverage = LEV;
  http.quote = quoteFor;
  http.quotes = [];
  http.post = null;
  http.orders = [];
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

describe("preview", () => {
  async function tenX() {
    const user = userEvent.setup();
    mount();
    await settle();
    await user.click(screen.getByRole("radio", { name: "10x leverage" }));
    return user;
  }

  it("matches the quote: est. fill, slippage, notional, fee, liq from the est. fill", async () => {
    const user = await tenX();
    await user.type(amount(), "100000");
    await debounced();
    expect(row("EST. FILL").textContent).toBe("$100,500.00");
    expect(row("SLIPPAGE").textContent).toBe("0.50% · $5,000.00");
    expect(row("NOTIONAL").textContent).toBe("$1,005,000.00");
    expect(row("FEE (5 bps)").textContent).toBe("$502.50");
    // entry 100,500 at 10x, 0.5% maintenance: 100,500 × (1 − 0.1) / (1 − 0.005) ≈ 90,904.52
    expect(screen.getByTestId("est-liq").textContent).toBe("$90,904.52");
  });

  it("quotes once per pause, and cancels the one a newer edit replaces", async () => {
    const user = await tenX();
    const quoted = () => http.quotes.filter((q) => q.params.qty !== undefined);
    await user.type(amount(), "1000");
    await debounced();
    expect(quoted()).toHaveLength(1);
    expect(quoted()[0]!.params).toMatchObject({ pairId: "p1", side: "BUY" });
    await user.type(amount(), "0");
    await debounced();
    expect(quoted()).toHaveLength(2);
    expect(quoted()[0]!.signal?.aborted).toBe(true);
  });

  it("keeps the last value dimmed while loading", async () => {
    const user = await tenX();
    await user.type(amount(), "1000");
    await debounced();
    await user.type(amount(), "0");
    const val = row("EST. FILL") as HTMLElement;
    expect(val.textContent).toBe("$100,500.00");
    expect(val.style.opacity).toBe("0.45");
    await debounced();
    expect((row("EST. FILL") as HTMLElement).style.opacity).toBe("");
  });

  it("on a quote error shows — and no stale number", async () => {
    const user = await tenX();
    await user.type(amount(), "1000");
    await debounced();
    http.quote = () => { throw new Error("down"); };
    await user.type(amount(), "0");
    await debounced();
    for (const label of ["EST. FILL", "SLIPPAGE", "NOTIONAL", "FEE (5 bps)"]) expect(row(label).textContent).toBe("—");
    expect(screen.getByTestId("est-liq").textContent).toBe("—");
  });

  it("an order the quote won't fill says why, before it's sent", async () => {
    const user = await tenX();
    http.quote = (p) => ({ ...quoteFor(p), executable: false, reason: "order_too_large" });
    await user.type(amount(), "900000");
    await debounced();
    expect(row("EST. FILL").textContent).toBe("—");
    expect(screen.getByTestId("quote-hint").textContent).toBe("Max order $5,000,000 on BTC");
  });

  it("leverage off: previews too, and the order body stays amount / price", async () => {
    http.leverage = SPOT;
    const user = userEvent.setup();
    mount();
    await settle();
    await user.type(amount(), "1000");
    await debounced();
    expect(row("EST. FILL").textContent).toBe("$100,500.00");
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    await settle();
    expect(http.orders[0]).toEqual({ pairId: "p1", side: "BUY", type: "MARKET", qty: "0.01000000" });
  });
});

describe("25 / 50 / 75 / MAX", () => {
  const chip = (name: RegExp) => screen.getByRole("button", { name });

  it("each chip shows the notional it would place, from the budget solve", async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await user.click(screen.getByRole("radio", { name: "10x leverage" }));
    await debounced();
    expect(chip(/^MAX/).textContent).toBe("MAX · $993k");
    expect(chip(/^25%/).textContent).toBe("25% · $248k");
    const max = http.quotes.at(-1)!.params;
    expect(max).toMatchObject({ pairId: "p1", side: "BUY", leverage: 10 });
    expect(Number(max.budget)).toBeLessThanOrEqual(100_000);
  });

  it("MAX is never rejected: the order carries the budget-solved qty, re-solved at submit", async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await user.click(screen.getByRole("radio", { name: "10x leverage" }));
    await debounced();
    await user.click(chip(/^MAX/));
    await debounced();
    // The server's rule: margin + fee at the fill must fit the free balance.
    http.post = (b) => {
      const n = Number(b.qty) * PRICE * SLIP;
      if (n / 10 + n * 0.0005 > 100_000) {
        throw Object.assign(new Error("x"), { response: { status: 400, data: { ok: false, error: "insufficient_balance" } } });
      }
    };
    // The book moves before the click: the solve at submit follows it.
    http.quote = (p) => ({ ...quoteFor(p), qty: "0.90000000" });
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    await settle();
    expect(http.orders.at(-1)).toMatchObject({ qty: "0.90000000", leverage: 10 });
    expect(screen.queryByTestId("order-error")).toBeNull();
  });

  it("clamps to the pair's max order on a LIMIT too, where no quote applies", async () => {
    useAppStore.setState({
      wallets: [{ id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "9000000.00000000", reserved: "0", created_at: "", updated_at: "" }],
    });
    const user = userEvent.setup();
    mount();
    await settle();
    await user.click(screen.getByRole("radio", { name: "10x leverage" }));
    await user.click(screen.getByText("LIMIT"));
    await debounced();
    expect(chip(/^MAX/).textContent).toBe("MAX · $5.00M");
    await user.click(chip(/^MAX/));
    await settle();
    expect((amount() as HTMLInputElement).value).toBe("500000");
  });

  it("a balance that moves with every tick doesn't re-quote the chips", async () => {
    mount();
    await settle();
    await debounced();
    const before = http.quotes.length;
    for (const balance of ["100010", "100020", "100030"]) {
      act(() => {
        useAppStore.setState({ wallets: [{ id: "w-usd", user_id: "u1", asset_id: "a-usd", balance, reserved: "0", created_at: "", updated_at: "" }] });
      });
      await debounced();
    }
    expect(http.quotes.length).toBe(before);
  });

  it("editing the amount drops the solved qty", async () => {
    http.leverage = SPOT;
    const user = userEvent.setup();
    mount();
    await settle();
    await debounced();
    await user.click(chip(/^MAX/));
    await settle();
    await user.clear(amount());
    await user.type(amount(), "1000");
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    await settle();
    expect(http.orders.at(-1)!.qty).toBe("0.01000000");
  });
});

describe("errors", () => {
  const reject = (status: number, data: unknown) => () => { throw Object.assign(new Error("x"), { response: { status, data } }); };

  it.each([
    ["order_too_large", 400, { ok: false, error: "order_too_large", details: { symbol: "BTC/USD", maxNotional: "5000000.00", requestedNotional: "6000000.00" } }, "Max order $5,000,000 on BTC"],
    ["book_stale_for_size", 503, { ok: false, error: "book_stale_for_size" }, "Price feed stale — try a smaller order or retry"],
    ["insufficient_balance", 400, { ok: false, error: "insufficient_balance" }, "Insufficient margin — $100,000.00 free. Lower the size or leverage"],
    ["leverage_exceeds_cap", 400, { ok: false, error: "leverage_exceeds_cap" }, "Leverage above your 10x limit"],
    ["reduce_only_no_position", 400, { ok: false, error: "reduce_only_no_position" }, "No position to reduce — it's already closed"],
    ["rate limit", 429, { statusCode: 429, error: "Too Many Requests", message: "Rate limit exceeded, retry in 1 minute" }, "Too many requests — wait a moment and retry"],
  ])("%s: the message stays under the button until the next edit", async (_n, status, data, text) => {
    http.post = reject(status, data);
    const user = userEvent.setup();
    mount();
    await settle();
    await user.type(amount(), "1000");
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    await settle();
    expect(screen.getByTestId("order-error").textContent).toBe(text);
    expect(screen.getByRole("button", { name: /OPEN LONG/ })).toBeTruthy();  // no label flash
    await user.type(amount(), "0");
    expect(screen.queryByTestId("order-error")).toBeNull();
  });

  it("doesn't time out", async () => {
    http.post = reject(503, { ok: false, error: "book_stale_for_size" });
    const user = userEvent.setup();
    mount();
    await settle();
    await user.type(amount(), "1000");
    await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
    await settle(3200);
    expect(screen.getByTestId("order-error")).toBeTruthy();
  });

  it("clears on side, leverage and order type too", async () => {
    http.post = reject(400, { ok: false, error: "insufficient_balance" });
    const user = userEvent.setup();
    mount();
    await settle();
    const fail = async () => {
      await user.click(screen.getByRole("button", { name: /OPEN (LONG|SHORT)/ }));
      await settle();
      expect(screen.getByTestId("order-error")).toBeTruthy();
    };
    await user.type(amount(), "1000");
    await fail();
    await user.click(screen.getByText("SHORT"));
    expect(screen.queryByTestId("order-error")).toBeNull();
    await fail();
    await user.click(screen.getByRole("radio", { name: "2x leverage" }));
    expect(screen.queryByTestId("order-error")).toBeNull();
    await fail();
    await user.click(screen.getByText("LIMIT"));
    expect(screen.queryByTestId("order-error")).toBeNull();
  });

  it("a failed CLOSE says why next to CLOSE", async () => {
    http.post = reject(503, { ok: false, error: "stale_price_source" });
    mount(isoPosition("0.10000000"));
    await settle();
    await userEvent.setup().click(screen.getByRole("button", { name: "CLOSE POSITION" }));
    await settle();
    expect(within(screen.getByTestId("position-actions")).getByRole("alert").textContent).toBe("Price feed delayed — retry");
  });
});

describe("submit label on the other side of a position", () => {
  async function against(usd: string) {
    http.leverage = { ...LEV, positionLeverage: "5" };
    const user = userEvent.setup();
    mount(isoPosition("0.10000000"));
    await settle();
    await user.click(screen.getByText("SHORT"));
    await user.type(amount(), usd);
    return user;
  }
  // The position's 5x is locked: margin × 5 = notional. Position = $10,000.
  it("a smaller order reduces, in one click", async () => {
    const user = await against("1000");
    await user.click(screen.getByRole("button", { name: "REDUCE LONG" }));
    await settle();
    expect(http.orders).toHaveLength(1);
    expect(screen.queryByTestId("confirm-box")).toBeNull();
  });
  it("the same size closes, in one click", async () => {
    const user = await against("2000");
    await user.click(screen.getByRole("button", { name: "CLOSE" }));
    await settle();
    expect(http.orders).toHaveLength(1);
    expect(screen.queryByTestId("confirm-box")).toBeNull();
  });
  it("a bigger order flips, and still asks first", async () => {
    const user = await against("3000");
    await user.click(screen.getByRole("button", { name: "CLOSE & REVERSE" }));
    expect(http.orders).toHaveLength(0);
    expect(screen.getByTestId("confirm-box")).toBeTruthy();
  });
  it("tells the quote the order only shrinks the position", async () => {
    await against("1000");
    await debounced();
    expect(http.quotes.filter((q) => q.params.qty !== undefined).at(-1)!.params.reduces).toBe(true);
  });
});

describe("a 1x long has no liq price", () => {
  it("preview and card both say None", async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await user.type(amount(), "1000");
    await debounced();
    expect(screen.getByTestId("est-liq").textContent).toBe("None");
    cleanup();
    mount(isoPosition("0.10000000", { leverage: "1", isolated_margin: "10000", liq_price: "0.00000000" }));
    await settle();
    expect(screen.getByTestId("pos-liq").textContent).toBe("None");
  });
});

describe("chips are buttons", () => {
  it("leverage: real buttons, arrow keys move the selection", async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    const one = screen.getByRole("radio", { name: "1x leverage" });
    expect(one.tagName).toBe("BUTTON");
    one.focus();
    await user.keyboard("{ArrowRight}");
    const two = screen.getByRole("radio", { name: "2x leverage" });
    expect(two.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(two);
    await user.keyboard("{ArrowLeft}");
    expect(one.getAttribute("aria-checked")).toBe("true");
  });

  it("presets: buttons with a label, Enter works, and none sits inside a <label>", async () => {
    const user = userEvent.setup();
    mount();
    await settle();
    await debounced();
    const max = screen.getByRole("button", { name: /^MAX/ });
    expect(max.tagName).toBe("BUTTON");
    expect(max.getAttribute("aria-label")).toMatch(/^MAX: use all available/);
    expect(max.closest("label")).toBeNull();
    max.focus();
    await user.keyboard("{Enter}");
    await settle();
    expect((amount() as HTMLInputElement).value).not.toBe("");
  });

  it("disabled with nothing to spend", async () => {
    useAppStore.setState({ wallets: [{ id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "0", reserved: "0", created_at: "", updated_at: "" }] });
    mount();
    await settle();
    expect((screen.getByRole("button", { name: /^MAX/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("F-04: the actions live outside the scrolled card", () => {
  it("CLOSE POSITION and both confirms sit in the pinned action bar", async () => {
    const user = userEvent.setup();
    mount(isoPosition("0.10000000"));
    await settle();
    const bar = screen.getByTestId("position-actions");
    expect(bar.className).toBe("tr-pos-actions");
    expect(within(bar).getByRole("button", { name: "CLOSE POSITION" })).toBeTruthy();
    expect(within(screen.getByTestId("position-card")).queryByRole("button", { name: "CLOSE POSITION" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "reverse to short…" }));
    expect(within(bar).getByRole("button", { name: "REVERSE TO SHORT" })).toBeTruthy();
    await user.click(within(bar).getByRole("button", { name: "CANCEL" }));

    await user.click(screen.getByText("SHORT"));
    await user.type(amount(), "20000");
    await user.click(screen.getByRole("button", { name: "CLOSE & REVERSE" }));
    expect(within(bar).getByRole("button", { name: "CONFIRM" })).toBeTruthy();
  });

  it("one confirm at a time, and a closed position takes its confirm with it", async () => {
    const user = userEvent.setup();
    const { rerender } = mount(isoPosition("0.10000000"));
    await settle();
    await user.click(screen.getByText("SHORT"));
    await user.type(amount(), "20000");
    await user.click(screen.getByRole("button", { name: "CLOSE & REVERSE" }));
    await user.click(screen.getByRole("button", { name: "reverse to short…" }));
    expect(screen.getAllByTestId("confirm-box")).toHaveLength(1);

    const panel = (position: Position | null) => (
      <ToastProvider><UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} /></ToastProvider>
    );
    rerender(panel(null));
    await settle();
    rerender(panel(isoPosition("0.10000000")));
    await settle();
    expect(screen.queryByTestId("confirm-box")).toBeNull();
  });

  it("both pages pin that bar in their CSS", async () => {
    const proc = (globalThis as { process?: { cwd(): string } }).process!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs: any = await import(/* @vite-ignore */ ["node", "fs"].join(":"));
    const read = (f: string): string => fs.readFileSync(`${proc.cwd()}/src/${f}`, "utf8");
    expect(read("pages/TradingPage.tsx")).toMatch(/\.tr-pos-actions \{\s*position:sticky;bottom:0/);
    expect(read("components/arena/LiveMatchView.tsx")).toMatch(/\.lmv-pos-actions \{\s*position: sticky;\s*bottom: 0/);
  });
});
