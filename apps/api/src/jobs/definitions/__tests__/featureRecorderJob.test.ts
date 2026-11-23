/**
 * featureRecorderJob: the flag gate around runFeatureRecorder. The recorder
 * itself is tested in agents/confluence/live/__tests__/featureRecorder.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { JobContext } from "../../jobTypes";

const mockRun = vi.fn();
vi.mock("../../../agents/confluence/live/featureRecorder", () => ({
  runFeatureRecorder: (...args: unknown[]) => mockRun(...args),
}));

const mockConfig = vi.hoisted(() => ({ featureRecorderEnabled: false }));
vi.mock("../../../config", () => ({ config: mockConfig }));

import { featureRecorderJob } from "../featureRecorderJob";
import { readFileSync } from "node:fs";

const ctx = (): JobContext => ({
  pool: {} as JobContext["pool"],
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as JobContext["logger"],
  signal: new AbortController().signal,
});

describe("featureRecorderJob", () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue({ status: "idle", rows: [], sourceErrors: [] });
  });

  it("is registered, every 5 minutes", () => {
    // (allJobs itself can't be imported here: every other job reads the real config)
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/^\s+featureRecorderJob,$/m);
    expect(featureRecorderJob.intervalSeconds).toBe(300);
  });

  it("does nothing with the flag off", async () => {
    mockConfig.featureRecorderEnabled = false;
    await featureRecorderJob.run(ctx());
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs the recorder with the flag on and logs what it wrote", async () => {
    mockConfig.featureRecorderEnabled = true;
    mockRun.mockResolvedValue({ status: "recorded", rows: [{ barTime: 1, late: true }], sourceErrors: ["gate"] });
    const c = ctx();
    await featureRecorderJob.run(c);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(c.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ sourceErrors: ["gate"] }), "feature_recorder_source_errors");
    expect(c.logger.info).toHaveBeenCalledWith(expect.objectContaining({ rows: 1, late: 1 }), "feature_recorder_recorded");
  });
});
