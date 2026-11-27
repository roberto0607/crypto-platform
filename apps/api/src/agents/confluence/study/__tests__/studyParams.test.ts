/**
 * studyParams.ts must be the pre-registration, number for number: both JSON
 * blocks of docs/agents/confluence-preregistration.md (the 2026-11-16 rules
 * and the 2026-11-26 addendum) are parsed and compared.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STUDY_PREREGISTRATION, STUDY_ADDENDUM, STUDY_FEATURES, DIRECTIONAL_FEATURES, GATE_FEATURES } from "../studyParams";
import { FEATURE_COLUMNS } from "../../featureColumns";

const doc = readFileSync(new URL("../../../../../../../docs/agents/confluence-preregistration.md", import.meta.url), "utf8");
const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]!));

describe("studyParams", () => {
  it("has exactly the two pre-registered blocks", () => {
    expect(blocks).toHaveLength(2);
  });

  it("matches the 2026-11-16 pre-registration exactly", () => {
    expect(STUDY_PREREGISTRATION).toEqual(blocks[0]);
  });

  it("matches the 2026-11-26 addendum exactly", () => {
    expect(STUDY_ADDENDUM).toEqual(blocks[1]);
  });

  it("studies the 45 non-live numeric features: 9 gates, 36 directional", () => {
    expect(STUDY_FEATURES).toHaveLength(STUDY_ADDENDUM.bhFamily.features);
    expect(STUDY_FEATURES.length * STUDY_PREREGISTRATION.targets.horizonBars.length).toBe(STUDY_ADDENDUM.bhFamily.tests);
    expect([...GATE_FEATURES].sort()).toEqual([...STUDY_PREREGISTRATION.gateFeatures].sort());
    expect(DIRECTIONAL_FEATURES).toHaveLength(36);
    const all = new Set<string>(FEATURE_COLUMNS.map((c) => c.name));
    for (const f of STUDY_FEATURES) expect(all.has(f.name)).toBe(true);
    for (const f of STUDY_ADDENDUM.excludedFromVoting) expect(STUDY_FEATURES.map((s) => s.name)).not.toContain(f);
  });
});
