import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useTradingStore } from "@/stores/tradingStore";
import { usePairPricesStore } from "@/stores/pairPricesStore";
import { useDailyOpenStore } from "@/stores/dailyOpenStore";
import AssetTab from "@/components/trading/AssetTab";

const PAIR = "p1";

// Seed real stores so usePairChange yields a deterministic day-%: price 96 vs
// open 100 → -4.00% ("down"). setDailyOpen stamps today's UTC date, which is
// the same clock usePairChange reads, so the change resolves (not null).
beforeEach(() => {
  useTradingStore.setState({ snapshot: null });
  usePairPricesStore.setState({ prices: { [PAIR]: 96 } });
  useDailyOpenStore.setState({ opens: {} });
  useDailyOpenStore.getState().setDailyOpen(PAIR, 100);
});

describe("AssetTab", () => {
  it("active chip hides the price span but keeps symbol + day-% (kills triple-BTC echo)", () => {
    const { container } = render(
      <AssetTab pairId={PAIR} symbol="BTC/USD" isActive />,
    );
    expect(container.querySelector(".tr-at-price")).toBeNull();
    expect(screen.getByText("BTC")).toBeInTheDocument();
    expect(screen.getByText("-4.00%")).toBeInTheDocument();
  });

  it("inactive chip shows the price span and the day-%", () => {
    const { container } = render(
      <AssetTab pairId={PAIR} symbol="BTC/USD" isActive={false} />,
    );
    const priceSpan = container.querySelector(".tr-at-price");
    expect(priceSpan).not.toBeNull();
    expect(priceSpan?.textContent).toContain("96.00");
    expect(screen.getByText("BTC")).toBeInTheDocument();
    expect(screen.getByText("-4.00%")).toBeInTheDocument();
  });
});
