/**
 * ToastProvider's SSE toasts. A liquidation (position.liquidated) gets an
 * error toast naming the pair, leverage, side, fill price and the margin
 * returned (leverage PR 6b).
 */
import { describe, it, expect, beforeEach } from "vitest";
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
