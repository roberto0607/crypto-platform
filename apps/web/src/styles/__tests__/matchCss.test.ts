import { describe, it, expect, beforeAll } from "vitest";

// The web tsconfig has no Node types, and vitest empties CSS imports, even
// ?raw: reach fs untyped, as UnifiedOrderPanel.leverageOff.test.tsx does.
const nodeProcess = (globalThis as { process?: { cwd(): string } }).process!;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeFs = (): Promise<any> => import(/* @vite-ignore */ ["node", "fs"].join(":"));

let css = "";
let appLayout = "";
let arenaPage = "";

beforeAll(async () => {
  const fs = await nodeFs();
  const read = (p: string): string => fs.readFileSync(`${nodeProcess.cwd()}/src/${p}`, "utf8");
  css = read("styles/match.css");
  appLayout = read("layouts/AppLayout.tsx");
  arenaPage = read("pages/ArenaPage.tsx");
});

describe("the match UI's CSS loads on any page", () => {
  it("AppLayout imports it", () => {
    expect(appLayout).toContain('import "@/styles/match.css"');
  });

  it.each([".ar-btn-orange", ".ar-btn-outline", ".ar-btn-red", ".mt-header", ".mt-modal-backdrop", ".mt-end-card", ".mt-chat-panel"])(
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
  });

  it("the chat docks in the chart area: nothing lets it reach the order form", () => {
    expect(css).toMatch(/\.mt-chat-panel \{[^}]*position: absolute[^}]*left: 16px/);
    expect(css).toMatch(/\.mt-chat-panel \{[^}]*max-width: calc\(100% - 32px\)/);
  });

  it("the header can't clip: columns that shrink, around ones that don't", () => {
    expect(css).toMatch(/\.mt-header \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.mt-h-name \{[^}]*text-overflow: ellipsis/);
  });
});
