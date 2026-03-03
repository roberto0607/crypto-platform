import { describe, it, expect } from "vitest";
import { getRoutePriority, Priority } from "../priorityClasses";

describe("getRoutePriority", () => {
  describe("CRITICAL routes", () => {
    it("POST /orders", () => {
      expect(getRoutePriority("POST", "/orders")).toBe(Priority.CRITICAL);
    });

    it("DELETE /orders/:id", () => {
      expect(getRoutePriority("DELETE", "/orders/:id")).toBe(Priority.CRITICAL);
    });

    it("GET /pairs/:pairId/book", () => {
      expect(getRoutePriority("GET", "/pairs/:pairId/book")).toBe(Priority.CRITICAL);
    });

    it("GET /pairs/:pairId/snapshot", () => {
      expect(getRoutePriority("GET", "/pairs/:pairId/snapshot")).toBe(Priority.CRITICAL);
    });

    it("POST /v1/orders", () => {
      expect(getRoutePriority("POST", "/v1/orders")).toBe(Priority.CRITICAL);
    });

    it("DELETE /v1/orders/:id", () => {
      expect(getRoutePriority("DELETE", "/v1/orders/:id")).toBe(Priority.CRITICAL);
    });

    it("/health", () => {
      expect(getRoutePriority("GET", "/health")).toBe(Priority.CRITICAL);
    });

    it("/metrics", () => {
      expect(getRoutePriority("GET", "/metrics")).toBe(Priority.CRITICAL);
    });
  });

  describe("LOW routes", () => {
    it("/admin/users", () => {
      expect(getRoutePriority("GET", "/admin/users")).toBe(Priority.LOW);
    });

    it("/v1/admin/anything", () => {
      expect(getRoutePriority("GET", "/v1/admin/users")).toBe(Priority.LOW);
    });

    it("/v1/reconciliation", () => {
      expect(getRoutePriority("POST", "/v1/reconciliation/trigger")).toBe(Priority.LOW);
    });

    it("/v1/repair", () => {
      expect(getRoutePriority("POST", "/v1/repair/run")).toBe(Priority.LOW);
    });

    it("/v1/proof-pack", () => {
      expect(getRoutePriority("GET", "/v1/proof-pack/123")).toBe(Priority.LOW);
    });

    it("/replay", () => {
      expect(getRoutePriority("POST", "/replay/start")).toBe(Priority.LOW);
    });

    it("/risk", () => {
      expect(getRoutePriority("GET", "/risk/breakers")).toBe(Priority.LOW);
    });

    it("/v1/incidents", () => {
      expect(getRoutePriority("GET", "/v1/incidents")).toBe(Priority.LOW);
    });

    it("/v1/outbox", () => {
      expect(getRoutePriority("GET", "/v1/outbox/stats")).toBe(Priority.LOW);
    });
  });

  describe("IMPORTANT routes", () => {
    it("GET /wallets", () => {
      expect(getRoutePriority("GET", "/wallets")).toBe(Priority.IMPORTANT);
    });

    it("GET /v1/portfolio", () => {
      expect(getRoutePriority("GET", "/v1/portfolio")).toBe(Priority.IMPORTANT);
    });

    it("GET /v1/transactions", () => {
      expect(getRoutePriority("GET", "/v1/transactions")).toBe(Priority.IMPORTANT);
    });
  });

  describe("default classification", () => {
    it("unknown route defaults to IMPORTANT", () => {
      expect(getRoutePriority("GET", "/unknown/route")).toBe(Priority.IMPORTANT);
    });

    it("auth routes default to IMPORTANT", () => {
      expect(getRoutePriority("POST", "/auth/login")).toBe(Priority.IMPORTANT);
    });
  });
});
