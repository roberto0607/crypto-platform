import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const getPositions = vi.fn();
vi.mock("@/api/endpoints/analytics", () => ({ getPositions: (p: unknown) => getPositions(p) }));

import { useScopedPositions } from "@/hooks/useScopedPositions";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import type { Match } from "@/api/endpoints/matches";

const MATCH = { id: "m1", status: "ACTIVE" } as Match;
const rows = (...ids: string[]) => ({ data: { positions: ids.map((pair_id) => ({ pair_id })) } });
const ids = (r: { current: { positions: { pair_id: string }[] } }) => r.current.positions.map((p) => p.pair_id);

beforeEach(() => {
  getPositions.mockReset().mockImplementation(({ scope }: { scope: string }) => Promise.resolve(rows(scope)));
  useActiveMatchStore.getState().setActiveMatch(null);
});

describe("useScopedPositions", () => {
  it("names the scope on the request", async () => {
    const { result } = renderHook(() => useScopedPositions());
    await waitFor(() => expect(ids(result)).toEqual(["free"]));
    expect(getPositions).toHaveBeenCalledWith({ scope: "free" });
  });

  it("a match starting swaps the positions, with no trade needed", async () => {
    const { result } = renderHook(() => useScopedPositions());
    await waitFor(() => expect(ids(result)).toEqual(["free"]));
    act(() => useActiveMatchStore.getState().setActiveMatch(MATCH));
    await waitFor(() => expect(ids(result)).toEqual(["m1"]));
  });

  it("switching drops the old scope's rows at once", async () => {
    useActiveMatchStore.getState().setActiveMatch(MATCH);
    const { result } = renderHook(() => useScopedPositions());
    await waitFor(() => expect(ids(result)).toEqual(["m1"]));
    getPositions.mockImplementation(() => new Promise(() => {}));
    act(() => useActiveMatchStore.getState().setTradeMode("PRACTICE"));
    expect(ids(result)).toEqual([]);
  });

  it("a late answer for the old scope is dropped", async () => {
    let answer!: (v: unknown) => void;
    getPositions.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const { result } = renderHook(() => useScopedPositions());
    act(() => useActiveMatchStore.getState().setActiveMatch(MATCH));
    await waitFor(() => expect(ids(result)).toEqual(["m1"]));
    await act(async () => { answer(rows("free")); });
    expect(ids(result)).toEqual(["m1"]);
  });

  it("a fill refreshes", async () => {
    const { result } = renderHook(() => useScopedPositions());
    await waitFor(() => expect(ids(result)).toEqual(["free"]));
    getPositions.mockResolvedValue(rows("after"));
    await act(async () => { window.dispatchEvent(new CustomEvent("sse:trade.created")); });
    await waitFor(() => expect(ids(result)).toEqual(["after"]));
  });
});
