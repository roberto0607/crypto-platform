import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import clientIpDebugRoutes from "../clientIpDebugRoutes";
import { trustProxyOption } from "../../http/trustProxy";

// TEMPORARY route (see clientIpDebugRoutes.ts). Guards the one property that
// matters before it runs in prod: it logs addresses, never secrets.

async function buildDebugApp(lines: string[]) {
  const app = Fastify({
    logger: { level: "info", stream: { write: (s: string) => void lines.push(s) } },
    trustProxy: trustProxyOption(1),
  });
  await app.register(clientIpDebugRoutes);
  await app.ready();
  return app;
}

describe("GET /debug/client-ip", () => {
  it("returns 204 with no body and logs the hop chain, not cookies or auth", async () => {
    const lines: string[] = [];
    const app = await buildDebugApp(lines);
    const res = await app.inject({
      method: "GET",
      url: "/debug/client-ip",
      remoteAddress: "10.0.0.9",
      headers: {
        "x-forwarded-for": "198.51.100.20, 104.16.1.1",
        "cf-connecting-ip": "198.51.100.20",
        "cf-ray": "abc123-EWR",
        cookie: "refresh_token=SECRET_COOKIE_VALUE",
        authorization: "Bearer SECRET_TOKEN_VALUE",
      },
    });
    await app.close();

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe("");

    const entry = lines.map((l) => JSON.parse(l)).find((l) => l.event === "client_ip_debug");
    expect(entry).toBeDefined();
    expect(entry.socketRemoteAddress).toBe("10.0.0.9");
    expect(entry.reqIp).toBe("104.16.1.1");
    expect(entry.reqIps).toEqual(["10.0.0.9", "104.16.1.1"]);
    expect(entry.headers["x-forwarded-for"]).toBe("198.51.100.20, 104.16.1.1");
    expect(entry.headers["cf-connecting-ip"]).toBe("198.51.100.20");
    expect(entry.headers["cf-ray"]).toBe("abc123-EWR");
    expect(entry.headerNames).toContain("cookie");

    const all = lines.join("\n");
    expect(all).not.toContain("SECRET_COOKIE_VALUE");
    expect(all).not.toContain("SECRET_TOKEN_VALUE");
  });
});
