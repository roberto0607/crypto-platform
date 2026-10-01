import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Handlers = { onmessage: (m: { event: string; data: string }) => void };
let handlers: Handlers | null = null;

vi.mock("@microsoft/fetch-event-source", () => ({
  EventStreamContentType: "text/event-stream",
  fetchEventSource: (_url: string, opts: Handlers) => {
    handlers = opts;
    return new Promise(() => {});
  },
}));

import { useLandingStream, PRICE_EXPIRY_MS } from "../useLandingStream";

describe("useLandingStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers = null;
  });
  afterEach(() => vi.useRealTimers());

  const price = (symbol: string, p: string) =>
    act(() => handlers!.onmessage({ event: "price", data: JSON.stringify({ symbol, price: p }) }));

  it("does not open the stream until enabled", () => {
    renderHook(() => useLandingStream(false));
    expect(handlers).toBeNull();
  });

  it("tracks price direction and featured state", () => {
    const { result } = renderHook(() => useLandingStream(true));
    expect(result.current.featured).toBeUndefined();
    price("BTC", "100");
    price("BTC", "99");
    expect(result.current.prices.BTC).toMatchObject({ price: "99", move: "down" });
    act(() => handlers!.onmessage({ event: "featured", data: "null" }));
    expect(result.current.featured).toBeNull();
  });

  it("hides a price once the feed has been silent for 60s", () => {
    const { result } = renderHook(() => useLandingStream(true));
    price("BTC", "100");
    price("ETH", "2600");
    act(() => vi.advanceTimersByTime(PRICE_EXPIRY_MS - 10_000));
    price("ETH", "2601");
    act(() => vi.advanceTimersByTime(15_000));
    expect(result.current.prices.BTC).toBeUndefined();
    expect(result.current.prices.ETH?.price).toBe("2601");
  });
});
