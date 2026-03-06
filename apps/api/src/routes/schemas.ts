/**
 * Shared JSON Schema definitions for OpenAPI route schemas.
 * Reuse these across route files to keep definitions DRY.
 */

export const errorResponse = {
  type: "object",
  properties: {
    ok: { type: "boolean", const: false },
    error: { type: "string" },
    message: { type: "string" },
    details: { type: "object" },
  },
  required: ["ok", "error"],
} as const;

export const paginatedResponse = (itemSchema: object) => ({
  type: "object" as const,
  properties: {
    data: { type: "array" as const, items: itemSchema },
    nextCursor: { type: "string" as const, nullable: true, description: "Cursor for next page (null if no more results)" },
  },
});

export const uuidParam = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", format: "uuid" },
  },
} as const;
