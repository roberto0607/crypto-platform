/**
 * priorityClasses.ts — Route priority classification for load shedding.
 *
 * Maps HTTP method + route pattern to a priority level.
 * Under load, LOW routes shed first, then IMPORTANT writes,
 * CRITICAL routes are never shed.
 */

export const enum Priority {
  CRITICAL = "CRITICAL",
  IMPORTANT = "IMPORTANT",
  LOW = "LOW",
}

/**
 * Route patterns mapped to priority levels.
 *
 * CRITICAL — Trading hot path: must always be served.
 * IMPORTANT — Portfolio reads: shed only under extreme pressure.
 * LOW — Admin/ops endpoints: first to shed.
 *
 * Unmatched routes default to IMPORTANT.
 */
const CRITICAL_ROUTES: readonly { method: string; pattern: string }[] = [
  { method: "POST", pattern: "/orders" },
  { method: "DELETE", pattern: "/orders/:id" },
  { method: "GET", pattern: "/pairs/:pairId/book" },
  { method: "GET", pattern: "/pairs/:pairId/snapshot" },
  // v1 trading
  { method: "POST", pattern: "/v1/orders" },
  { method: "DELETE", pattern: "/v1/orders/:id" },
];

const IMPORTANT_ROUTES: readonly { method: string; pattern: string }[] = [
  { method: "GET", pattern: "/wallets" },
  { method: "GET", pattern: "/wallets/:id" },
  { method: "GET", pattern: "/v1/portfolio" },
  { method: "GET", pattern: "/v1/portfolio/equity" },
  { method: "GET", pattern: "/v1/portfolio/pnl" },
  { method: "GET", pattern: "/v1/transactions" },
];

const LOW_ROUTE_PREFIXES: readonly string[] = [
  "/v1/admin",
  "/admin",
  "/v1/proof-pack",
  "/v1/reconciliation",
  "/v1/repair",
  "/v1/restore-drill",
  "/v1/incidents",
  "/v1/event-stream",
  "/v1/outbox",
  "/v1/system",
  "/replay",
  "/risk",
];

/**
 * Classify a request's priority based on HTTP method and Fastify route pattern.
 *
 * @param method  HTTP method (GET, POST, etc.)
 * @param route   Fastify route pattern (e.g. "/orders/:id"), NOT the raw URL
 */
export function getRoutePriority(method: string, route: string): Priority {
  // Health + metrics are always allowed (handled before this check)
  if (route === "/health" || route === "/healthz" || route === "/metrics") {
    return Priority.CRITICAL;
  }

  // Check CRITICAL exact matches
  for (const r of CRITICAL_ROUTES) {
    if (r.method === method && r.pattern === route) return Priority.CRITICAL;
  }

  // Check LOW prefix matches
  for (const prefix of LOW_ROUTE_PREFIXES) {
    if (route.startsWith(prefix)) return Priority.LOW;
  }

  // Check IMPORTANT exact matches
  for (const r of IMPORTANT_ROUTES) {
    if (r.method === method && r.pattern === route) return Priority.IMPORTANT;
  }

  // Default: IMPORTANT (safe middle ground — not shed unless extreme)
  return Priority.IMPORTANT;
}
