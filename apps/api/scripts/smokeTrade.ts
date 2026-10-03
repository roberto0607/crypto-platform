/**
 * smokeTrade.ts — post-deploy trading smoke test against a live API.
 *
 *   npx tsx scripts/smokeTrade.ts                     (from apps/api)
 *   SMOKE_API=http://localhost:3001 npx tsx scripts/smokeTrade.ts
 *
 * Logs in (email + hidden password, prompted on the terminal), reads the live
 * Kraken best bid/ask for BTC/USD from the API, places a ~$50 MARKET BUY, and
 * immediately closes it with a MARKET SELL of the filled qty. PASS when the
 * buy's average fill price is within 10bps of the best ask read just before
 * the order; exit 0 on PASS, 1 otherwise.
 *
 * Credentials are only ever read interactively — never from argv or env — and
 * neither they nor the access token are printed. Uses the account's free-play
 * wallet; the round trip costs fees plus the spread (a few cents).
 */

const API = (process.env.SMOKE_API ?? "https://api.playtradr.com").replace(/\/+$/, "");
const SYMBOL = "BTC/USD";
const NOTIONAL_USD = 50;
const MAX_DEVIATION_BPS = 10;
const CLOSE_ATTEMPTS = 5;
const CLOSE_RETRY_MS = 3_000;

// ── Terminal prompts ─────────────────────────────────────

/** Input typed (or pasted) past the end of the previous prompt's line. */
let pendingInput = "";

function readLine(prompt: string, hidden: boolean): Promise<string> {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
        throw new Error("smokeTrade must be run in an interactive terminal (credentials are prompted, never piped)");
    }
    process.stdout.write(prompt);
    return new Promise((resolve, reject) => {
        let value = "";
        const finish = (err?: Error) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stdout.write("\n");
            if (err) reject(err);
            else resolve(value);
        };
        /** Consume chars; true once the line is complete (rest kept for the next prompt). */
        const consume = (chunk: string): boolean => {
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i]!;
                if (ch === "\r" || ch === "\n") {
                    pendingInput = chunk.slice(chunk[i + 1] === "\n" && ch === "\r" ? i + 2 : i + 1);
                    finish();
                    return true;
                }
                if (ch === "\u0003") { finish(new Error("aborted")); return true; }   // Ctrl-C
                if (ch === "\u007f" || ch === "\b") {                                // backspace
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        if (!hidden) process.stdout.write("\b \b");
                    }
                    continue;
                }
                if (ch < " ") continue;                                               // other control chars
                value += ch;
                if (!hidden) process.stdout.write(ch);
            }
            return false;
        };
        const onData = (chunk: string) => { consume(chunk); };

        stdin.setRawMode(true);
        stdin.setEncoding("utf8");
        const carried = pendingInput;
        pendingInput = "";
        if (carried && consume(carried)) return;
        stdin.on("data", onData);
        stdin.resume();
    });
}

// ── HTTP ─────────────────────────────────────────────────

type ApiResult = { status: number; body: any };

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<ApiResult> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
    const res = await fetch(API + path, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
    return { status: res.status, body };
}

/** Error code from an API error body — never echoes the request. */
function errCode(r: ApiResult): string {
    return r.body?.error ?? r.body?.code ?? r.body?.raw ?? "unknown_error";
}

// ── Pure helpers ─────────────────────────────────────────

type Fill = { price: string; qty: string; is_system_fill?: boolean };

/** Quantity-weighted average fill price. */
export function avgFillPrice(fills: Fill[]): number {
    const qty = fills.reduce((s, f) => s + Number(f.qty), 0);
    const notional = fills.reduce((s, f) => s + Number(f.qty) * Number(f.price), 0);
    return qty > 0 ? notional / qty : NaN;
}

/** Signed deviation of `price` from `reference`, in bps (+ = paid above). */
export function deviationBps(price: number, reference: number): number {
    return ((price - reference) / reference) * 10_000;
}

/** qty for ~`usd` notional at `price`, 8dp, rounded down. */
export function qtyForNotional(usd: number, price: number): string {
    return (Math.floor((usd / price) * 1e8) / 1e8).toFixed(8);
}

// ── Main ─────────────────────────────────────────────────

function fmt(n: number, dp = 2): string {
    return n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

async function closePosition(token: string, pairId: string, qty: string): Promise<boolean> {
    for (let attempt = 1; attempt <= CLOSE_ATTEMPTS; attempt++) {
        let r: ApiResult;
        try {
            r = await api("POST", "/orders", { token, body: { pairId, side: "SELL", type: "MARKET", qty } });
        } catch (err) {
            r = { status: 0, body: { error: err instanceof Error ? err.message : "network_error" } };
        }
        if (r.status === 201) {
            const px = avgFillPrice(r.body.fills ?? []);
            console.log(`Closed:            SELL ${qty} BTC @ ${fmt(px)} (${r.body.order?.status})`);
            return true;
        }
        const code = errCode(r);
        console.log(`Close attempt ${attempt}/${CLOSE_ATTEMPTS} failed: HTTP ${r.status} ${code}`);
        if (attempt < CLOSE_ATTEMPTS) await new Promise((res) => setTimeout(res, CLOSE_RETRY_MS));
    }
    console.log(`\n!! POSITION NOT CLOSED — sell ${qty} BTC on ${SYMBOL} manually.`);
    return false;
}

async function main(): Promise<number> {
    console.log(`TRADR smoke trade → ${API}\n`);

    const email = (await readLine("Email: ", false)).trim();
    const password = await readLine("Password: ", true);
    if (!email || !password) {
        console.log("FAIL — email and password are required");
        return 1;
    }

    const login = await api("POST", "/auth/login", { body: { email, password } });
    if (login.status !== 200 || !login.body?.accessToken) {
        console.log(`FAIL — login: HTTP ${login.status} ${errCode(login)}`);
        return 1;
    }
    const token: string = login.body.accessToken;
    console.log("Logged in.");

    const pairs = await api("GET", "/pairs", { token });
    const pair = (pairs.body?.pairs ?? []).find((p: { symbol: string }) => p.symbol === SYMBOL);
    if (!pair) {
        console.log(`FAIL — ${SYMBOL} not found (HTTP ${pairs.status} ${pairs.status === 200 ? "" : errCode(pairs)})`);
        return 1;
    }

    // Kraken top of book, read immediately before the order.
    const book = await api("GET", `/market/book/${SYMBOL.replace("/", "-")}`);
    const bestBid = Number(book.body?.book?.bids?.[0]?.price);
    const bestAsk = Number(book.body?.book?.asks?.[0]?.price);
    if (!(bestAsk > 0) || !(bestBid > 0)) {
        console.log(`FAIL — no Kraken book from the API (HTTP ${book.status}); the feed may be down`);
        return 1;
    }
    console.log(`Kraken best bid:   ${fmt(bestBid)}`);
    console.log(`Kraken best ask:   ${fmt(bestAsk)}  (at order time)`);

    const qty = qtyForNotional(NOTIONAL_USD, bestAsk);
    const buy = await api("POST", "/orders", { token, body: { pairId: pair.id, side: "BUY", type: "MARKET", qty } });

    if (buy.status !== 201) {
        const code = errCode(buy);
        if (code === "stale_price_source") {
            console.log("\nREJECTED: stale_price_source — the server's Kraken book was older than its freshness limit,");
            console.log("so market orders are paused. Nothing was bought; nothing to close. Re-run once the feed recovers.");
        } else {
            console.log(`\nREJECTED: HTTP ${buy.status} ${code}. Nothing was bought; nothing to close.`);
        }
        console.log("\nFAIL");
        return 1;
    }

    // From here on a position exists: always close it, whatever the checks say.
    const filledQty: string = buy.body.order?.qty_filled ?? qty;
    let verdict = 1;
    try {
        const fills: Fill[] = buy.body.fills ?? [];
        const fillPx = avgFillPrice(fills);
        const dev = deviationBps(fillPx, bestAsk);
        const source = fills.every((f) => f.is_system_fill) ? "system fill"
            : fills.some((f) => f.is_system_fill) ? "book + system fill" : "book (resting order)";

        console.log(`Bought:            ${filledQty} BTC (~$${NOTIONAL_USD}), ${fills.length} fill(s), ${source}`);
        console.log(`Fill price:        ${fmt(fillPx)}`);
        console.log(`Deviation vs ask:  ${dev >= 0 ? "+" : ""}${fmt(dev, 1)} bps  (limit ±${MAX_DEVIATION_BPS})`);

        verdict = Number.isFinite(dev) && Math.abs(dev) <= MAX_DEVIATION_BPS ? 0 : 1;
    } finally {
        const closed = await closePosition(token, pair.id, filledQty);
        if (!closed) verdict = 1;
    }

    console.log(`\n${verdict === 0 ? "PASS" : "FAIL"}`);
    return verdict;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.log(`FAIL — ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    },
);
