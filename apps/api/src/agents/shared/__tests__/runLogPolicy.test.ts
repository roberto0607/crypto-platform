import { describe, it, expect, vi, afterEach } from "vitest";
import { createRunLogPolicy } from "../runLogPolicy";

describe("createRunLogPolicy", () => {
  function policy(opts: { sampleRate?: number; random?: number } = {}) {
    let t = 1_000_000;
    const p = createRunLogPolicy({
      sampleRate: opts.sampleRate ?? 0,
      heartbeatMs: 30 * 60_000,
      now: () => t,
      random: () => opts.random ?? 0.99,
    });
    return { p, advance: (ms: number) => { t += ms; } };
  }

  it("always persists errors and timeouts", () => {
    const { p } = policy();
    for (let i = 0; i < 5; i++) {
      expect(p.shouldPersist({ agentName: "scanner", status: "error", ledToAction: false })).toBe(true);
      expect(p.shouldPersist({ agentName: "scanner", status: "timeout", ledToAction: false })).toBe(true);
    }
  });

  it("always persists a success that led to an action", () => {
    const { p } = policy();
    for (let i = 0; i < 5; i++) {
      expect(p.shouldPersist({ agentName: "chart-analysis", status: "success", ledToAction: true })).toBe(true);
    }
  });

  it("persists one no-action success per heartbeat window, drops the rest", () => {
    const { p, advance } = policy();
    const run = { agentName: "chart-analysis", status: "success" as const, ledToAction: false };
    expect(p.shouldPersist(run)).toBe(true); // first ever → heartbeat
    advance(60_000);
    expect(p.shouldPersist(run)).toBe(false);
    advance(28 * 60_000);
    expect(p.shouldPersist(run)).toBe(false);
    advance(60_000); // 30 min since last persisted
    expect(p.shouldPersist(run)).toBe(true);
    advance(60_000);
    expect(p.shouldPersist(run)).toBe(false);
  });

  it("tracks the heartbeat per agent", () => {
    const { p } = policy();
    expect(p.shouldPersist({ agentName: "a", status: "success", ledToAction: false })).toBe(true);
    expect(p.shouldPersist({ agentName: "b", status: "success", ledToAction: false })).toBe(true);
    expect(p.shouldPersist({ agentName: "a", status: "success", ledToAction: false })).toBe(false);
  });

  it("samples no-action successes at sampleRate between heartbeats", () => {
    const hit = policy({ sampleRate: 0.05, random: 0.01 });
    const miss = policy({ sampleRate: 0.05, random: 0.5 });
    const run = { agentName: "x", status: "success" as const, ledToAction: false };
    hit.p.shouldPersist(run);
    miss.p.shouldPersist(run);
    expect(hit.p.shouldPersist(run)).toBe(true);
    expect(miss.p.shouldPersist(run)).toBe(false);
  });

  it("reset() clears heartbeat state", () => {
    const { p } = policy();
    const run = { agentName: "x", status: "success" as const, ledToAction: false };
    p.shouldPersist(run);
    expect(p.shouldPersist(run)).toBe(false);
    p.reset();
    expect(p.shouldPersist(run)).toBe(true);
  });
});

describe("AGENTS_ENABLED master switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadConfig(env: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv("DISABLE_RATE_LIMIT", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return (await import("../../../config")).config;
  }

  const ALL_ON = {
    SCANNER_AGENT_ENABLED: "true",
    CHART_ANALYSIS_AGENT_ENABLED: "true",
    RISK_AGENT_ENABLED: "true",
    EXECUTION_AGENT_ENABLED: "true",
    NEWS_AGENT_ENABLED: "true",
  };

  it("defaults off in production and overrides every per-agent flag", async () => {
    const c = await loadConfig({ NODE_ENV: "production", AGENTS_ENABLED: "", ...ALL_ON });
    expect(c.agentsEnabled).toBe(false);
    expect(c.scannerAgentEnabled).toBe(false);
    expect(c.chartAnalysisAgentEnabled).toBe(false);
    expect(c.riskAgentEnabled).toBe(false);
    expect(c.executionAgentEnabled).toBe(false);
    expect(c.newsAgentEnabled).toBe(false);
  });

  it("AGENTS_ENABLED=true in production defers to the per-agent flags", async () => {
    const c = await loadConfig({ NODE_ENV: "production", AGENTS_ENABLED: "true", ...ALL_ON, NEWS_AGENT_ENABLED: "" });
    expect(c.scannerAgentEnabled).toBe(true);
    expect(c.executionAgentEnabled).toBe(true);
    expect(c.newsAgentEnabled).toBe(false);
  });

  it("AGENTS_ENABLED=false outside production also disables everything", async () => {
    const c = await loadConfig({ NODE_ENV: "development", AGENTS_ENABLED: "false", ...ALL_ON });
    expect(c.scannerAgentEnabled).toBe(false);
    expect(c.riskAgentEnabled).toBe(false);
  });
});
