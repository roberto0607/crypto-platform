import { describe, it, expect, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({
  listOrders: vi.fn(),
  listTriggers: vi.fn(),
}));
vi.mock("@/api/endpoints/trading", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints/trading")>()),
  listOrders: api.listOrders,
}));
vi.mock("@/api/endpoints/triggers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/endpoints/triggers")>()),
  listTriggers: api.listTriggers,
}));

import { useTradingStore } from "@/stores/tradingStore";
import { useActiveMatchStore } from "@/stores/activeMatchStore";
import type { Match } from "@/api/endpoints/matches";

const LIVE = { id: "m1", status: "ACTIVE" } as Match;
const PENDING = { id: "m1", status: "PENDING" } as Match;
const flush = () => new Promise((r) => setTimeout(r, 0));

function ordersResp(...ids: string[]) {
  return { data: { ok: true, orders: ids.map((id) => ({ id })), nextCursor: null } };
}
function triggersResp(...ids: string[]) {
  return { data: { data: ids.map((id) => ({ id })), nextCursor: null } };
}

beforeEach(() => {
  api.listOrders.mockReset().mockResolvedValue(ordersResp());
  api.listTriggers.mockReset().mockResolvedValue(triggersResp());
  useActiveMatchStore.setState({ activeMatch: null, isInCompetition: false });
  useTradingStore.setState({ selectedPairId: "p1", openOrders: [], activeTriggers: [] });
});

describe("open orders and triggers name their scope", () => {
  it("free-play: the request says free", async () => {
    await useTradingStore.getState().refreshOpenOrders();
    await useTradingStore.getState().refreshTriggers();
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "free" }));
    expect(api.listTriggers).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "free" }));
  });

  it("in a live match: the request names the match", async () => {
    useActiveMatchStore.getState().setActiveMatch(LIVE);
    await flush();
    api.listOrders.mockClear();
    api.listTriggers.mockClear();
    await useTradingStore.getState().refreshOpenOrders();
    await useTradingStore.getState().refreshTriggers();
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "m1" }));
    expect(api.listTriggers).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "m1" }));
  });

  it("a PENDING challenge is still free-play", async () => {
    useActiveMatchStore.getState().setActiveMatch(PENDING);
    await useTradingStore.getState().refreshOpenOrders();
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "free" }));
  });
});

describe("when the scope changes", () => {
  it("a match starting drops the free-play rows and loads the match's", async () => {
    useTradingStore.setState({ openOrders: [{ id: "free-o" }], activeTriggers: [{ id: "free-t" }] } as never);
    api.listOrders.mockResolvedValue(ordersResp("match-o"));
    api.listTriggers.mockResolvedValue(triggersResp("match-t"));

    useActiveMatchStore.getState().setActiveMatch(LIVE);
    expect(useTradingStore.getState().openOrders).toEqual([]);
    expect(useTradingStore.getState().activeTriggers).toEqual([]);

    await flush();
    expect(useTradingStore.getState().openOrders.map((o) => o.id)).toEqual(["match-o"]);
    expect(useTradingStore.getState().activeTriggers.map((t) => t.id)).toEqual(["match-t"]);
  });

  it("a match ending goes back to free-play", async () => {
    useActiveMatchStore.getState().setActiveMatch(LIVE);
    await flush();
    api.listOrders.mockClear();
    useActiveMatchStore.getState().setActiveMatch(null);
    await flush();
    expect(api.listOrders).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "free" }));
  });

  it("an answer for the old scope is dropped", async () => {
    let answer!: (v: unknown) => void;
    api.listOrders.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const inFlight = useTradingStore.getState().refreshOpenOrders();

    api.listOrders.mockResolvedValue(ordersResp("match-o"));
    useActiveMatchStore.getState().setActiveMatch(LIVE);
    await flush();
    answer(ordersResp("free-o"));
    await inFlight;
    expect(useTradingStore.getState().openOrders.map((o) => o.id)).toEqual(["match-o"]);
  });

  it("an unrelated store update refetches nothing", async () => {
    useActiveMatchStore.getState().setActiveMatch(LIVE);
    await flush();
    api.listOrders.mockClear();
    useActiveMatchStore.getState().setActiveMatch({ ...LIVE, ends_at: "2030-01-01" });
    await flush();
    expect(api.listOrders).not.toHaveBeenCalled();
  });
});
