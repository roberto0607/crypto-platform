import { describe, it, expect } from "vitest";
import { z } from "zod";
import { extractJsonCandidate, parseAgentJsonOutput } from "../parseAgentOutput";

describe("extractJsonCandidate", () => {
  it("returns the text unchanged when it is already a bare JSON object", () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
  });

  it("strips a ```json fence", () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a plain ``` fence with no language tag", () => {
    expect(extractJsonCandidate('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("falls back to the first-to-last brace span when there is leading prose", () => {
    expect(extractJsonCandidate('Here is my analysis: {"a":1}')).toBe('{"a":1}');
  });

  it("falls back to the first-to-last brace span when there is trailing prose", () => {
    expect(extractJsonCandidate('{"a":1} -- that is my answer.')).toBe('{"a":1}');
  });

  it("returns the trimmed text unchanged when there is no brace at all", () => {
    expect(extractJsonCandidate("no json here")).toBe("no json here");
  });
});

const schema = z.object({ a: z.number() });

describe("parseAgentJsonOutput", () => {
  it("parses and validates well-formed JSON", () => {
    expect(parseAgentJsonOutput('{"a":1}', schema)).toEqual({ a: 1 });
  });

  it("parses fenced JSON via extractJsonCandidate", () => {
    expect(parseAgentJsonOutput('```json\n{"a":1}\n```', schema)).toEqual({ a: 1 });
  });

  it("returns null (never throws) on invalid JSON", () => {
    expect(parseAgentJsonOutput("not json", schema)).toBeNull();
  });

  it("returns null (never throws) on valid JSON that fails schema validation", () => {
    expect(parseAgentJsonOutput('{"a":"not a number"}', schema)).toBeNull();
  });
});
