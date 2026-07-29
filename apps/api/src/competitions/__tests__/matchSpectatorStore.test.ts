/**
 * matchSpectatorStore.test.ts — in-memory path (no REDIS_URL in test env, so
 * getRedis() returns null and every call exercises InMemorySpectatorStore).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  addSpectator,
  removeSpectator,
  getSpectatorCount,
  __resetSpectatorStoreForTest,
} from "../matchSpectatorStore";

const MATCH_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MATCH_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const USER_1 = "11111111-1111-1111-1111-111111111111";
const USER_2 = "22222222-2222-2222-2222-222222222222";

describe("matchSpectatorStore (in-memory fallback)", () => {
  beforeEach(() => {
    __resetSpectatorStoreForTest();
  });

  it("starts at zero for an unknown match", async () => {
    expect(await getSpectatorCount(MATCH_A)).toBe(0);
  });

  it("increments on add, decrements on remove", async () => {
    expect(await addSpectator(MATCH_A, USER_1)).toBe(1);
    expect(await addSpectator(MATCH_A, USER_2)).toBe(2);
    expect(await getSpectatorCount(MATCH_A)).toBe(2);

    expect(await removeSpectator(MATCH_A, USER_1)).toBe(1);
    expect(await getSpectatorCount(MATCH_A)).toBe(1);
  });

  it("adding the same user twice does not double-count (it's a set)", async () => {
    await addSpectator(MATCH_A, USER_1);
    expect(await addSpectator(MATCH_A, USER_1)).toBe(1);
  });

  it("removing a user not in the set is a no-op that returns the current count", async () => {
    await addSpectator(MATCH_A, USER_1);
    expect(await removeSpectator(MATCH_A, USER_2)).toBe(1);
  });

  it("keeps separate counts per match", async () => {
    await addSpectator(MATCH_A, USER_1);
    await addSpectator(MATCH_B, USER_1);
    await addSpectator(MATCH_B, USER_2);

    expect(await getSpectatorCount(MATCH_A)).toBe(1);
    expect(await getSpectatorCount(MATCH_B)).toBe(2);
  });

  it("removing the last spectator brings the match back to zero, not undefined", async () => {
    await addSpectator(MATCH_A, USER_1);
    expect(await removeSpectator(MATCH_A, USER_1)).toBe(0);
    expect(await getSpectatorCount(MATCH_A)).toBe(0);
  });
});
