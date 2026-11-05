import { describe, it, expect, beforeAll } from "vitest";

// The web tsconfig has no Node types, and vitest empties CSS imports, even
// ?raw: reach fs untyped, as UnifiedOrderPanel.leverageOff.test.tsx does.
const nodeProcess = (globalThis as { process?: { cwd(): string } }).process!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs = (): Promise<any> => import(/* @vite-ignore */ ["node", "fs"].join(":"));

let css = "";
let appLayout = "";
let arenaPage = "";
let liveMatchView = "";

beforeAll(async () => {
  const fs = await nodeFs();
  const read = (p: string): string => fs.readFileSync(`${nodeProcess.cwd()}/src/${p}`, "utf8");
  css = read("styles/match.css");
  appLayout = read("layouts/AppLayout.tsx");
  arenaPage = read("pages/ArenaPage.tsx");
  liveMatchView = read("components/arena/LiveMatchView.tsx");
});

describe("the match UI's CSS loads on any page", () => {
  it("AppLayout imports it", () => {
    expect(appLayout).toContain('import "@/styles/match.css"');
  });

  it.each([".ar-btn-orange", ".ar-btn-outline", ".ar-btn-red", ".lmv-header", ".lmv-modal-backdrop", ".lmv-end-card", ".lmv-chat-panel"])(
    "has %s", (selector) => {
      expect(css).toContain(selector);
    },
  );

  it("carries its own --ar-* variables, on its elements and not on :root", () => {
    expect(css).toContain("--ar-orange: #FF6B00");
    // UnifiedOrderPanel reads var(--ar-orange, var(--g)): a global value would recolor /trade.
    expect(css).not.toMatch(/:root\s*[,{]/);
  });

  it("is defined once, not also inline in the pages", () => {
    expect(arenaPage).not.toMatch(/\.ar-btn-red\s*\{/);
    expect(liveMatchView).not.toMatch(/\.lmv-end-card\s*\{/);
    expect(liveMatchView).not.toMatch(/\.lmv-chat-panel\s*\{/);
  });
});
