import "dotenv/config";

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error('Missing env var: ${name}');
    return v;
}

function numberEnv(name: string, fallback: number): number {
    const v = process.env[name];
    if(!v) return fallback;
    const n = Number(v);
    if(!Number.isFinite(n)) throw new Error('Env var ${name} must be a number');
    return n;
}

export const config = {
    port: numberEnv("PORT", 3001),
    host: process.env.HOST ?? "0.0.0.0",

    jwtAccessSecret: requireEnv("JWT_ACCESS_SECRET"),
    jwtRefreshSecret: requireEnv("JWT_REFRESH_SECRET"),

    jwtAccessTtlSeconds: numberEnv("JWT_ACCESS_TTL_SECONDS", 900),
    jwtRefreshTtlDays: numberEnv("JWT_ACCESS_TTL_DAYS", 30),
};