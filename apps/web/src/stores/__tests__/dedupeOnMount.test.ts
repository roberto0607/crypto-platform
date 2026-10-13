import { describe, it, expect, vi, beforeEach } from "vitest";

// Several components mounting together used to fire the same GET once each,
// all counting against the 200/min rate limit (QA 2026-10-11 P1).

const getActiveMatch = vi.fn(async () => ({ data: { ok: true, match: null } }));
const listNotifications = vi.fn(async () => ({ data: { notifications: [], unreadCount: 0 } }));
const getUserTier = vi.fn(async () => ({ data: { tier: "BRONZE", eloRating: 1000 } }));
const listTriggers = vi.fn(async () => ({ data: { data: [] } }));

vi.mock("@/api/endpoints/matches", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoints/matches")>()),
  getActiveMatch: () => getActiveMatch(),
}));
vi.mock("@/api/endpoints/notifications", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoints/notifications")>()),
  listNotifications: () => listNotifications(),
}));
vi.mock("@/api/endpoints/competitions", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoints/competitions")>()),
  getUserTier: () => getUserTier(),
}));
vi.mock("@/api/endpoints/triggers", async (orig) => ({
  ...(await orig<typeof import("@/api/endpoints/triggers")>()),
  listTriggers: () => listTriggers(),
}));

const { useActiveMatchStore } = await import("@/stores/activeMatchStore");
const { useNotificationStore } = await import("@/stores/notificationStore");
const { useCompetitionStore } = await import("@/stores/competitionStore");
const { useTradingStore } = await import("@/stores/tradingStore");

describe("mount-time fetches are shared, not repeated", () => {
  beforeEach(() => vi.clearAllMocks());

  it("three useCompetitionMode() mounts → one GET /v1/matches/active", async () => {
    const s = useActiveMatchStore.getState();
    await Promise.all([s.refreshMatch(), s.refreshMatch(), s.refreshMatch()]);
    expect(getActiveMatch).toHaveBeenCalledTimes(1);
  });

  it("App init + NotificationBell → one GET /v1/notifications", async () => {
    const s = useNotificationStore.getState();
    await Promise.all([s.fetch(), s.fetch()]);
    expect(listNotifications).toHaveBeenCalledTimes(1);
  });

  it("App init + ProfilePage → one GET /v1/profile/tier", async () => {
    const s = useCompetitionStore.getState();
    await Promise.all([s.fetchUserTier(), s.fetchUserTier()]);
    expect(getUserTier).toHaveBeenCalledTimes(1);
  });

  it("selectPair + UnifiedOrderPanel → one GET /v1/triggers", async () => {
    useTradingStore.setState({ selectedPairId: "btc" });
    const s = useTradingStore.getState();
    await Promise.all([s.refreshTriggers(), s.refreshTriggers()]);
    expect(listTriggers).toHaveBeenCalledTimes(1);
  });
});
