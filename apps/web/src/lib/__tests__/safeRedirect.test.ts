import { describe, it, expect } from "vitest";
import { safeRedirectTarget, loginUrlFor } from "@/lib/safeRedirect";

describe("safeRedirectTarget", () => {
  it("keeps path, query and hash of an in-app path", () => {
    expect(safeRedirectTarget("/trade?debug=1")).toBe("/trade?debug=1");
    expect(safeRedirectTarget("/matches/abc/replay?x=1&debug=1#t")).toBe("/matches/abc/replay?x=1&debug=1#t");
  });

  it.each([
    null, undefined, "", "trade", "//evil.com", "//evil.com/trade", "/\\evil.com",
    "https://evil.com/trade", "javascript:alert(1)", "/login", "/login?redirect=%2Ftrade",
  ])("falls back for %s", (raw) => {
    expect(safeRedirectTarget(raw as string | null | undefined)).toBe("/trade");
  });

  it("round-trips through loginUrlFor", () => {
    const url = loginUrlFor({ pathname: "/trade", search: "?debug=1", hash: "" });
    expect(url).toBe("/login?redirect=%2Ftrade%3Fdebug%3D1");
    const redirect = new URLSearchParams(url.split("?")[1]).get("redirect");
    expect(safeRedirectTarget(redirect)).toBe("/trade?debug=1");
  });
});
