/**
 * bookStream.ts — push the cached Kraken book over SSE (book.snapshot).
 *
 * krakenWs.publishBook() calls scheduleBookPush() on every book update. Each
 * pair is sent at most once per BOOK_PUSH_INTERVAL_MS (leading edge, then one
 * coalesced trailing send carrying the latest book), so a busy feed costs
 * ≤2 frames/s per pair no matter how fast Kraken updates.
 *
 * Delivered with publishLocal: the book lives in this instance's memory, same
 * as GET /market/book. v1Events filters it to streams subscribed to the pair.
 */
import { publishLocal } from "../events/eventBus";
import { createEvent, type BookLevelWire } from "../events/eventTypes";
import { bookSnapshots } from "./orderFlowFeatures.js";
import type { BookLevel } from "./orderFlowFeatures.js";
import { eventsPublishedTotal } from "../metrics.js";

export const BOOK_PUSH_INTERVAL_MS = 500;

/** Wire format shared with GET /market/book/:symbol. */
export function toWireLevels(levels: BookLevel[]): BookLevelWire[] {
  return levels.map((l) => ({ price: String(l.price), qty: String(l.qty), count: "1" }));
}

const lastSentAt = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function push(pairId: string): void {
  const snap = bookSnapshots.get(pairId);
  if (!snap) return; // dropped (e.g. checksum resync) — clients fall back to polling
  try {
    publishLocal(createEvent("book.snapshot", {
      pairId,
      bids: toWireLevels(snap.bids),
      asks: toWireLevels(snap.asks),
      bookTs: snap.ts,
    }));
    eventsPublishedTotal.inc({ type: "book.snapshot" });
  } catch {
    // Events must never break the feed
  }
}

export function scheduleBookPush(pairId: string, now: number = Date.now()): void {
  if (pending.has(pairId)) return; // a send is already queued; it reads the latest book
  const wait = Math.max(0, (lastSentAt.get(pairId) ?? 0) + BOOK_PUSH_INTERVAL_MS - now);
  const timer = setTimeout(() => {
    pending.delete(pairId);
    lastSentAt.set(pairId, Date.now());
    push(pairId);
  }, wait);
  timer.unref?.();
  pending.set(pairId, timer);
}

export function stopBookPush(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  lastSentAt.clear();
}
