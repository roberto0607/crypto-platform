import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const api = vi.hoisted(() => ({
  getActiveMatch: vi.fn(),
  getMatch: vi.fn(),
  forfeitMatch: vi.fn(),
}));
vi.mock("@/api/endpoints/matches", () => api);

import {
  useActiveMatchStore,
  matchPnl,
  acquireActiveMatchPolling,
  releaseActiveMatchPolling,
} from "@/stores/activeMatchStore";
import type { Match } from "@/api/endpoints/matches";

const HOUR = 3_600_000;
const match = (over: Partial<Match> = {}) => ({
  id: "m1", status: "ACTIVE", challenger_id: "me", opponent_id: "opp",
  challenger_pnl_pct: "1.5", opponent_pnl_pct: "-2", winner_id: null, forfeit_user_id: null, elo_delta: null,
  ends_at: new Date(Date.now() + HOUR).toISOString(), ...over,
}) as Match;
const active = (m: Match | null) => ({ data: { ok: true, match: m } });
const fire = (type: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(type, { detail }));
const state = () => useActiveMatchStore.getState();
/** Past the 100 ms coalesce window, so the next refresh is its own request. */
const settle = async (ms = 150) => { await vi.advanceTimersByTimeAsync(ms); };

const ENDED = {
  matchId: "m1", reason: "timeout", winnerUserId: "me", forfeitUserId: null,
  challengerPnlPct: "3.25", opponentPnlPct: "-1.5", eloDeltas: { winner: 12 },
};

beforeEach(() => {
  vi.useFakeTimers();
  api.getActiveMatch.mockReset().mockResolvedValue(active(null));
  api.getMatch.mockReset();
  api.forfeitMatch.mockReset().mockResolvedValue({});
  state().setActiveMatch(null);
  acquireActiveMatchPolling();
});

afterEach(() => {
  releaseActiveMatchPolling();
  state().setActiveMatch(null);
  vi.useRealTimers();
});

describe("a failed poll", () => {
  it("keeps the match", async () => {
    state().setActiveMatch(match());
    api.getActiveMatch.mockRejectedValue(new Error("offline"));
    await state().refreshMatch();
    expect(state().activeMatch?.id).toBe("m1");
    expect(state().isInCompetition).toBe(true);
    expect(state().endedMatch).toBeNull();
  });

  it("keeps the live P&L", async () => {
    state().setActiveMatch(match());
    fire("sse:match.pnl.update", { matchId: "m1", challengerPnlPct: "9", opponentPnlPct: "1" });
    api.getActiveMatch.mockRejectedValue(new Error("offline"));
    await state().refreshMatch();
    expect(matchPnl(state().activeMatch!, state().livePnl).challengerPnlPct).toBe("9");
  });

  it("recovers on the next good poll", async () => {
    api.getActiveMatch.mockRejectedValueOnce(new Error("offline"));
    await state().refreshMatch();
    expect(state().activeMatch).toBeNull();
    await settle();
    api.getActiveMatch.mockResolvedValue(active(match()));
    await state().refreshMatch();
    expect(state().activeMatch?.id).toBe("m1");
  });
});

describe("live P&L", () => {
  it("right after a reload: the read's numbers, before any push", async () => {
    api.getActiveMatch.mockResolvedValue(active(match({ challenger_pnl_pct: "-0.00076358" })));
    await state().refreshMatch();
    expect(matchPnl(state().activeMatch!, state().livePnl).challengerPnlPct).toBe("-0.00076358");
  });

  it("a push beats the read", () => {
    state().setActiveMatch(match());
    fire("sse:match.pnl.update", { matchId: "m1", challengerPnlPct: "9", opponentPnlPct: "1" });
    expect(matchPnl(state().activeMatch!, state().livePnl)).toEqual({ challengerPnlPct: "9", opponentPnlPct: "1" });
  });

  it("a poll doesn't overwrite a push with an older number", async () => {
    state().setActiveMatch(match());
    fire("sse:match.pnl.update", { matchId: "m1", challengerPnlPct: "9", opponentPnlPct: "1" });
    api.getActiveMatch.mockResolvedValue(active(match()));
    await state().refreshMatch();
    expect(matchPnl(state().activeMatch!, state().livePnl).challengerPnlPct).toBe("9");
  });

  it("ignores another match's push (spectating)", () => {
    state().setActiveMatch(match());
    fire("sse:match.pnl.update", { matchId: "other", challengerPnlPct: "9", opponentPnlPct: "1" });
    expect(state().livePnl).toBeNull();
  });

  it("doesn't leak into the next match", () => {
    state().setActiveMatch(match());
    fire("sse:match.pnl.update", { matchId: "m1", challengerPnlPct: "9", opponentPnlPct: "1" });
    state().setActiveMatch(match({ id: "m2" }));
    expect(state().livePnl).toBeNull();
  });
});

describe("match end", () => {
  it("match.ended: the verdict at once, from the push", () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", ENDED);
    expect(state().endedMatch).toMatchObject({
      id: "m1", status: "COMPLETED", winner_id: "me", challenger_pnl_pct: "3.25", opponent_pnl_pct: "-1.5", elo_delta: 12,
    });
    expect(state().activeMatch).toBeNull();
    expect(state().isInCompetition).toBe(false);
  });

  it("match.ended for a forfeit", () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", { ...ENDED, reason: "forfeit", winnerUserId: "opp", forfeitUserId: "me" });
    expect(state().endedMatch).toMatchObject({ status: "FORFEITED", forfeit_user_id: "me" });
  });

  it("match.ended for a spectated match changes nothing", () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", { ...ENDED, matchId: "other" });
    expect(state().endedMatch).toBeNull();
    expect(state().activeMatch?.id).toBe("m1");
  });

  it("the poll finds a push that never came", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockResolvedValue({ data: { match: match({ status: "COMPLETED", winner_id: "opp" }) } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getMatch).toHaveBeenCalledWith("m1");
    expect(state().endedMatch).toMatchObject({ status: "COMPLETED", winner_id: "opp" });
    expect(state().activeMatch).toBeNull();
  });

  it("the refetch after a reconnect finds it too", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockResolvedValue({ data: { match: match({ status: "FORFEITED", winner_id: "me" }) } });
    fire("sse:reconnected");
    await settle();
    expect(state().endedMatch).toMatchObject({ status: "FORFEITED" });
  });

  it("the result can't be read yet: the match stays for the next poll", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockRejectedValue(new Error("offline"));
    await state().refreshMatch();
    expect(state().activeMatch?.id).toBe("m1");
    expect(state().endedMatch).toBeNull();
  });

  it("a cancelled match has no result to show", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockResolvedValue({ data: { match: match({ status: "CANCELLED" }) } });
    await state().refreshMatch();
    expect(state().activeMatch).toBeNull();
    expect(state().endedMatch).toBeNull();
  });

  it("a poll that left before the end can't bring the match back", async () => {
    state().setActiveMatch(match());
    let answer!: (v: unknown) => void;
    api.getActiveMatch.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const inFlight = state().refreshMatch();
    fire("sse:match.ended", ENDED);
    answer(active(match()));
    await inFlight;
    expect(state().activeMatch).toBeNull();
    expect(state().endedMatch?.status).toBe("COMPLETED");
  });

  it("not after the result is dismissed either", async () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", ENDED);
    state().dismissEndedMatch();
    await settle();
    api.getActiveMatch.mockResolvedValue(active(match()));
    await state().refreshMatch();
    expect(state().activeMatch).toBeNull();
    expect(state().endedMatch).toBeNull();
  });

  it("dismissing leaves a new match alone", () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", ENDED);
    state().setActiveMatch(match({ id: "m2" }));
    state().dismissEndedMatch();
    expect(state().activeMatch?.id).toBe("m2");
    expect(state().endedMatch).toBeNull();
  });

  it("logout clears the result", () => {
    state().setActiveMatch(match());
    fire("sse:match.ended", ENDED);
    state().setActiveMatch(null);
    expect(state().endedMatch).toBeNull();
  });
});

describe("settling", () => {
  const endsIn = (ms: number) => match({ ends_at: new Date(Date.now() + ms).toISOString() });

  it("starts at ends_at, with no result shown", async () => {
    api.getActiveMatch.mockResolvedValue(active(endsIn(1_000)));
    state().setActiveMatch(endsIn(1_000));
    expect(state().settling).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state().settling).toBe(true);
    expect(state().endedMatch).toBeNull();
    expect(state().activeMatch?.id).toBe("m1");
  });

  it("a page opened after ends_at is settling at once", () => {
    state().setActiveMatch(endsIn(-5_000));
    expect(state().settling).toBe(true);
  });

  it("asks for the result every few seconds, and stops once it has it", async () => {
    const late = endsIn(-5_000);
    api.getActiveMatch.mockResolvedValue(active(late));
    state().setActiveMatch(late);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.getActiveMatch).toHaveBeenCalledTimes(1);

    api.getActiveMatch.mockResolvedValue(active(null));
    api.getMatch.mockResolvedValue({ data: { match: match({ status: "COMPLETED", winner_id: "me" }) } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state().settling).toBe(false);
    expect(state().endedMatch?.status).toBe("COMPLETED");

    api.getActiveMatch.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(api.getActiveMatch).not.toHaveBeenCalled();
  });

  it("ends on match.ended", () => {
    state().setActiveMatch(endsIn(-5_000));
    fire("sse:match.ended", ENDED);
    expect(state().settling).toBe(false);
    expect(state().endedMatch?.status).toBe("COMPLETED");
  });

  it("a failed poll doesn't end it", async () => {
    state().setActiveMatch(endsIn(-5_000));
    api.getActiveMatch.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state().settling).toBe(true);
  });

  it("the next match starts clean", () => {
    state().setActiveMatch(endsIn(-5_000));
    state().setActiveMatch(match({ id: "m2" }));
    expect(state().settling).toBe(false);
  });
});

describe("forfeit", () => {
  it("shows the full row as the result", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockResolvedValue({ data: { match: match({ status: "FORFEITED", forfeit_user_id: "me", winner_id: "opp" }) } });
    await state().forfeit("m1");
    expect(api.forfeitMatch).toHaveBeenCalledWith("m1");
    expect(state().endedMatch).toMatchObject({ status: "FORFEITED", forfeit_user_id: "me" });
    expect(state().activeMatch).toBeNull();
  });

  it("a refused forfeit rejects and changes nothing", async () => {
    state().setActiveMatch(match());
    api.forfeitMatch.mockRejectedValue(new Error("refused"));
    await expect(state().forfeit("m1")).rejects.toThrow("refused");
    expect(state().activeMatch?.id).toBe("m1");
    expect(state().endedMatch).toBeNull();
  });

  it("forfeited but the row can't be read: no error, the result arrives by push", async () => {
    state().setActiveMatch(match());
    api.getMatch.mockRejectedValue(new Error("offline"));
    await expect(state().forfeit("m1")).resolves.toBeUndefined();
  });
});
