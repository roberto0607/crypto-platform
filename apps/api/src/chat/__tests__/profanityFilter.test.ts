import { describe, it, expect } from "vitest";
import { containsProfanity } from "../profanityFilter";

describe("containsProfanity", () => {
    it("flags a bare blocked word", () => {
        expect(containsProfanity("shit happens")).toBe(true);
    });

    it("flags common inflections of a blocked word", () => {
        expect(containsProfanity("you're fucking kidding")).toBe(true);
        expect(containsProfanity("what a bitching attitude")).toBe(true);
    });

    it("is case-insensitive", () => {
        expect(containsProfanity("What the HELL, ASSHOLE")).toBe(true);
    });

    it("does not flag clean text", () => {
        expect(containsProfanity("good trade, nice entry")).toBe(false);
        expect(containsProfanity("")).toBe(false);
    });

    it("does not false-positive on unrelated words containing similar substrings", () => {
        expect(containsProfanity("classic setup, assessment pending")).toBe(false);
    });
});
