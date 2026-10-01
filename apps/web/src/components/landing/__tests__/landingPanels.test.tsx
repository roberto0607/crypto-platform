import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LiveMatchPanel from "../LiveMatchPanel";
import QuickCallPanel from "../QuickCallPanel";
import type { FeaturedMatch } from "@/api/endpoints/landing";
import type { QuickCallHook } from "@/hooks/useQuickCall";
import { nextPanel } from "@/lib/landing";

const match: FeaturedMatch = {
  matchId: "m-1",
  secondsLeft: 3723,
  spectatorCount: 12,
  challenger: { handle: "alpha_wolf", returnPct: 2.5, pnlUsd: 1250 },
  opponent: { handle: "beta_bear", returnPct: -1.25, pnlUsd: -625 },
  series: [
    { t: 1_000, challengerPct: 0, opponentPct: 0 },
    { t: 6_000, challengerPct: 1, opponentPct: -0.5 },
    { t: 11_000, challengerPct: 2.5, opponentPct: -1.25 },
  ],
  lastTrades: [
    { player: "opponent", side: "SELL", qty: "2", asset: "ETH", at: 10_000 },
    { player: "challenger", side: "BUY", qty: "0.5", asset: "BTC", at: 5_000 },
  ],
};

function quick(overrides: Partial<QuickCallHook> = {}): QuickCallHook {
  return {
    sessionReady: true,
    round: null,
    streak: 0,
    history: [],
    lastSettled: null,
    roundInProgress: false,
    error: null,
    placing: false,
    place: vi.fn(async () => {}),
    applyStreamResult: vi.fn(),
    ...overrides,
  };
}

const notify = { supported: true, enabled: false, toggle: vi.fn() };

describe("nextPanel (switch rule)", () => {
  it("shows idle when no match is live", () => {
    expect(nextPanel("idle", false, false)).toBe("idle");
    expect(nextPanel("live", false, false)).toBe("idle");
  });

  it("switches to live when a match goes live and no round is running", () => {
    expect(nextPanel("idle", true, false)).toBe("live");
  });

  it("finishes the running round before switching", () => {
    expect(nextPanel("idle", true, true)).toBe("idle");
  });

  it("stays live once live", () => {
    expect(nextPanel("live", true, true)).toBe("live");
  });
});

describe("LiveMatchPanel", () => {
  function renderLive(m: FeaturedMatch = match) {
    return render(
      <MemoryRouter>
        <LiveMatchPanel match={m} />
      </MemoryRouter>,
    );
  }

  it("renders both players' live % and $ P&L, the clock, trades, and SPECTATE", () => {
    renderLive();
    expect(screen.getByText("LIVE 1V1")).toBeInTheDocument();
    expect(screen.getAllByText("alpha_wolf").length).toBeGreaterThan(0);
    expect(screen.getByText("+2.50%")).toBeInTheDocument();
    expect(screen.getByText("+$1,250.00")).toBeInTheDocument();
    expect(screen.getByText("−1.25%")).toBeInTheDocument();
    expect(screen.getByText("−$625.00")).toBeInTheDocument();
    expect(screen.getByText(/01:02:03/)).toBeInTheDocument();
    expect(screen.getByText("12 watching")).toBeInTheDocument();
    expect(screen.getByText("2 ETH")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SPECTATE" })).toHaveAttribute("href", "/matches/m-1/spectate");
  });

  it("draws a solid accent line and a dashed amber line, with a marker per in-range trade", () => {
    renderLive();
    expect(screen.getByTestId("line-challenger")).toHaveAttribute("stroke", "#7CFF5B");
    expect(screen.getByTestId("line-challenger")).not.toHaveAttribute("stroke-dasharray");
    expect(screen.getByTestId("line-opponent")).toHaveAttribute("stroke", "#F2B84B");
    expect(screen.getByTestId("line-opponent")).toHaveAttribute("stroke-dasharray");
    expect(screen.getAllByTestId("trade-marker")).toHaveLength(2);
  });

  it("pins a fill just before the first P&L point to the chart's left edge, and drops older ones", () => {
    renderLive({
      ...match,
      lastTrades: [
        { player: "challenger", side: "BUY", qty: "1", asset: "BTC", at: 1_000 - 5_000 },
        { player: "opponent", side: "SELL", qty: "1", asset: "ETH", at: 1_000 - 60_000 },
      ],
    });
    expect(screen.getAllByTestId("trade-marker")).toHaveLength(1);
  });

  it("hides returns, $ P&L, the chart, and trades the backend didn't provide", () => {
    const { container } = renderLive({
      ...match,
      challenger: { handle: null, returnPct: null, pnlUsd: null },
      opponent: { handle: null, returnPct: null, pnlUsd: null },
      series: [],
      lastTrades: [],
    });
    expect(container.textContent).not.toMatch(/%/);
    expect(container.textContent).not.toMatch(/\$/);
    expect(container.querySelector("svg[role='img']")).toBeNull();
    expect(screen.queryByText("LAST TRADES")).toBeNull();
    // Role labels, never an email or a made-up name.
    expect(screen.getByText("Challenger")).toBeInTheDocument();
    expect(screen.getByText("Opponent")).toBeInTheDocument();
  });
});

describe("QuickCallPanel (idle)", () => {
  it("renders the idle state: badge, question, price, UP/DOWN, streak meter", () => {
    render(<QuickCallPanel btc={{ price: "84000.5", move: null, at: 0 }} quick={quick({ streak: 2 })} notify={notify} reducedMotion={false} />);
    expect(screen.getByText("NO LIVE MATCH")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Where's BTC in 60 seconds?" })).toBeInTheDocument();
    expect(screen.getByText("$84,000.50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /UP/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /DOWN/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /NOTIFY ME/ })).toHaveAttribute("aria-pressed", "false");
    const pips = screen.getAllByTestId("streak-pip");
    expect(pips).toHaveLength(5);
    expect(pips.filter((p) => p.dataset.filled === "true")).toHaveLength(2);
  });

  it("hides the price (no placeholder) and disables calls until a BTC price arrives", () => {
    const { container } = render(<QuickCallPanel btc={undefined} quick={quick()} notify={notify} reducedMotion={false} />);
    expect(container.textContent).not.toMatch(/\$/);
    expect(screen.getByRole("button", { name: /UP/ })).toBeDisabled();
  });

  it("locks UP/DOWN during a round and shows entry + countdown", () => {
    const round = {
      call: { id: "c1", direction: "UP" as const, entryPrice: "84000", entryAt: 0, settleAt: 60_000 },
      deadline: Date.now() + 42_000,
    };
    render(<QuickCallPanel btc={{ price: "84010", move: "up", at: 0 }} quick={quick({ round, roundInProgress: true })} notify={notify} reducedMotion />);
    expect(screen.getByRole("button", { name: /UP/ })).toBeDisabled();
    expect(screen.getByText(/42s · UP from \$84,000\.00/)).toBeInTheDocument();
  });

  it("shows the last settled rounds, newest first", () => {
    const history = (["WIN", "LOSS", "PUSH", "VOID"] as const).map((outcome, i) => ({
      id: `c${i}`, direction: "UP" as const, entryPrice: "1", exitPrice: outcome === "VOID" ? null : "2", outcome, settledAt: i,
    }));
    render(<QuickCallPanel btc={undefined} quick={quick({ history })} notify={notify} reducedMotion={false} />);
    const list = screen.getByRole("list", { name: /Recent rounds/ });
    expect(within(list).getAllByTestId("round-pip").map((p) => p.getAttribute("aria-label"))).toEqual([
      "UP call, win", "UP call, loss", "UP call, push", "UP call, void",
    ]);
  });

  it("omits the NOTIFY ME toggle when the browser can't notify", () => {
    render(<QuickCallPanel btc={undefined} quick={quick()} notify={{ ...notify, supported: false }} reducedMotion={false} />);
    expect(screen.queryByRole("button", { name: /NOTIFY ME/ })).toBeNull();
  });
});
