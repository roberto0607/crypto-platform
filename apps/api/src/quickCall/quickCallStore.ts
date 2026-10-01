/**
 * quickCallStore.ts — per-identity quick-call state: the one open call, the
 * streak, and the last settled rounds; plus the per-IP hourly counter.
 *
 * Redis-backed when REDIS_URL is configured (correct across API instances),
 * in-process fallback otherwise — mirrors market/snapshotStore.ts.
 */

import type Redis from "ioredis";
import { getRedis } from "../db/redis";

export type Direction = "UP" | "DOWN";
export type Outcome = "WIN" | "LOSS" | "PUSH" | "VOID";

export interface OpenCall {
  id: string;
  direction: Direction;
  entryPrice: string;
  entryAt: number;
  settleAt: number;
}

export interface SettledCall {
  id: string;
  direction: Direction;
  entryPrice: string;
  exitPrice: string | null;
  outcome: Outcome;
  settledAt: number;
}

export const STREAK_TTL_SECONDS = 24 * 60 * 60;
export const HISTORY_LIMIT = 20;
// Generous safety TTL on the open-call key: a call normally settles at 60s;
// a lingering key past this would otherwise block the identity forever.
const OPEN_CALL_TTL_SECONDS = 5 * 60;
const IP_WINDOW_SECONDS = 60 * 60;

interface Store {
  getOpen(key: string): Promise<OpenCall | null>;
  /** Stores the call only if the identity has none open. */
  setOpenIfAbsent(key: string, call: OpenCall): Promise<boolean>;
  /** True only for the caller that actually removed it — the settle claim. */
  claimOpen(key: string, callId: string): Promise<boolean>;
  getStreak(key: string): Promise<number>;
  setStreak(key: string, streak: number): Promise<void>;
  pushHistory(key: string, call: SettledCall): Promise<void>;
  getHistory(key: string): Promise<SettledCall[]>;
  deleteIdentity(key: string): Promise<void>;
  /** Increments the IP's counter for the current window, returns the new count. */
  incrIp(ip: string): Promise<number>;
}

class RedisStore implements Store {
  constructor(private redis: Redis) {}

  private k(kind: string, key: string): string {
    return `qc:${kind}:${key}`;
  }

  async getOpen(key: string): Promise<OpenCall | null> {
    const raw = await this.redis.get(this.k("open", key));
    return raw ? (JSON.parse(raw) as OpenCall) : null;
  }

  async setOpenIfAbsent(key: string, call: OpenCall): Promise<boolean> {
    const res = await this.redis.set(this.k("open", key), JSON.stringify(call), "EX", OPEN_CALL_TTL_SECONDS, "NX");
    return res === "OK";
  }

  async claimOpen(key: string, callId: string): Promise<boolean> {
    // Compare-and-delete so a stale settler can't remove a newer call.
    const script = `
      local v = redis.call("GET", KEYS[1])
      if not v then return 0 end
      if cjson.decode(v).id ~= ARGV[1] then return 0 end
      return redis.call("DEL", KEYS[1])`;
    const res = await this.redis.eval(script, 1, this.k("open", key), callId);
    return res === 1;
  }

  async getStreak(key: string): Promise<number> {
    const raw = await this.redis.get(this.k("streak", key));
    return raw ? Number(raw) : 0;
  }

  async setStreak(key: string, streak: number): Promise<void> {
    await this.redis.set(this.k("streak", key), String(streak), "EX", STREAK_TTL_SECONDS);
  }

  async pushHistory(key: string, call: SettledCall): Promise<void> {
    const k = this.k("hist", key);
    await this.redis
      .pipeline()
      .lpush(k, JSON.stringify(call))
      .ltrim(k, 0, HISTORY_LIMIT - 1)
      .expire(k, STREAK_TTL_SECONDS)
      .exec();
  }

  async getHistory(key: string): Promise<SettledCall[]> {
    const raw = await this.redis.lrange(this.k("hist", key), 0, HISTORY_LIMIT - 1);
    return raw.map((r) => JSON.parse(r) as SettledCall);
  }

  async deleteIdentity(key: string): Promise<void> {
    await this.redis.del(this.k("open", key), this.k("streak", key), this.k("hist", key));
  }

  async incrIp(ip: string): Promise<number> {
    const k = `qc:ip:${ip}:${Math.floor(Date.now() / 1000 / IP_WINDOW_SECONDS)}`;
    const results = await this.redis.pipeline().incr(k).expire(k, IP_WINDOW_SECONDS).exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }
}

class MemoryStore implements Store {
  private open = new Map<string, OpenCall>();
  private streaks = new Map<string, { value: number; expiresAt: number }>();
  private history = new Map<string, SettledCall[]>();
  private ips = new Map<string, number>();

  async getOpen(key: string) {
    return this.open.get(key) ?? null;
  }

  async setOpenIfAbsent(key: string, call: OpenCall) {
    if (this.open.has(key)) return false;
    this.open.set(key, call);
    return true;
  }

  async claimOpen(key: string, callId: string) {
    if (this.open.get(key)?.id !== callId) return false;
    this.open.delete(key);
    return true;
  }

  async getStreak(key: string) {
    const entry = this.streaks.get(key);
    if (!entry || entry.expiresAt < Date.now()) return 0;
    return entry.value;
  }

  async setStreak(key: string, streak: number) {
    this.streaks.set(key, { value: streak, expiresAt: Date.now() + STREAK_TTL_SECONDS * 1000 });
  }

  async pushHistory(key: string, call: SettledCall) {
    this.history.set(key, [call, ...(this.history.get(key) ?? [])].slice(0, HISTORY_LIMIT));
  }

  async getHistory(key: string) {
    return this.history.get(key) ?? [];
  }

  async deleteIdentity(key: string) {
    this.open.delete(key);
    this.streaks.delete(key);
    this.history.delete(key);
  }

  async incrIp(ip: string) {
    const k = `${ip}:${Math.floor(Date.now() / 1000 / IP_WINDOW_SECONDS)}`;
    const next = (this.ips.get(k) ?? 0) + 1;
    this.ips.set(k, next);
    return next;
  }
}

let instance: Store | null = null;

export function quickCallStore(): Store {
  if (!instance) {
    const redis = getRedis();
    instance = redis ? new RedisStore(redis) : new MemoryStore();
  }
  return instance;
}

/** TEST-ONLY — fresh in-memory state between tests. */
export function __resetQuickCallStoreForTest(): void {
  instance = new MemoryStore();
}
