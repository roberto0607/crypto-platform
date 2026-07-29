/**
 * matchSpectatorStore.ts — tracks which userIds are currently spectating each
 * match, for the live "N watching" count.
 *
 * Redis-backed (SET per match) when REDIS_URL is configured, so the count is
 * correct across multiple API instances — mirrors market/snapshotStore.ts's
 * Redis/in-memory dual-implementation pattern. Falls back to an in-process
 * Map for local dev/tests where Redis isn't configured (single instance, so
 * no cross-instance correctness concern).
 */

import type Redis from "ioredis";
import { getRedis } from "../db/redis.js";

// Safety TTL so a set never lingers forever if cleanup is somehow missed
// (e.g. a hard process crash between addSpectator and the disconnect
// handler running) — refreshed on every add.
const SPECTATOR_SET_TTL_SECONDS = 60 * 60 * 12;

interface SpectatorStore {
  add(matchId: string, userId: string): Promise<number>;
  remove(matchId: string, userId: string): Promise<number>;
  count(matchId: string): Promise<number>;
}

class RedisSpectatorStore implements SpectatorStore {
  constructor(private redis: Redis) {}

  private key(matchId: string): string {
    return `spectators:${matchId}`;
  }

  async add(matchId: string, userId: string): Promise<number> {
    const key = this.key(matchId);
    const pipeline = this.redis.pipeline();
    pipeline.sadd(key, userId);
    pipeline.expire(key, SPECTATOR_SET_TTL_SECONDS);
    pipeline.scard(key);
    const results = await pipeline.exec();
    const scardResult = results?.[2];
    return (scardResult?.[1] as number) ?? 0;
  }

  async remove(matchId: string, userId: string): Promise<number> {
    const key = this.key(matchId);
    await this.redis.srem(key, userId);
    return this.redis.scard(key);
  }

  async count(matchId: string): Promise<number> {
    return this.redis.scard(this.key(matchId));
  }
}

class InMemorySpectatorStore implements SpectatorStore {
  private store = new Map<string, Set<string>>();

  async add(matchId: string, userId: string): Promise<number> {
    if (!this.store.has(matchId)) this.store.set(matchId, new Set());
    this.store.get(matchId)!.add(userId);
    return this.store.get(matchId)!.size;
  }

  async remove(matchId: string, userId: string): Promise<number> {
    const set = this.store.get(matchId);
    if (!set) return 0;
    set.delete(userId);
    if (set.size === 0) this.store.delete(matchId);
    return set.size;
  }

  async count(matchId: string): Promise<number> {
    return this.store.get(matchId)?.size ?? 0;
  }
}

let _instance: SpectatorStore | null = null;

function getInstance(): SpectatorStore {
  if (!_instance) {
    const redis = getRedis();
    _instance = redis ? new RedisSpectatorStore(redis) : new InMemorySpectatorStore();
  }
  return _instance;
}

export async function addSpectator(matchId: string, userId: string): Promise<number> {
  return getInstance().add(matchId, userId);
}

export async function removeSpectator(matchId: string, userId: string): Promise<number> {
  return getInstance().remove(matchId, userId);
}

export async function getSpectatorCount(matchId: string): Promise<number> {
  return getInstance().count(matchId);
}

/**
 * TEST-ONLY — do not call from production code paths.
 *
 * Resets the lazy singleton so tests can force re-derivation between runs
 * (e.g. after injecting/clearing a test Redis client via setRedis()).
 */
export function __resetSpectatorStoreForTest(): void {
  _instance = null;
}
