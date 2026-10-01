import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { FeaturedMatch } from "@/api/endpoints/landing";
import type { QuickCallHook } from "@/hooks/useQuickCall";
import type { LandingStreamState } from "@/hooks/useLandingStream";

let streamState: LandingStreamState;
let quickState: QuickCallHook;

vi.mock("@/hooks/useLandingStream", () => ({ useLandingStream: () => streamState }));
vi.mock("@/hooks/useQuickCall", () => ({ useQuickCall: () => quickState, RESULT_HOLD_MS: 4000 }));
vi.mock("@/api/endpoints/landing", () => ({ checkHandle: vi.fn() }));

import LandingPage from "../LandingPage";
import { checkHandle } from "@/api/endpoints/landing";

const match: FeaturedMatch = {
  matchId: "m-1",
  secondsLeft: 600,
  spectatorCount: 3,
  challenger: { handle: "alpha_wolf", returnPct: 1, pnlUsd: 500 },
  opponent: { handle: "beta_bear", returnPct: -1, pnlUsd: -500 },
  series: [],
  lastTrades: [],
};

function baseQuick(overrides: Partial<QuickCallHook> = {}): QuickCallHook {
  return {
    sessionReady: true, round: null, streak: 0, history: [], lastSettled: null,
    roundInProgress: false, error: null, placing: false,
    place: vi.fn(async () => {}), applyStreamResult: vi.fn(), ...overrides,
  };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  streamState = { prices: { BTC: { price: "84000", move: null, at: 0 } }, featured: null, lastResult: null };
  quickState = baseQuick();
  vi.mocked(checkHandle).mockReset();
});

describe("LandingPage", () => {
  it("has one headline, one primary CTA form, and no legacy CTAs, emoji, or PAPER overlay", () => {
    const { container } = renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Trade\s*Head-to-head\./i);
    expect(screen.getByText("SEASON 01 · 1V1 MATCHES OPEN")).toBeInTheDocument();
    expect(screen.getByLabelText("CLAIM YOUR HANDLE")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ENTER" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/ENTER ARENA|CREATE ACCOUNT|CLAIM #1|CLAIM IT NOW|PAPER/);
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("shows only BTC/ETH/SOL in the ticker, and only coins with a price", () => {
    streamState.prices = { BTC: { price: "84000", move: "up", at: 0 }, SOL: { price: "140", move: null, at: 0 } };
    renderPage();
    const ticker = screen.getByRole("list", { name: "Live prices" });
    expect(ticker.textContent).toMatch(/BTC/);
    expect(ticker.textContent).toMatch(/SOL/);
    expect(ticker.textContent).not.toMatch(/ETH|DOGE|BNB|AVAX|ARB|LINK/);
  });

  it("renders no right panel until the stream says whether a match is live", () => {
    streamState.featured = undefined;
    renderPage();
    expect(screen.queryByText("NO LIVE MATCH")).toBeNull();
    expect(screen.queryByText("LIVE 1V1")).toBeNull();
  });

  it("shows the idle panel when no match is live, and the live panel when one is", () => {
    const { rerender } = renderPage();
    expect(screen.getByText("NO LIVE MATCH")).toBeInTheDocument();
    streamState = { ...streamState, featured: match };
    rerender(
      <MemoryRouter initialEntries={["/"]}>
        <Routes><Route path="/" element={<LandingPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("LIVE 1V1")).toBeInTheDocument();
    expect(screen.queryByText("NO LIVE MATCH")).toBeNull();
  });

  it("finishes a running round before switching to a match that went live mid-round", () => {
    quickState = baseQuick({
      roundInProgress: true,
      round: { call: { id: "c1", direction: "UP", entryPrice: "84000", entryAt: 0, settleAt: 60_000 }, deadline: Date.now() + 30_000 },
    });
    // A fresh element per render — reusing one lets React bail out and never
    // re-read the mocked hooks.
    const ui = () => (
      <MemoryRouter initialEntries={["/"]}>
        <Routes><Route path="/" element={<LandingPage />} /></Routes>
      </MemoryRouter>
    );
    const { rerender } = render(ui());
    streamState = { ...streamState, featured: match };
    rerender(ui());
    expect(screen.getByText("NO LIVE MATCH")).toBeInTheDocument();
    expect(screen.queryByText("LIVE 1V1")).toBeNull();

    // Round (and its result hold) over → now switch.
    quickState = baseQuick({ roundInProgress: false });
    rerender(ui());
    expect(screen.getByText("LIVE 1V1")).toBeInTheDocument();
  });

  it("after a win, the handle label becomes the save-your-streak prompt", () => {
    quickState = baseQuick({
      streak: 3,
      lastSettled: { id: "c1", direction: "UP", entryPrice: "1", exitPrice: "2", outcome: "WIN", settledAt: 1 },
    });
    renderPage();
    expect(screen.getByLabelText("SAVE YOUR 3-CALL STREAK · PICK A HANDLE")).toBeInTheDocument();
  });

  it("does not show the streak prompt after a loss", () => {
    quickState = baseQuick({
      streak: 0,
      lastSettled: { id: "c1", direction: "UP", entryPrice: "2", exitPrice: "1", outcome: "LOSS", settledAt: 1 },
    });
    renderPage();
    expect(screen.getByLabelText("CLAIM YOUR HANDLE")).toBeInTheDocument();
  });

  describe("handle form", () => {
    it("checks availability, then routes into signup with the handle prefilled", async () => {
      vi.mocked(checkHandle).mockResolvedValue({ data: { ok: true, handle: "new_blood", available: true } } as never);
      const user = userEvent.setup();
      renderPage();
      await user.type(screen.getByLabelText("CLAIM YOUR HANDLE"), "new_blood");
      await waitFor(() => expect(screen.getByText("Available.")).toBeInTheDocument());
      await user.click(screen.getByRole("button", { name: "ENTER" }));
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/register?handle=new_blood"));
      expect(checkHandle).toHaveBeenCalledTimes(1); // submit reused the debounced result
    });

    it("stays put and says so when the handle is taken", async () => {
      vi.mocked(checkHandle).mockResolvedValue({ data: { ok: true, handle: "alpha_wolf", available: false, reason: "taken" } } as never);
      const user = userEvent.setup();
      renderPage();
      await user.type(screen.getByLabelText("CLAIM YOUR HANDLE"), "alpha_wolf");
      await user.click(screen.getByRole("button", { name: "ENTER" }));
      await waitFor(() => expect(screen.getByText("Taken — try another.")).toBeInTheDocument());
      expect(screen.queryByTestId("where")).toBeNull();
    });

    it("rejects a malformed handle without calling the server", async () => {
      const user = userEvent.setup();
      renderPage();
      await user.type(screen.getByLabelText("CLAIM YOUR HANDLE"), "no spaces");
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "ENTER" }));
      });
      expect(screen.getByText(/3–30 characters/)).toBeInTheDocument();
      expect(checkHandle).not.toHaveBeenCalled();
    });

    it("is keyboard-operable: Enter in the input submits", async () => {
      vi.mocked(checkHandle).mockResolvedValue({ data: { ok: true, handle: "kb_user", available: true } } as never);
      const user = userEvent.setup();
      renderPage();
      await user.tab(); // SIGN IN
      await user.tab(); // handle input
      expect(screen.getByLabelText("CLAIM YOUR HANDLE")).toHaveFocus();
      await user.keyboard("kb_user{Enter}");
      await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/register?handle=kb_user"));
    });
  });
});
