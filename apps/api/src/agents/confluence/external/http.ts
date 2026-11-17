/**
 * Small HTTP layer for the external sources: timeout, retries with
 * backoff on network errors / 429 / 5xx, and a distinct error for 404 (a
 * Binance archive day that doesn't exist). Injected so tests never hit the
 * network.
 */
const TIMEOUT_MS = 20_000;
/** Retries ride out a short network outage (DNS blips included): ~1 min of backoff in total. */
const RETRIES = 6;
const backoffMs = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

export class HttpNotFound extends Error {
  constructor(url: string) {
    super(`HTTP 404 ${url}`);
    this.name = "HttpNotFound";
  }
}

export interface Http {
  json(url: string): Promise<unknown>;
  buffer(url: string): Promise<Buffer>;
}

async function request(url: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) throw new HttpNotFound(url);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return res;
    } catch (err) {
      if (err instanceof HttpNotFound) throw err;
      if (err instanceof Error && err.message.startsWith("HTTP 4")) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`request failed: ${url}`);
}

export const defaultHttp: Http = {
  json: async (url) => (await request(url)).json(),
  buffer: async (url) => Buffer.from(await (await request(url)).arrayBuffer()),
};

export const pause = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());
