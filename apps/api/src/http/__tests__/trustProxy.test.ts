import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { trustProxyOption } from "../trustProxy";

describe("trustProxyOption", () => {
  it("is off (false) when hops is 0 or negative", () => {
    expect(trustProxyOption(0)).toBe(false);
    expect(trustProxyOption(-1)).toBe(false);
  });

  it("trusts exactly N hops", () => {
    const fn = trustProxyOption(2);
    if (!fn) throw new Error("expected a function");
    expect(fn("10.0.0.1", 0)).toBe(true);
    expect(fn("10.0.0.1", 1)).toBe(true);
    expect(fn("10.0.0.1", 2)).toBe(false);
  });

  async function ipFor(hops: number, xff: string): Promise<string> {
    const app = Fastify({ trustProxy: trustProxyOption(hops) });
    app.get("/ip", async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "10.0.0.9",
      headers: { "x-forwarded-for": xff },
    });
    await app.close();
    return res.json().ip;
  }

  it("unset → req.ip is the TCP peer, X-Forwarded-For ignored", async () => {
    expect(await ipFor(0, "1.1.1.1, 2.2.2.2")).toBe("10.0.0.9");
  });

  it("1 hop → req.ip is the right-most X-Forwarded-For entry", async () => {
    expect(await ipFor(1, "1.1.1.1, 2.2.2.2")).toBe("2.2.2.2");
  });

  it("2 hops → req.ip is the second-from-right entry", async () => {
    expect(await ipFor(2, "1.1.1.1, 2.2.2.2")).toBe("1.1.1.1");
  });
});
