/**
 * Shared JSON-extraction/parsing helper for agent runners that ask a model
 * for a single terminal JSON object (Scanner, Chart Analysis). Extracted
 * from the Scanner Agent's runner.ts (Gate 1b Task 5 fix) once a second
 * agent needed the same defensive parsing -- the system prompt forbids
 * preamble/fencing, but real runs have shown the model doing it anyway
 * (wrapping in a ```json fence, or prefacing with prose analysis).
 */
import type { ZodType } from "zod";

/**
 * Strips a wrapping code fence if present, else falls back to the last
 * top-level {...} block in the text so leading prose doesn't break the
 * parse.
 */
export function extractJsonCandidate(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Extracts, parses, and validates a model's final text against the given
 * schema. Returns null (never throws) on any parse/validation failure --
 * callers log that as an agent_run_logs error row rather than passing a
 * malformed result downstream.
 */
export function parseAgentJsonOutput<T>(text: string, schema: ZodType<T>): T | null {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonCandidate(text));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
