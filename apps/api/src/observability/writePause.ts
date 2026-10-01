/**
 * writePause.ts — the disk-pressure level, shared by the guard that sets it
 * (dbSizeGuard.ts) and the non-essential writers that check it (agents,
 * agent run logs, footprint). Dependency-free on purpose so those writers
 * don't pull in the pool/metrics just to read a flag.
 */
export type DbSizeLevel = "unknown" | "ok" | "warn" | "critical";

let level: DbSizeLevel = "unknown";

/** True while the last size check was at/above the critical threshold. */
export function nonEssentialWritesPaused(): boolean {
  return level === "critical";
}

export function currentDbSizeLevel(): DbSizeLevel {
  return level;
}

export function setDbSizeLevel(l: DbSizeLevel): void {
  level = l;
}
