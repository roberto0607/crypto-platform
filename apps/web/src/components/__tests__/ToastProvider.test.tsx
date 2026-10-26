/**
 * ToastProvider's SSE toasts. A liquidation (position.liquidated) gets an
 * error toast naming the pair, leverage, side, fill price and the margin
 * returned (leverage PR 6b).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import ToastProvider, { liquidationMessage } from "@/components/ToastProvider";
import { useAppStore } from "@/stores/appStore";
import type { PositionLiquidatedEvent, TradingPair } from "@/types/api";

const PAIR = { id: "p1", symbol: "BTC/USD" } as TradingPair;

const liquidated = (over: Partial<PositionLiquidatedEvent> = {}): PositionLiquidatedEvent => ({
  liquidationId: "l1", orderId: "o1", pairId: "p1", competitionId: null, matchId: null, side: "LONG",
  qty: "0.00602409", entryPrice: "83000", leverage: "10.00", margin: "49.99994700", liqPrice: "75075.37688442",
  markPrice: "75070", fillPrice: "75060.00000000", realizedPnl: "-47.83", fee: "0.23", returnedEquity: "1.94000000",
  shortfall: "0.00000000", ...over,
} as PositionLiquidatedEvent);

beforeEach(() => {
  useAppStore.setState({ pairs: [PAIR] });
});

describe("liquidationMessage", () => {
  it("names the pair, leverage, side, fill and what came back", () => {
    expect(liquidationMessage(liquidated(), "BTC/USD"))
      .toBe("BTC/USD 10x LONG liquidated at $75,060.00. $1.94 margin returned.");
  });

  it("a gap past bankruptcy: nothing returned, said plainly", () => {
    expect(liquidationMessage(liquidated({ returnedEquity: "0.00000000", shortfall: "4.22" }), "BTC/USD"))
      .toBe("BTC/USD 10x LONG liquidated at $75,060.00. The price gapped past bankruptcy: the margin was lost, nothing more.");
  });
});

describe("the sse:position.liquidated toast", () => {
  it("shows it", () => {
    render(<ToastProvider><div /></ToastProvider>);
    act(() => { window.dispatchEvent(new CustomEvent("sse:position.liquidated", { detail: liquidated() })); });
    expect(screen.getByText("BTC/USD 10x LONG liquidated at $75,060.00. $1.94 margin returned.")).toBeTruthy();
  });
});

/**
 * Bug (QA, 2026-10): "Position closed" showed twice. Closing a position with a
 * TP/SL pair cancels both legs; the server (correctly) sends one
 * trigger.canceled per trigger, in the same instant, and each became a toast.
 */
describe("trigger.canceled toasts", () => {
  afterEach(() => vi.useRealTimers());
  const canceled = (triggerId: string, reason: string, pairId = "p1") =>
    act(() => { window.dispatchEvent(new CustomEvent("sse:trigger.canceled", { detail: { triggerId, pairId, reason } })); });

  it("both legs of a TP/SL canceled by one close: one 'Position closed' toast", () => {
    render(<ToastProvider><div /></ToastProvider>);
    canceled("tp", "position_closed");
    canceled("sl", "position_closed");
    expect(screen.getAllByText(/Position closed/)).toHaveLength(1);
  });

  it("the same for match end", () => {
    render(<ToastProvider><div /></ToastProvider>);
    canceled("tp", "match_ended");
    canceled("sl", "match_ended");
    expect(screen.getAllByText(/Match ended/)).toHaveLength(1);
  });

  it("different pairs, or a later close, still each get their toast", () => {
    vi.useFakeTimers();
    render(<ToastProvider><div /></ToastProvider>);
    canceled("a", "position_closed", "p1");
    canceled("b", "position_closed", "p2");
    expect(screen.getAllByText(/Position closed/)).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(6000); }); // both toasts expire
    canceled("c", "position_closed", "p1");
    expect(screen.getAllByText(/Position closed/)).toHaveLength(1);
  });

  it("other reasons are per trigger, unchanged", () => {
    render(<ToastProvider><div /></ToastProvider>);
    canceled("a", "no_position");
    canceled("b", "no_position");
    expect(screen.getAllByText(/fired with no position/)).toHaveLength(2);
  });
});

