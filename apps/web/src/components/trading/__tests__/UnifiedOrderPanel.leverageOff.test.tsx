/**
 * Leverage off (or a 1x cap) leaves the order panel exactly as it was before
 * the leverage UI (leverage PR 6b): the rendered HTML and every request body
 * are compared to a golden recorded from origin/main before this PR
 * (WRITE_GOLDEN=1 writes it; this file runs unchanged on both sides because
 * it mocks only the HTTP client, which both versions use).
 *
 *   A  MARKET LONG, $50 entered → submit
 *   B  LIMIT SHORT at 84,000, $50 entered → submit
 *   C  an open SPOT long (position card) → CLOSE POSITION
 *
 * The one deliberate difference: CLOSE POSITION now sends reduceOnly: true
 * (so a close that loses a race can never open a position).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const http = vi.hoisted(() => ({
  leverage: null as null | Record<string, unknown>,
  posts: [] as { url: string; body: unknown }[],
}));

vi.mock("@/api/client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/api/client")>();
  const fake = {
    get: vi.fn(async (url: string) => {
      if (url.startsWith("/leverage")) {
        if (!http.leverage) throw Object.assign(new Error("unavailable"), { response: { status: 500, data: {} } });
        return { data: http.leverage };
      }
      if (url.includes("trigger")) return { data: { ok: true, data: [], nextCursor: null } };
      return { data: { ok: true } };
    }),
    post: vi.fn(async (url: string, body: unknown) => {
      http.posts.push({ url, body });
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

// The web tsconfig has no Node types; vitest runs in Node (cwd = apps/web),
// so reach fs and the env untyped.
const nodeProcess = (globalThis as { process?: { cwd(): string; env: Record<string, string | undefined> } }).process!;
const FIXTURES = `${nodeProcess.cwd()}/src/components/trading/__tests__/__fixtures__`;
const GOLDEN = `${FIXTURES}/orderPanelLeverageOff.golden.json`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs = (): Promise<any> => import(/* @vite-ignore */ ["node", "fs"].join(":"));
const writeGolden = nodeProcess.env.WRITE_GOLDEN === "1";
const PRICE = "83950";

const PAIR: TradingPair = {
  id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
  fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
};

const POSITION: Position = {
  user_id: "u1", pair_id: "p1", base_qty: "0.01000000", avg_entry_price: "83000.00000000",
  realized_pnl_quote: "0", fees_paid_quote: "0.41500000", unrealized_pnl_quote: "9.50000000",
  current_price: PRICE, updated_at: "2026-10-26T00:00:00Z",
};

const SPOT = { ok: true, pairId: "p1", enabled: false, marginMode: "SPOT", cap: 1, mmrBps: 50, positionLeverage: null, blockedBy: null, scope: { competitionId: null, matchId: null } };
const ISOLATED_1X = { ...SPOT, enabled: true, marginMode: "ISOLATED" };

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setup() {
  cleanup();
  http.posts = [];
  useAppStore.setState({
    initialized: true, sseConnectionState: "connected", matchWallets: null,
    wallets: [
      { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "10000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
      { id: "w-btc", user_id: "u1", asset_id: "a-btc", balance: "0.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
    ],
  });
  useTradingStore.setState({
    selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [],
    snapshot: { bid: PRICE, ask: PRICE, last: PRICE, ts: "0", source: "live" },
  });
}

function mount(position: Position | null) {
  return render(
    <ToastProvider>
      <UnifiedOrderPanel pair={PAIR} position={position} onOrderFilled={() => {}} />
    </ToastProvider>,
  );
}

const lastOrderBody = () => http.posts.filter((p) => p.url === "/orders").at(-1)?.body;

async function scenarioA() {
  setup();
  const { container } = mount(null);
  await settle();
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("0.00"), "50");
  await settle();
  const html = container.innerHTML;
  await user.click(screen.getByRole("button", { name: /OPEN LONG/ }));
  await settle();
  return { html, body: lastOrderBody() };
}

async function scenarioB() {
  setup();
  const { container } = mount(null);
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByText("SHORT"));
  await user.click(screen.getByText("LIMIT"));
  act(() => { useTradingStore.setState({ limitPrice: "84000" }); });
  await user.type(screen.getByPlaceholderText("0.00"), "50");
  await settle();
  const html = container.innerHTML;
  await user.click(screen.getByRole("button", { name: /OPEN SHORT/ }));
  await settle();
  return { html, body: lastOrderBody() };
}

async function scenarioC() {
  setup();
  const { container } = mount(POSITION);
  await settle();
  const html = container.innerHTML;
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /CLOSE POSITION/ }));
  await settle();
  return { html, closeBody: lastOrderBody() };
}

async function record() {
  return { A: await scenarioA(), B: await scenarioB(), C: await scenarioC() };
}

type Golden = Awaited<ReturnType<typeof record>>;

async function golden(): Promise<Golden> {
  return JSON.parse((await nodeFs()).readFileSync(GOLDEN, "utf8"));
}

beforeEach(() => {
  http.leverage = SPOT;
});

describe("leverage off: the order panel is unchanged", () => {
  it("records the golden (WRITE_GOLDEN=1) or matches it", async () => {
    const got = await record();
    if (writeGolden) {
      const fs = await nodeFs();
      fs.mkdirSync(FIXTURES, { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
    }
    const g = await golden();
    expect(got.A).toEqual(g.A);
    expect(got.B).toEqual(g.B);
    expect(got.C.html).toEqual(g.C.html);
    // The one difference: CLOSE is reduce-only.
    expect(got.C.closeBody).toEqual({ ...(g.C.closeBody as object), reduceOnly: true });
  });

  it("the same when GET /leverage fails (the panel falls back to today's)", async () => {
    http.leverage = null;
    const got = await record();
    const g = await golden();
    expect(got.A).toEqual(g.A);
    expect(got.B).toEqual(g.B);
    expect(got.C.html).toEqual(g.C.html);
  });

  it("ISOLATED at a 1x cap: the order form and bodies are unchanged too (no selector, no leverage sent)", async () => {
    http.leverage = ISOLATED_1X;
    const got = await record();
    const g = await golden();
    expect(got.A).toEqual(g.A);
    expect(got.B).toEqual(g.B);
    expect((got.A.body as Record<string, unknown>).leverage).toBeUndefined();
  });
});
