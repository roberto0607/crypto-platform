/**
 * optionsGammaService.ts — BTC options gamma exposure from Deribit.
 *
 * Fetches all near-term BTC options (≤7 days to expiry), calculates:
 *   - Max pain: strike where most options expire worthless
 *   - Net gamma exposure: dealer hedging pressure by strike
 *   - Gamma flip level: where dealer gamma transitions +/−
 *   - Key levels: largest call walls and put walls
 *   - Market structure: derived regime from gamma positioning
 *
 * Polls every 5 minutes. Deribit public API, no auth required.
 */

// ── Types ──

interface DeribitInstrument {
    instrument_name: string;
    expiration_timestamp: number;
    strike: number;
    option_type: "call" | "put";
}

interface OptionData {
    instrument_name: string;
    strike: number;
    type: "call" | "put";
    openInterest: number;
    gamma: number;
    delta: number;
    markPrice: number;
    expiration: number;
}

interface GammaReading {
    timestamp: number;
    btcPrice: number;
    maxPain: {
        strike: number;
        distanceFromPrice: number;
        distancePercent: number;
        pullStrength: string;
    };
    netGamma: {
        total: number;
        regime: string;
        meaning: string;
    };
    gammaFlip: {
        strike: number;
        distanceFromPrice: number;
        priceAboveFlip: boolean;
    };
    keyLevels: {
        strike: number;
        netGamma: number;
        type: string;
    }[];
    marketStructure: string;
}

interface GammaSnapshot extends GammaReading {
    history: {
        timestamp: number;
        maxPainStrike: number;
        totalNetGamma: number;
        gammaFlipStrike: number;
    }[];
}

// ── Constants ──

const POLL_MS = 5 * 60_000;
const HISTORY_MAX = 72; // 72 × 5min = 6 hours
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500;
const LOG_INTERVAL_MS = 5 * 60_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DERIBIT_BASE = "https://www.deribit.com/api/v2/public";

// ── State ──

let history: GammaReading[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;

// ── Helpers ──

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function parseInstrumentName(name: string): { strike: number; type: "call" | "put" } | null {
    // e.g. "BTC-28MAR25-70000-C"
    const parts = name.split("-");
    if (parts.length < 4) return null;
    const strike = parseInt(parts[2]!, 10);
    const typeChar = parts[3]!.toUpperCase();
    if (isNaN(strike)) return null;
    if (typeChar !== "C" && typeChar !== "P") return null;
    return { strike, type: typeChar === "C" ? "call" : "put" };
}

// ── Deribit API ──

async function fetchInstruments(): Promise<DeribitInstrument[]> {
    const url = `${DERIBIT_BASE}/get_instruments?currency=BTC&kind=option&expired=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Deribit instruments: ${res.status}`);

    const json = (await res.json()) as {
        result: {
            instrument_name: string;
            expiration_timestamp: number;
            strike: number;
            option_type: "call" | "put";
        }[];
    };

    const now = Date.now();
    const cutoff = now + SEVEN_DAYS_MS;

    return json.result.filter((i) =>
        i.instrument_name.includes("BTC") &&
        i.expiration_timestamp <= cutoff,
    );
}

async function fetchTicker(instrumentName: string): Promise<OptionData | null> {
    const url = `${DERIBIT_BASE}/ticker?instrument_name=${encodeURIComponent(instrumentName)}`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const json = (await res.json()) as {
        result: {
            mark_price: number;
            open_interest: number;
            greeks?: {
                delta: number;
                gamma: number;
                vega: number;
            };
            underlying_price?: number;
        };
    };

    const r = json.result;
    if (!r.greeks || r.greeks.gamma == null) return null;

    const parsed = parseInstrumentName(instrumentName);
    if (!parsed) return null;

    return {
        instrument_name: instrumentName,
        strike: parsed.strike,
        type: parsed.type,
        openInterest: r.open_interest,
        gamma: r.greeks.gamma,
        delta: r.greeks.delta,
        markPrice: r.mark_price,
        expiration: 0, // not needed after filtering
    };
}

async function fetchAllTickers(instruments: DeribitInstrument[]): Promise<{ options: OptionData[]; btcPrice: number }> {
    const options: OptionData[] = [];
    let btcPrice = 0;

    for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
        const batch = instruments.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(batch.map((inst) => fetchTicker(inst.instrument_name)));

        for (const r of results) {
            if (r.status === "fulfilled" && r.value) {
                options.push(r.value);
            }
        }

        // Extract BTC price from first successful ticker
        if (btcPrice === 0 && options.length > 0) {
            // Fetch BTC index price from Deribit
            try {
                const idxRes = await fetch(`${DERIBIT_BASE}/get_index_price?index_name=btc_usd`);
                if (idxRes.ok) {
                    const idxJson = (await idxRes.json()) as { result: { index_price: number } };
                    btcPrice = idxJson.result.index_price;
                }
            } catch { /* fallback below */ }
        }

        if (i + BATCH_SIZE < instruments.length) {
            await sleep(BATCH_DELAY_MS);
        }
    }

    return { options, btcPrice };
}

// ── Calculations ──

function calcMaxPain(options: OptionData[], strikes: number[]): number {
    let minPain = Infinity;
    let maxPainStrike = strikes[0] ?? 0;

    for (const testStrike of strikes) {
        let totalPain = 0;

        for (const opt of options) {
            if (opt.type === "call" && testStrike > opt.strike) {
                totalPain += (testStrike - opt.strike) * opt.openInterest;
            } else if (opt.type === "put" && testStrike < opt.strike) {
                totalPain += (opt.strike - testStrike) * opt.openInterest;
            }
        }

        if (totalPain < minPain) {
            minPain = totalPain;
            maxPainStrike = testStrike;
        }
    }

    return maxPainStrike;
}

function calcNetGammaByStrike(
    options: OptionData[],
    btcPrice: number,
): Map<number, number> {
    const gammaByStrike = new Map<number, number>();

    for (const opt of options) {
        // dollarGamma = gamma × openInterest × btcPrice² × 0.01
        const dollarGamma = opt.gamma * opt.openInterest * btcPrice * btcPrice * 0.01;
        const current = gammaByStrike.get(opt.strike) ?? 0;

        if (opt.type === "call") {
            gammaByStrike.set(opt.strike, current + dollarGamma);
        } else {
            gammaByStrike.set(opt.strike, current - dollarGamma);
        }
    }

    return gammaByStrike;
}

function findGammaFlip(gammaByStrike: Map<number, number>): number {
    const sorted = [...gammaByStrike.entries()].sort((a, b) => a[0] - b[0]);

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]![1];
        const curr = sorted[i]![1];

        // Sign change
        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
            // Interpolate between the two strikes
            const prevStrike = sorted[i - 1]![0];
            const currStrike = sorted[i]![0];
            // Weighted average based on magnitude
            const totalAbs = Math.abs(prev) + Math.abs(curr);
            if (totalAbs === 0) return (prevStrike + currStrike) / 2;
            return prevStrike + (currStrike - prevStrike) * (Math.abs(prev) / totalAbs);
        }
    }

    // No flip found — return strike with smallest absolute gamma
    if (sorted.length === 0) return 0;
    let minAbs = Infinity;
    let minStrike = sorted[0]![0];
    for (const [strike, gamma] of sorted) {
        if (Math.abs(gamma) < minAbs) {
            minAbs = Math.abs(gamma);
            minStrike = strike;
        }
    }
    return minStrike;
}

function findKeyLevels(gammaByStrike: Map<number, number>): GammaReading["keyLevels"] {
    const entries = [...gammaByStrike.entries()];

    // Call walls: largest positive gamma (market makers short calls → sell on rally)
    const callWalls = entries
        .filter(([, g]) => g > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([strike, netGamma]) => ({ strike, netGamma, type: "CALL_WALL" as const }));

    // Put walls: largest negative gamma (market makers short puts → buy on dip)
    const putWalls = entries
        .filter(([, g]) => g < 0)
        .sort((a, b) => a[1] - b[1])
        .slice(0, 3)
        .map(([strike, netGamma]) => ({ strike, netGamma, type: "PUT_WALL" as const }));

    return [...callWalls, ...putWalls].sort((a, b) => a.strike - b.strike);
}

function determineMarketStructure(
    btcPrice: number,
    maxPainStrike: number,
    gammaFlipStrike: number,
    callWallStrike: number | undefined,
    putWallStrike: number | undefined,
): string {
    const maxPainDist = Math.abs((btcPrice - maxPainStrike) / btcPrice) * 100;

    if (maxPainDist < 1) return "PINNED_TO_MAX_PAIN";
    if (btcPrice > gammaFlipStrike) return "ABOVE_GAMMA_FLIP";
    if (btcPrice < gammaFlipStrike) return "BELOW_GAMMA_FLIP";
    if (callWallStrike && putWallStrike && btcPrice < callWallStrike && btcPrice > putWallStrike) {
        return "BETWEEN_WALLS";
    }
    return "BETWEEN_WALLS";
}

// ── Poll ──

async function poll(): Promise<void> {
    try {
        const instruments = await fetchInstruments();

        if (instruments.length < 10) {
            console.warn(`[GammaService] Only ${instruments.length} instruments found, skipping cycle`);
            return;
        }

        const { options, btcPrice } = await fetchAllTickers(instruments);

        if (options.length < 10) {
            console.warn(`[GammaService] Only ${options.length} options with greeks, skipping cycle`);
            return;
        }

        if (btcPrice === 0) {
            console.warn("[GammaService] Could not determine BTC price, skipping cycle");
            return;
        }

        // Unique strikes
        const strikes = [...new Set(options.map((o) => o.strike))].sort((a, b) => a - b);

        // Max pain
        const maxPainStrike = calcMaxPain(options, strikes);
        const maxPainDist = btcPrice - maxPainStrike;
        const maxPainDistPct = (maxPainDist / btcPrice) * 100;
        const absPct = Math.abs(maxPainDistPct);
        const pullStrength = absPct < 1 ? "STRONG" : absPct < 3 ? "MODERATE" : "WEAK";

        // Net gamma by strike
        const gammaByStrike = calcNetGammaByStrike(options, btcPrice);
        const totalNetGamma = [...gammaByStrike.values()].reduce((s, v) => s + v, 0);
        const gammaRegime = totalNetGamma >= 0 ? "POSITIVE" : "NEGATIVE";
        const gammaMeaning = gammaRegime === "NEGATIVE"
            ? "Dealers are short gamma — hedging amplifies mean reversion. Dips get bought, rallies get sold."
            : "Dealers are long gamma — hedging amplifies trends. Momentum moves can accelerate.";

        // Gamma flip
        const gammaFlipStrike = findGammaFlip(gammaByStrike);

        // Key levels
        const keyLevels = findKeyLevels(gammaByStrike);
        const topCallWall = keyLevels.find((l) => l.type === "CALL_WALL");
        const topPutWall = keyLevels.find((l) => l.type === "PUT_WALL");

        // Market structure
        const marketStructure = determineMarketStructure(
            btcPrice, maxPainStrike, gammaFlipStrike,
            topCallWall?.strike, topPutWall?.strike,
        );

        const reading: GammaReading = {
            timestamp: Date.now(),
            btcPrice,
            maxPain: {
                strike: maxPainStrike,
                distanceFromPrice: Math.round(maxPainDist),
                distancePercent: Math.round(maxPainDistPct * 100) / 100,
                pullStrength,
            },
            netGamma: {
                total: Math.round(totalNetGamma),
                regime: gammaRegime,
                meaning: gammaMeaning,
            },
            gammaFlip: {
                strike: Math.round(gammaFlipStrike),
                distanceFromPrice: Math.round(btcPrice - gammaFlipStrike),
                priceAboveFlip: btcPrice > gammaFlipStrike,
            },
            keyLevels,
            marketStructure,
        };

        history.push(reading);
        if (history.length > HISTORY_MAX) {
            history = history.slice(-HISTORY_MAX);
        }

        if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
            console.log(
                `[GammaService] Max pain: $${maxPainStrike} | ` +
                `Gamma flip: $${Math.round(gammaFlipStrike)} | ` +
                `Net gamma: ${Math.round(totalNetGamma)} | ` +
                `Regime: ${gammaRegime} | ` +
                `Instruments: ${options.length}`,
            );
            lastLogTime = Date.now();
        }
    } catch (err) {
        console.warn("[GammaService] Poll error:", err);
    }
}

// ── Public API ──

export function getCurrentGammaSignal(): GammaSnapshot | null {
    if (history.length === 0) return null;

    const latest = history[history.length - 1]!;

    return {
        ...latest,
        history: history.map((r) => ({
            timestamp: r.timestamp,
            maxPainStrike: r.maxPain.strike,
            totalNetGamma: r.netGamma.total,
            gammaFlipStrike: r.gammaFlip.strike,
        })),
    };
}

export function initOptionsGamma(): void {
    if (interval) return;
    console.log("[GammaService] Initialized, polling every 5m");
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopOptionsGamma(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
