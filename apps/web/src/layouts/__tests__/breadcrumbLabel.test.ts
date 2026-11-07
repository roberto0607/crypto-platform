import { describe, it, expect } from "vitest";
import { breadcrumbLabel } from "@/layouts/AppLayout";

describe("breadcrumbLabel", () => {
  it.each([
    "/matches/m1/breakdown",
    "/matches/m1/replay",
    "/matches/m1/spectate",
    "/arena",
  ])("%s sits under ARENA", (path) => {
    expect(breadcrumbLabel(path)).toBe("ARENA");
  });

  it("/trade stays TRADE", () => {
    expect(breadcrumbLabel("/trade")).toBe("TRADE");
  });
});
