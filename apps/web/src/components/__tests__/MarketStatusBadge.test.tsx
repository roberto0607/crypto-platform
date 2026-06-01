import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketStatusBadge } from "@/components/MarketStatusBadge";

function renderBadge(
  props: Partial<React.ComponentProps<typeof MarketStatusBadge>> = {},
) {
  return render(
    <MarketStatusBadge
      status="connected"
      priceStale={false}
      isHardOffline={false}
      onRefresh={() => {}}
      {...props}
    />,
  );
}

describe("MarketStatusBadge", () => {
  it("renders a neutral dot and no status label while initializing", () => {
    const { container } = renderBadge({ status: "initializing" });
    // No alarming/connecting text during the cold-load grace window.
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument();
    expect(screen.queryByText("MARKETS LIVE")).not.toBeInTheDocument();
    expect(screen.queryByText("CONNECTING...")).not.toBeInTheDocument();
    expect(screen.queryByText("RECONNECTING...")).not.toBeInTheDocument();
    // The status dot is still present.
    expect(container.querySelector("span.rounded-full")).toBeInTheDocument();
  });

  it("renders 'CONNECTING...' while connecting", () => {
    renderBadge({ status: "connecting" });
    expect(screen.getByText("CONNECTING...")).toBeInTheDocument();
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument();
  });

  it("renders green 'MARKETS LIVE' when connected", () => {
    renderBadge({ status: "connected" });
    expect(screen.getByText("MARKETS LIVE")).toBeInTheDocument();
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument();
  });

  it("renders 'RECONNECTING...' while reconnecting", () => {
    renderBadge({ status: "reconnecting" });
    expect(screen.getByText("RECONNECTING...")).toBeInTheDocument();
    expect(screen.queryByText("OFFLINE")).not.toBeInTheDocument();
  });

  it("renders red 'OFFLINE' plus a REFRESH button when disconnected, and fires onRefresh", async () => {
    const onRefresh = vi.fn();
    renderBadge({ status: "disconnected", onRefresh });
    expect(screen.getByText("OFFLINE")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "REFRESH" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("shows 'RECONNECTING...' when connected but the price feed is stale", () => {
    renderBadge({ status: "connected", priceStale: true });
    expect(screen.getByText("RECONNECTING...")).toBeInTheDocument();
    expect(screen.queryByText("MARKETS LIVE")).not.toBeInTheDocument();
  });

  it("shows OFFLINE plus a REFRESH button when hard-offline, and fires onRefresh", async () => {
    const onRefresh = vi.fn();
    renderBadge({ status: "reconnecting", isHardOffline: true, onRefresh });
    expect(screen.getByText("OFFLINE")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "REFRESH" });
    await userEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
