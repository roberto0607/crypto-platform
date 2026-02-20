import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function numberEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

const jwtAccessTtlSeconds = numberEnv("JWT_ACCESS_TTL_SECONDS", 900);

// Prefer seconds if provided; otherwise fall back to days.
const jwtRefreshTtlSeconds =
  process.env.JWT_REFRESH_TTL_SECONDS
    ? numberEnv("JWT_REFRESH_TTL_SECONDS", 60 * 60 * 24 * 30)
    : numberEnv("JWT_REFRESH_TTL_DAYS", 30) * 24 * 60 * 60;

export const config = {
  port: numberEnv("PORT", 3001),
  host: process.env.HOST ?? "0.0.0.0",

  nodeEnv,
  isProd,

  jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: requireEnv("JWT_REFRESH_SECRET"),

  jwtAccessTtlSeconds,
  jwtRefreshTtlSeconds,
};
