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
 *   D  the same long, SHORT $100 → REDUCE LONG, one click, no confirm
 *
 * Deliberate differences, each applied explicitly below so everything else
 * still has to match the golden byte for byte:
 *   - CLOSE POSITION sends reduceOnly: true (a close that loses a race can
 *     never open a position);
 *   - with a position open, the order footer gets
 *     tr-order-footer-with-position (the clipped-summary bug fix).
 *
 * Re-recorded for the position-card redesign: A and B (no position) and
 * every request body are byte-identical to the previous golden; only C's
 * card markup changed, on purpose. The SPOT card was
 *   BTC LONG | $830.00 | ENTRY | CURRENT | VALUE | P&L +$9.50 (+1.14%) | TP -- | SL -- | CLOSE POSITION
 * and is now
 *   BTC LONG | UNREALIZED P&L +$9.50 +1.14% | ENTRY | MARK | SIZE 0.01000 BTC · $830 |
 *   + SET TAKE PROFIT | + SET STOP LOSS | CLOSE POSITION | equity $839.50 | reverse to short…
 * (the card itself moved into PositionCard.tsx).
 *
 * Re-recorded again when the card moved to the TOP of the panel (above
 * LONG/SHORT, so it's visible without scrolling): in C the card element
 * is now the order section's first child instead of the footer's last,
 * with identical card markup; the footer keeps -with-position and holds
 * only the summary + submit. A, B and every body are unchanged. The old
 * withFooterFix transform (card into the footer) is gone; C is compared
 * to the golden as recorded.
 *
 * Re-recorded for order panel truth (audit PR 2b; the html now waits past the
 * quote debounce, against a fixed quote). Every request body is byte-identical
 * to the previous golden. What changed in the html, all three scenarios:
 *   - ENTRY PRICE → EST. FILL (from the quote; `--` with no amount), with a
 *     tooltip; on MARKET a full-width SLIPPAGE row after POSITION SIZE (class
 *     tr-sum-wide); POSITION SIZE and FEE come from the quote;
 *   - the 25/50/75/MAX spans left the AMOUNT label: real buttons in their own
 *     row, with the notional each would place.
 * In C only: CLOSE POSITION moved out of the card into the pinned
 * -pos-actions bar after the footer; the card's MARK reads LAST (a SPOT card
 * values at the last trade) and its equity row lost a 6px top margin.
 * D is new: REDUCE and CLOSE dropped their confirm (one click to exit, only
 * CLOSE & REVERSE still asks). A, B and C don't reach a confirm, so that
 * change left them as they were; D pins the label and the body.
 *
 * Re-recorded when the form's MARKET REDUCE / CLOSE became reduce-only: D's
 * body gains reduceOnly: true, on purpose (the one leverage-off body that
 * changes: a stale panel could sell through a shrunken position and open the
 * other side). D's html and all of A, B and C are unchanged. A flip and a
 * LIMIT stay plain.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const http = vi.hoisted(() => ({
  leverage: null as null | Record<string, unknown>,
  posts: [] as { url: string; body: unknown }[],
}));

/** GET /v1/sim/quote, a fixed book: 83,960 average, at any size. */
const fixedQuote = vi.hoisted(() => (p: { qty?: string; budget?: string }) => {
  const notional = p.budget ? Number(p.budget) * 0.99 : Number(p.qty) * 83960;
  return {
    executable: true, reason: null, qty: (notional / 83960).toFixed(8), touchPrice: "83950.00000000",
    estimatedPrice: "83960.00000000", slippage_bps: "1.19000000", slippageQuote: (notional * 0.000119).toFixed(8),
    requestedNotional: notional.toFixed(8), feeQuote: (notional * 0.0005).toFixed(8), maxOrderNotional: "5000000.00",
  };
});

vi.mock("@/api/client", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/api/client")>();
  const fake = {
    get: vi.fn(async (url: string, cfg?: { params: { qty?: string; budget?: string } }) => {
      if (url.startsWith("/leverage")) {
        if (!http.leverage) throw Object.assign(new Error("unavailable"), { response: { status: 500, data: {} } });
        return { data: http.leverage };
      }
      if (url === "/v1/sim/quote") return { data: fixedQuote(cfg!.params) };
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
/** Past the quote debounce, so the html has the preview and the chips. */
const quoted = () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });

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

// Every order names its scope, checked here rather than in the golden, so the
// golden still pins the rest of the body byte for byte.
const lastOrderBody = () => {
  const body = http.posts.filter((p) => p.url === "/orders").at(-1)?.body as { scope?: string } | undefined;
  if (!body) return body;
  const { scope, ...rest } = body;
  expect(scope).toBe("free");
  return rest;
};

async function scenarioA() {
  setup();
  const { container } = mount(null);
  await settle();
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText("0.00"), "50");
  await quoted();
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
  await quoted();
  const html = container.innerHTML;
  await user.click(screen.getByRole("button", { name: /OPEN SHORT/ }));
  await settle();
  return { html, body: lastOrderBody() };
}

async function scenarioC() {
  setup();
  const { container } = mount(POSITION);
  await quoted();
  const html = container.innerHTML;
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /CLOSE POSITION/ }));
  await settle();
  return { html, closeBody: lastOrderBody() };
}

async function scenarioD() {
  setup();
  const { container } = mount(POSITION);
  await settle();
  const user = userEvent.setup();
  await user.click(screen.getByText("SHORT"));
  await user.type(screen.getByPlaceholderText("0.00"), "100");
  await quoted();
  const html = container.innerHTML;
  await user.click(screen.getByRole("button", { name: "REDUCE LONG" }));
  await settle();
  return { html, body: lastOrderBody(), confirm: screen.queryByTestId("confirm-box") !== null };
}

async function record() {
  return { A: await scenarioA(), B: await scenarioB(), C: await scenarioC(), D: await scenarioD() };
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
    expect(got.D).toEqual(g.D);
    expect(got.D.confirm).toBe(false);
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
