/**
 * landingBroadcaster.ts — shared state + fan-out behind GET
 * /v1/public/landing-stream.
 *
 * All connections share one price loop and one featured-match recompute, so
 * cost is independent of how many visitors are on the page. The loops run
 * only while at least one connection is open.
 *
 * Frames:
 *   price     {symbol, price}          BTC/ETH/SOL, each ≤ 2/s, only on change
 *   featured  FeaturedMatch | null     every FEATURED_REFRESH_MS
 *   quickcall QuickCallSettledData     only to the connection's own identity
 */

import { subscribeGlobal } from "../events/eventBus";
import type { AppEvent, QuickCallSettledData } from "../events/eventTypes";
import { getSpectatorCount } from "../competitions/matchSpectatorStore";
import { logger as rootLogger } from "../observability/logContext";
import { getLatestTrade, LANDING_SYMBOLS, startLatestTradeTracker } from "../quickCall/latestTradeStore";
import { pickFeatured, toPublicFeaturedMatch, type FeaturedMatch, type SeriesPoint } from "./featuredMatch";
import { lastMatchTrades, listActiveMatchesForLanding } from "./landingMatchRepo";

const logger = rootLogger.child({ module: "landingBroadcaster" });

export const PRICE_INTERVAL_MS = 500;
export const FEATURED_REFRESH_MS = 5_000;
const SERIES_MAX_POINTS = 120;
const SERIES_MIN_SPACING_MS = 5_000;
/**
 * A price older than this isn't sent to a newly connected viewer: if the feed
 * has died, the page should show no price rather than an old one as live.
 * (Ongoing frames are only sent on change, so a dead feed sends nothing.)
 */
export const MAX_PRICE_AGE_MS = 60_000;
export const MAX_CONNECTIONS_PER_IP = 4;
export const MAX_CONNECTIONS_TOTAL = 5_000;

export interface LandingConnection {
  ip: string;
  /** Quick-call identity key (`anon:<uuid>` / `user:<uuid>`), null if none yet. */
  identityKey: string | null;
  send(event: "price" | "featured" | "quickcall", data: unknown): void;
}

const connections = new Set<LandingConnection>();
const perIp = new Map<string, number>();

interface MatchReturns {
  challengerPct: number;
  opponentPct: number;
  series: SeriesPoint[];
}
const matchReturns = new Map<string, MatchReturns>();

let featured: FeaturedMatch | null = null;
const lastSentPrice = new Map<string, string>();
let priceTimer: ReturnType<typeof setInterval> | null = null;
let featuredTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
let subscribed = false;

/** Short symbol ("BTC") for the client. */
function shortSymbol(symbol: string): string {
  return symbol.split("/")[0]!;
}

export function recordMatchReturns(matchId: string, challengerPct: number, opponentPct: number, t: number): void {
  const entry = matchReturns.get(matchId) ?? { challengerPct, opponentPct, series: [] };
  entry.challengerPct = challengerPct;
  entry.opponentPct = opponentPct;
  const last = entry.series[entry.series.length - 1];
  const point = { t, challengerPct, opponentPct };
  if (last && t - last.t < SERIES_MIN_SPACING_MS) {
    entry.series[entry.series.length - 1] = { ...point, t: last.t };
  } else {
    entry.series.push(point);
    if (entry.series.length > SERIES_MAX_POINTS) entry.series.shift();
  }
  matchReturns.set(matchId, entry);
}

function onEvent(event: AppEvent): void {
  switch (event.type) {
    case "match.pnl.update":
      recordMatchReturns(
        event.data.matchId,
        Number(event.data.challengerPnlPct),
        Number(event.data.opponentPnlPct),
        event.ts,
      );
      return;
    case "match.ended":
      matchReturns.delete(event.data.matchId);
      return;
    case "quickcall.settled":
      deliverQuickCall(event.userId, event.data);
      return;
  }
}

function deliverQuickCall(identityKey: string | undefined, data: QuickCallSettledData): void {
  if (!identityKey) return;
  for (const conn of connections) {
    if (conn.identityKey === identityKey) conn.send("quickcall", data);
  }
}

export async function computeFeaturedMatch(now: number = Date.now()): Promise<FeaturedMatch | null> {
  const rows = await listActiveMatchesForLanding();
  if (rows.length === 0) return null;

  const candidates = await Promise.all(
    rows.map(async (row) => {
      const returns = matchReturns.get(row.id);
      return {
        row,
        matchId: row.id,
        spectatorCount: await getSpectatorCount(row.id),
        challengerPct: returns?.challengerPct ?? null,
        opponentPct: returns?.opponentPct ?? null,
      };
    }),
  );
  const pick = pickFeatured(candidates);
  if (!pick) return null;

  return toPublicFeaturedMatch(
    {
      matchId: pick.matchId,
      endsAt: pick.row.ends_at,
      startingCapital: Number(pick.row.starting_capital),
      challengerHandle: pick.row.challenger_handle,
      opponentHandle: pick.row.opponent_handle,
      spectatorCount: pick.spectatorCount,
      challengerPct: pick.challengerPct,
      opponentPct: pick.opponentPct,
      series: matchReturns.get(pick.matchId)?.series ?? [],
      lastTrades: await lastMatchTrades(pick.row),
    },
    now,
  );
}

async function refreshFeatured(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    featured = await computeFeaturedMatch();
    for (const conn of connections) conn.send("featured", featured);
  } catch (err) {
    logger.warn({ err }, "landing_featured_refresh_failed");
  } finally {
    refreshing = false;
  }
}

function pushPrices(): void {
  for (const symbol of LANDING_SYMBOLS) {
    const latest = getLatestTrade(symbol);
    if (!latest || lastSentPrice.get(symbol) === latest.price) continue;
    lastSentPrice.set(symbol, latest.price);
    const frame = { symbol: shortSymbol(symbol), price: latest.price };
    for (const conn of connections) conn.send("price", frame);
  }
}

function startLoops(): void {
  if (!subscribed) {
    subscribed = true;
    startLatestTradeTracker();
    subscribeGlobal(onEvent);
  }
  if (!priceTimer) priceTimer = setInterval(pushPrices, PRICE_INTERVAL_MS);
  if (!featuredTimer) {
    featuredTimer = setInterval(() => void refreshFeatured(), FEATURED_REFRESH_MS);
    void refreshFeatured();
  }
}

function stopLoops(): void {
  if (priceTimer) clearInterval(priceTimer);
  if (featuredTimer) clearInterval(featuredTimer);
  priceTimer = null;
  featuredTimer = null;
}

/** Whether another stream from `ip` fits under the per-IP and global caps. */
export function hasCapacity(ip: string): boolean {
  return (perIp.get(ip) ?? 0) < MAX_CONNECTIONS_PER_IP && connections.size < MAX_CONNECTIONS_TOTAL;
}

/**
 * Register a connection and immediately send it the current prices and
 * featured match — so the caller must have written its SSE headers first.
 * Returns an unregister function, or null when a cap is hit.
 */
export function addConnection(conn: LandingConnection): (() => void) | null {
  if (!hasCapacity(conn.ip)) return null;
  const ipCount = perIp.get(conn.ip) ?? 0;

  connections.add(conn);
  perIp.set(conn.ip, ipCount + 1);
  startLoops();

  // Initial state so the page renders without waiting for the next tick.
  for (const symbol of LANDING_SYMBOLS) {
    const latest = getLatestTrade(symbol);
    if (latest && Date.now() - latest.receivedAt <= MAX_PRICE_AGE_MS) {
      conn.send("price", { symbol: shortSymbol(symbol), price: latest.price });
    }
  }
  if (featuredTimer && !refreshing) conn.send("featured", featured);

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    connections.delete(conn);
    const n = (perIp.get(conn.ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(conn.ip);
    else perIp.set(conn.ip, n);
    if (connections.size === 0) stopLoops();
  };
}

/** TEST-ONLY. */
export function __resetLandingForTest(): void {
  stopLoops();
  connections.clear();
  perIp.clear();
  matchReturns.clear();
  lastSentPrice.clear();
  featured = null;
}

/** TEST-ONLY — deliver an event as if it arrived on the bus. */
export function __onEventForTest(event: AppEvent): void {
  onEvent(event);
}
