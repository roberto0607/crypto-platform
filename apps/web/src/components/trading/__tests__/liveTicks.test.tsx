/**
 * Live price after the chart stopped re-rendering on every tick: the readouts
 * that show the live price still update on every tick.
 *
 * - In the chart: LiveTick re-renders only its children per tick (they read
 *   the chart's refs fresh), the hero price follows every tick, and the day
 *   direction re-renders its user only when it flips.
 * - The alert banners (PDH/PDL proximity, S/R APPROACHING) follow every tick
 *   through the same helpers the chart's tick handler calls, and a tick that
 *   keeps the same banner keeps the same state value (no re-render).
 * - The order panel (est. fill / notional / est. liq) and the position card
 *   (P&L, mark, liq distance, equity) never depended on the chart: after
 *   every tick the live panel shows exactly what a freshly mounted panel
 *   shows at that price, and the P&L moved.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";

const flags = vi.hoisted(() => ({ SHOW_LEVERAGE_SELECTOR: true, SHOW_FUNDING_IN_CHART_HEADER: false }));
vi.mock("@/lib/featureFlags", async (orig) => ({ ...(await orig<typeof import("@/lib/featureFlags")>()), ...flags }));

/** A fixed quote (the book doesn't move with these ticks; the ticker does). */
vi.mock("@/api/client", async (importOriginal) => {
    const orig = await importOriginal<typeof import("@/api/client")>();
    const fake = {
        get: vi.fn(async (url: string, cfg?: { params: { qty?: string; budget?: string } }) => {
            if (url.startsWith("/leverage")) {
                return { data: { ok: true, pairId: "p1", enabled: true, marginMode: "ISOLATED", cap: 10, mmrBps: 50, positionLeverage: "10.00", blockedBy: null, scope: { competitionId: null, matchId: null } } };
            }
            if (url === "/v1/sim/quote") {
                const p = cfg!.params;
                const notional = p.budget ? Number(p.budget) : Number(p.qty) * 83960;
                return { data: {
                    executable: true, reason: null, qty: (notional / 83960).toFixed(8), touchPrice: "83950.00000000",
                    estimatedPrice: "83960.00000000", slippage_bps: "1.19000000", slippageQuote: (notional * 0.000119).toFixed(8),
                    requestedNotional: notional.toFixed(8), feeQuote: (notional * 0.0005).toFixed(8), maxOrderNotional: "5000000.00",
                } };
            }
            if (url.includes("trigger")) return { data: { ok: true, data: [], nextCursor: null } };
            return { data: { ok: true } };
        }),
        post: vi.fn(async () => ({ data: { ok: true } })),
        patch: vi.fn(), delete: vi.fn(), put: vi.fn(),
        interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
        defaults: { headers: { common: {} } },
    };
    return { ...orig, default: fake };
});

import { LiveTick, ChartHeroPrice, createLiveTick } from "@/components/trading/ChartLiveReadouts";
import { UnifiedOrderPanel } from "@/components/trading/UnifiedOrderPanel";
import ToastProvider from "@/components/ToastProvider";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";
import { useAppStore } from "@/stores/appStore";
import { usePairChange, usePairDayDirection } from "@/hooks/usePairChange";
import { dayDirection } from "@/lib/priceChange";
import type { Position, TradingPair } from "@/types/api";
import { keyLevelProximity, nextSrApproach, type KeyLevelBanner } from "@/lib/chartTickBanners";
import { srApproach, type SRBanner, type SRDrawable } from "@/lib/srDisplay";

const TICKS = [83_950, 84_012.5, 83_871.25, 84_420, 82_999.99];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const quoted = () => act(async () => { await new Promise((r) => setTimeout(r, 300)); });

function tick(price: number) {
    act(() => {
        useTradingStore.setState({ snapshot: { bid: String(price), ask: String(price), last: String(price), ts: "0", source: "live" } });
        usePairPricesStore.getState().setPairPrice("p1", price);
    });
}

beforeEach(() => {
    cleanup();
    usePairPricesStore.setState({ prices: {} });
    useDailyOpenStore.setState({ opens: { p1: { open: 84_000, dateUTC: new Date().toISOString().slice(0, 10) } } });
    useTradingStore.setState({ selectedPairId: "p1", snapshot: null });
});

describe("LiveTick (chart readouts that follow the price)", () => {
    it("re-renders its children with the latest value on every tick; the parent doesn't re-render", () => {
        const store = createLiveTick();
        let parentRenders = 0;
        const price = { current: 0 };
        function Parent() {
            parentRenders++;
            const renders = useRef(0);
            return <LiveTick store={store}>{() => { renders.current++; return <span data-testid="px">{price.current}</span>; }}</LiveTick>;
        }
        render(<Parent />);
        for (const p of TICKS) {
            price.current = p;
            act(() => store.publish());
            expect(screen.getByTestId("px").textContent).toBe(String(p));
        }
        expect(parentRenders).toBe(1);
    });
});

describe("chart hero price", () => {
    it("shows every tick (snapshot first, as before), flashing up/down", () => {
        render(<ChartHeroPrice pairId="p1" dayDir="flat" />);
        let prev: number | null = null;
        for (const p of TICKS) {
            tick(p);
            const el = screen.getByTestId("chart-hero-price");
            expect(el.textContent).toBe(`$${p.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
            if (prev !== null) expect(el.className).toContain(p > prev ? "tick-up" : "tick-down");
            prev = p;
        }
        // Replay: the snapshot wins over the pair price.
        act(() => {
            useTradingStore.setState({ snapshot: { bid: "1", ask: "1", last: "70000", ts: "0", source: "replay" } as never });
            usePairPricesStore.getState().setPairPrice("p1", 99_999);
        });
        expect(screen.getByTestId("chart-hero-price").textContent).toBe("$70,000.00");
    });

    it("FILL SPREAD follows the snapshot", () => {
        render(<ChartHeroPrice pairId="p1" dayDir="up" />);
        act(() => useTradingStore.setState({ snapshot: { bid: "100", ask: "101", last: "100.5", ts: "0", source: "live" } }));
        expect(screen.getByText("$1.00 (0.9950%)")).toBeInTheDocument();
        act(() => useTradingStore.setState({ snapshot: { bid: "100", ask: "100.5", last: "100.2", ts: "0", source: "live" } }));
        expect(screen.getByText("$0.50 (0.4988%)")).toBeInTheDocument();
    });
});

describe("day direction (price line color)", () => {
    it("equals dayDirection(usePairChange) on every tick, but re-renders only when it flips", () => {
        const seen: Array<{ dir: string | null; expected: string }> = [];
        let renders = 0;
        function Probe() {
            renders++;
            const dir = usePairDayDirection("p1");
            return <span data-testid="dir">{dir}</span>;
        }
        function Reference() {
            const change = usePairChange("p1");
            seen.push({ dir: null, expected: dayDirection(change) });
            return null;
        }
        render(<><Probe /><Reference /></>);
        const before = renders;
        // 84,000 open: down, up, down, up, down — and some same-direction ticks.
        for (const p of [83_950, 83_900, 84_012.5, 84_100, 83_871.25, 84_420, 84_500, 82_999.99]) {
            tick(p);
            expect(screen.getByTestId("dir").textContent).toBe(seen.at(-1)!.expected);
        }
        // 5 flips (down→… is the first value) over 8 ticks.
        expect(renders - before).toBe(5);
    });
});

describe("order panel + position card on every tick (they don't depend on the chart)", () => {
    const PAIR: TradingPair = {
        id: "p1", symbol: "BTC/USD", base_asset_id: "a-btc", quote_asset_id: "a-usd", is_active: true,
        fee_bps: 0, maker_fee_bps: 2, taker_fee_bps: 5, trading_enabled: true, created_at: "2026-10-15T00:00:00Z",
    };
    const ISO_LONG: Position = {
        user_id: "u1", pair_id: "p1", base_qty: "0.00602409", avg_entry_price: "83000.00000000",
        realized_pnl_quote: "0", fees_paid_quote: "0.24999973", unrealized_pnl_quote: "0", current_price: "83950",
        updated_at: "2026-10-26T00:00:00Z", margin_mode: "ISOLATED", leverage: "10.00",
        isolated_margin: "49.99994700", liq_price: "75075.37688442", mark_price: "83950", margin_health: "0.6000",
    };

    function setupStores() {
        useAppStore.setState({
            initialized: true, sseConnectionState: "connected", matchWallets: null,
            wallets: [
                { id: "w-usd", user_id: "u1", asset_id: "a-usd", balance: "10000.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
                { id: "w-btc", user_id: "u1", asset_id: "a-btc", balance: "0.00000000", reserved: "0.00000000", created_at: "", updated_at: "" },
            ],
        });
        useTradingStore.setState({ selectedPairId: "p1", orderType: "MARKET", orderSide: "BUY", qty: "", limitPrice: "", activeTriggers: [] });
    }

    const panel = () => (
        <ToastProvider>
            <UnifiedOrderPanel pair={PAIR} position={ISO_LONG} positions={[ISO_LONG]} onOrderFilled={() => {}} />
        </ToastProvider>
    );
    // The P&L flash is the only thing a fresh mount can't have. A controlled
    // input's value ATTRIBUTE is synced lazily by React (not what's shown), so
    // inputs are compared by their value property instead.
    const html = (el: HTMLElement) => {
        const inputs = [...el.querySelectorAll("input")].map((i) => i.value).join("|");
        return `${inputs}\n${el.innerHTML
            .replace(/ class="pnl-flash"/g, "")
            .replace(/ --pnl-flash-tint: [^;]*;/g, "")
            .replace(/ value="[^"]*"/g, "")}`;
    };

    function expectSameHtml(label: string, a: string, b: string) {
        if (a === b) return;
        let i = 0;
        while (a[i] === b[i]) i++;
        expect(`${label}: …${a.slice(i - 200, i + 200)}`).toBe(`${label}: …${b.slice(i - 200, i + 200)}`);
    }

    async function freshPanel(user: ReturnType<typeof userEvent.setup>) {
        const fresh = render(panel());
        await settle();
        await user.type(fresh.container.querySelector('input[placeholder="0.00"]') as HTMLInputElement, "50");
        await quoted();
        return fresh;
    }
    const card = (el: HTMLElement) => html(el.querySelector(".tr-position-card-sticky") as HTMLElement);

    it("every tick: the position card (P&L, mark, liq distance, health) equals a fresh mount at that price, and the P&L moved", async () => {
        setupStores();
        tick(TICKS[0]!);
        const live = render(panel());
        await settle();
        const user = userEvent.setup();
        await user.type(screen.getAllByPlaceholderText("0.00")[0]!, "50");
        await quoted();

        let prevPnl: string | null = null;
        for (const p of TICKS) {
            tick(p);
            await settle();
            const pnl = live.container.querySelector('[data-testid="pos-pnl"]')!.textContent;
            if (prevPnl !== null) expect(pnl).not.toBe(prevPnl);
            prevPnl = pnl;
            const liveCard = card(live.container);
            const fresh = await freshPanel(user);
            expectSameHtml(`card at ${p}`, liveCard, card(fresh.container));
            fresh.unmount();
        }
    });

    it("the order preview (est. fill, notional, slippage, fee, est. liq) follows its 5 s re-quote: then equals a fresh mount", async () => {
        setupStores();
        tick(TICKS[0]!);
        const live = render(panel());
        await settle();
        const user = userEvent.setup();
        await user.type(screen.getAllByPlaceholderText("0.00")[0]!, "50");
        await quoted();
        for (const p of TICKS.slice(1)) { tick(p); await settle(); }
        // Past the panel's QUOTE_REFRESH_MS (5 s): the background re-quote has run at the last price.
        await act(async () => { await new Promise((r) => setTimeout(r, 5_400)); });
        expect(live.container.querySelector('[data-testid="est-liq"]')!.textContent).toMatch(/^\$/);
        const liveHtml = html(live.container);
        const fresh = await freshPanel(user);
        expectSameHtml(`panel at ${TICKS.at(-1)}`, liveHtml, html(fresh.container));
    }, 30_000);
});

describe("alert banners on every tick (PDH/PDL proximity, S/R APPROACHING)", () => {
    const LEVELS = { pdh: 85_000, pdl: 82_000 };
    const level = (id: string, role: "support" | "resistance", price: number, extra: Partial<SRDrawable> = {}): SRDrawable => ({
        id, role, price, top: price + 50, bottom: price - 50, fromTime: 0, toTime: null,
        broken: false, emphasis: "full", color: "#fff", dashed: false, label: `${role} ${price}`, ...extra,
    });
    const DRAWABLES = [
        level("r1", "resistance", 84_500),
        level("s1", "support", 83_000),
        level("faded", "support", 83_200, { emphasis: "faded" }),
        level("broken", "resistance", 84_300, { broken: true }),
    ];
    const ATR = 400; // approach window: within 200 of a zone edge

    /**
     * The chart's tick path in miniature: setState through the shared helpers.
     * Counts commits (an effect with no deps), not function calls: React may
     * call a component once more before bailing out of a same-value update.
     */
    let push: (price: number) => void = () => {};
    let renders = 0;
    function Banners() {
        useEffect(() => { renders++; });
        const [pdh, setPdh] = useState<KeyLevelBanner>(null);
        const [sr, setSr] = useState<SRBanner | null>(null);
        push = (price) => {
            setPdh(keyLevelProximity(LEVELS, price).banner);
            setSr((prev) => nextSrApproach(prev, DRAWABLES, price, ATR));
        };
        return (
            <>
                {pdh && <span data-testid="pdh-banner">APPROACHING PD{pdh === "pdh" ? "H" : "L"}</span>}
                {sr && <span data-testid="sr-banner">{sr.label}</span>}
            </>
        );
    }

    it("shows exactly the banners decided at each tick's price, re-rendering only when one changes", () => {
        renders = 0;
        render(<Banners />);
        const prices = [83_950, 83_960, 84_300, 84_310, 84_700, 85_100, 83_100, 82_900, 82_950, 81_000];
        let expectedRenders = renders;
        let prev: { pdh: KeyLevelBanner; sr: string | null } = { pdh: null, sr: null };
        for (const p of prices) {
            act(() => push(p));
            const pdh = keyLevelProximity(LEVELS, p).banner;
            const sr = srApproach(DRAWABLES, p, ATR)?.label ?? null;
            expect(screen.queryByTestId("pdh-banner")?.textContent ?? null).toBe(pdh ? `APPROACHING PD${pdh === "pdh" ? "H" : "L"}` : null);
            expect(screen.queryByTestId("sr-banner")?.textContent ?? null).toBe(sr);
            if (pdh !== prev.pdh || sr !== prev.sr) expectedRenders++;
            expect(renders).toBe(expectedRenders);
            prev = { pdh, sr };
        }
        // The sequence must actually exercise both banners appearing, changing and clearing.
        expect(expectedRenders - 1).toBeGreaterThanOrEqual(5);
    });

    it("faded and broken levels never raise APPROACHING; 0 ATR / price raises nothing", () => {
        expect(srApproach(DRAWABLES, 83_200, ATR)?.label).toBe("support 83000"); // not the faded one at 83,200
        expect(srApproach(DRAWABLES, 84_300, ATR)?.label).toBe("resistance 84500"); // not the broken one at 84,300
        expect(srApproach(DRAWABLES, 84_500, 0)).toBeNull();
        expect(keyLevelProximity(LEVELS, 0).banner).toBeNull();
    });

    it("PDH wins when both are within 1.5%; the edge counts", () => {
        expect(keyLevelProximity({ pdh: 100.5, pdl: 99.5 }, 100)).toEqual({ pdhProx: true, pdlProx: true, banner: "pdh" });
        expect(keyLevelProximity({ pdh: 101.5, pdl: 90 }, 100).banner).toBe("pdh");
        expect(keyLevelProximity({ pdh: 101.51, pdl: 90 }, 100).banner).toBeNull();
        expect(keyLevelProximity({ pdh: 120, pdl: 98.5 }, 100).banner).toBe("pdl");
    });
});
