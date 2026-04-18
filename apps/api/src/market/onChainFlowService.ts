/**
 * onChainFlowService.ts — On-chain activity signal for BTC.
 *
 * Combines blockchain.info chart data (tx volume BTC/USD, tx count)
 * with mempool.space (mempool size, fee rates) to produce an
 * on-chain activity signal detecting whale movements and network pressure.
 *
 * Polls every 15 minutes.
 */

// ── Types ──

interface BlockchainChartPoint {
    x: number; // unix seconds
    y: number;
}

interface OnChainReading {
    timestamp: number;
    dataSource: string;
    netFlow24h: number;        // volume deviation from mean (BTC)
    netFlowDollar24h: number;  // volume deviation from mean (USD)
    exchangeReserve: number;   // mempool vsize as "pending reserve"
    reserveChange24h: number;  // not available — 0
    signal: string;
    trend: string;
    reserveTrend: string;
    smartMoneySignal: string;
    confidence: string;
    // Extra fields for richer data
    volumeBtc: number;
    volumeUsd: number;
    txCount: number;
    avgVolumeBtc: number;
    avgVolumeUsd: number;
    avgTxCount: number;
    volumeSpikeRatio: number;  // today / 5-day avg
    whaleRatio: number;        // USD volume per BTC — high = whale activity
    avgWhaleRatio: number;
    mempoolSize: number;       // vsize bytes
    mempoolTxCount: number;
    feeRateFast: number;       // sat/vB
    feeRateEcon: number;       // sat/vB
}

interface OnChainSnapshot extends Omit<OnChainReading, never> {
    history: {
        timestamp: number;
        netFlow: number;
        signal: string;
        reserveChange: number;
    }[];
    lastUpdated: number;
    dataAge: string;
}

// ── Constants ──

const POLL_MS = 15 * 60_000;
const HISTORY_MAX = 96; // 24h
const FETCH_TIMEOUT_MS = 10_000;
const LOG_INTERVAL_MS = 15 * 60_000;

const BLOCKCHAIN_API = "https://api.blockchain.info/charts";
const MEMPOOL_API = "https://mempool.space/api";

// ── State ──

let history: OnChainReading[] = [];
let lastLogTime = 0;
let interval: ReturnType<typeof setInterval> | null = null;
let lastSuccessfulUpdate = 0;

// ── Fetch with timeout ──

async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ── blockchain.info fetchers ──

async function fetchChart(name: string): Promise<BlockchainChartPoint[]> {
    const url = `${BLOCKCHAIN_API}/${name}?timespan=5days&format=json`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`blockchain.info ${name}: ${res.status}`);
    const json = (await res.json()) as { values?: BlockchainChartPoint[] };
    return json.values ?? [];
}

// ── mempool.space fetchers ──

interface MempoolData {
    count: number;
    vsize: number;
    total_fee: number;
}

interface FeeData {
    fastestFee: number;
    halfHourFee: number;
    hourFee: number;
    economyFee: number;
    minimumFee: number;
}

async function fetchMempool(): Promise<MempoolData | null> {
    try {
        const res = await fetchWithTimeout(`${MEMPOOL_API}/mempool`);
        if (!res.ok) return null;
        return (await res.json()) as MempoolData;
    } catch (err) {
        console.warn("[OnChain] mempool.space mempool error:", (err as Error).message);
        return null;
    }
}

async function fetchFees(): Promise<FeeData | null> {
    try {
        const res = await fetchWithTimeout(`${MEMPOOL_API}/v1/fees/recommended`);
        if (!res.ok) return null;
        return (await res.json()) as FeeData;
    } catch (err) {
        console.warn("[OnChain] mempool.space fees error:", (err as Error).message);
        return null;
    }
}

// ── Signal logic ──

function calcSignal(spikeRatio: number, whaleRatioVsAvg: number, mempoolSize: number): string {
    // spikeRatio: today's volume / 5-day average
    // whaleRatioVsAvg: current whale ratio / avg whale ratio
    // mempoolSize: pending tx bytes

    const highVolume = spikeRatio > 1.5;
    const veryHighVolume = spikeRatio > 2.0;
    const whaleActive = whaleRatioVsAvg > 1.3;
    const bigMempool = mempoolSize > 100_000_000; // >100MB

    if (veryHighVolume && whaleActive) return "HEAVY_WHALE_ACTIVITY";
    if (highVolume && whaleActive) return "MODERATE_WHALE_ACTIVITY";
    if (veryHighVolume) return "HIGH_NETWORK_ACTIVITY";
    if (highVolume || bigMempool) return "ELEVATED_ACTIVITY";
    if (spikeRatio < 0.5) return "QUIET_MARKET";
    return "NORMAL_ACTIVITY";
}

function calcTrend(values: BlockchainChartPoint[]): string {
    if (values.length < 3) return "STABLE";

    const mid = Math.floor(values.length / 2);
    const firstHalf = values.slice(0, mid).reduce((s, v) => s + v.y, 0) / mid;
    const secondHalf = values.slice(mid).reduce((s, v) => s + v.y, 0) / (values.length - mid);

    if (firstHalf === 0) return "STABLE";
    const changePct = ((secondHalf - firstHalf) / firstHalf) * 100;

    if (changePct > 20) return "ACCELERATING_INFLOW";
    if (changePct < -20) return "ACCELERATING_OUTFLOW";
    return "STABLE";
}

function calcMempoolTrend(mempoolSize: number, feeRate: number): string {
    // High mempool + high fees = congestion = lots of pending activity
    if (mempoolSize > 100_000_000 && feeRate > 20) return "INCREASING";
    if (mempoolSize < 10_000_000 && feeRate < 5) return "DECREASING";
    return "STABLE";
}

function calcSmartMoney(signal: string, trend: string, mempoolTrend: string): string {
    const whaleSignals = [
        signal.includes("WHALE"),
        signal === "HIGH_NETWORK_ACTIVITY",
    ].filter(Boolean).length;

    const quietSignals = [
        signal === "QUIET_MARKET",
        trend === "ACCELERATING_OUTFLOW",
        mempoolTrend === "DECREASING",
    ].filter(Boolean).length;

    // Whale activity + rising volume = distribution (selling)
    if (whaleSignals > 0 && trend === "ACCELERATING_INFLOW") return "DISTRIBUTION";
    // Whale activity + falling volume = accumulation (buying quietly)
    if (whaleSignals > 0 && trend === "ACCELERATING_OUTFLOW") return "ACCUMULATION";
    // Quiet market + low mempool = accumulation period
    if (quietSignals >= 2) return "ACCUMULATION";
    return "NEUTRAL";
}

function calcConfidence(signal: string, trend: string, mempoolTrend: string): string {
    const strongSignals = [
        signal.includes("HEAVY") || signal.includes("HIGH"),
        trend !== "STABLE",
        mempoolTrend !== "STABLE",
    ].filter(Boolean).length;

    if (strongSignals >= 3) return "HIGH";
    if (strongSignals >= 2) return "MEDIUM";
    return "LOW";
}

function formatDataAge(ts: number): string {
    if (ts === 0) return "no data yet";
    const diffMin = Math.round((Date.now() - ts) / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin === 1) return "1 minute ago";
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const h = Math.round(diffMin / 60);
    return `${h} hour${h > 1 ? "s" : ""} ago`;
}

// ── Poll ──

async function poll(): Promise<void> {
    try {
        // Fetch all data in parallel
        const [volBtcRaw, volUsdRaw, txCountRaw, mempool, fees] = await Promise.allSettled([
            fetchChart("estimated-transaction-volume"),
            fetchChart("estimated-transaction-volume-usd"),
            fetchChart("n-transactions"),
            fetchMempool(),
            fetchFees(),
        ]);

        // Log any rejected fetches so outages don't go unnoticed.
        if (volBtcRaw.status === "rejected") {
            console.warn("[OnChain] volBtc fetch rejected:", (volBtcRaw.reason as Error)?.message ?? volBtcRaw.reason);
        }
        if (volUsdRaw.status === "rejected") {
            console.warn("[OnChain] volUsd fetch rejected:", (volUsdRaw.reason as Error)?.message ?? volUsdRaw.reason);
        }
        if (txCountRaw.status === "rejected") {
            console.warn("[OnChain] txCount fetch rejected:", (txCountRaw.reason as Error)?.message ?? txCountRaw.reason);
        }
        if (mempool.status === "rejected") {
            console.warn("[OnChain] mempool fetch rejected:", (mempool.reason as Error)?.message ?? mempool.reason);
        }
        if (fees.status === "rejected") {
            console.warn("[OnChain] fees fetch rejected:", (fees.reason as Error)?.message ?? fees.reason);
        }

        const volBtc = volBtcRaw.status === "fulfilled" ? volBtcRaw.value : [];
        const volUsd = volUsdRaw.status === "fulfilled" ? volUsdRaw.value : [];
        const txCount = txCountRaw.status === "fulfilled" ? txCountRaw.value : [];
        const mempoolData = mempool.status === "fulfilled" ? mempool.value : null;
        const feeData = fees.status === "fulfilled" ? fees.value : null;

        if (volBtc.length === 0 && volUsd.length === 0) {
            console.warn("[OnChain] No blockchain.info data, skipping cycle");
            return;
        }

        // Latest values
        const latestBtcVol = volBtc.length > 0 ? volBtc[volBtc.length - 1]!.y : 0;
        const latestUsdVol = volUsd.length > 0 ? volUsd[volUsd.length - 1]!.y : 0;
        const latestTxCount = txCount.length > 0 ? txCount[txCount.length - 1]!.y : 0;

        // 5-day averages
        const avgBtcVol = volBtc.length > 0
            ? volBtc.reduce((s, v) => s + v.y, 0) / volBtc.length : 1;
        const avgUsdVol = volUsd.length > 0
            ? volUsd.reduce((s, v) => s + v.y, 0) / volUsd.length : 1;
        const avgTxCount = txCount.length > 0
            ? txCount.reduce((s, v) => s + v.y, 0) / txCount.length : 1;

        // Spike ratio: how much is today's volume vs average
        const spikeRatio = avgBtcVol > 0 ? latestBtcVol / avgBtcVol : 1;

        // Whale ratio: USD per BTC traded — higher = larger avg transaction value
        const whaleRatio = latestBtcVol > 0 ? latestUsdVol / latestBtcVol : 0;
        const avgWhaleRatio = avgBtcVol > 0 ? avgUsdVol / avgBtcVol : 1;
        const whaleRatioVsAvg = avgWhaleRatio > 0 ? whaleRatio / avgWhaleRatio : 1;

        // Mempool data
        const mempoolSize = mempoolData?.vsize ?? 0;
        const mempoolTxCount = mempoolData?.count ?? 0;
        const feeRateFast = feeData?.fastestFee ?? 0;
        const feeRateEcon = feeData?.economyFee ?? 0;

        // Derived signals
        const signal = calcSignal(spikeRatio, whaleRatioVsAvg, mempoolSize);
        const trend = calcTrend(volBtc);
        const reserveTrend = calcMempoolTrend(mempoolSize, feeRateFast);
        const smartMoneySignal = calcSmartMoney(signal, trend, reserveTrend);
        const confidence = calcConfidence(signal, trend, reserveTrend);

        // Net flow approximation: deviation from mean in BTC
        const netFlow24h = latestBtcVol - avgBtcVol;
        const netFlowDollar24h = latestUsdVol - avgUsdVol;

        const reading: OnChainReading = {
            timestamp: Date.now(),
            dataSource: "blockchain.info + mempool.space",
            netFlow24h: Math.round(netFlow24h * 100) / 100,
            netFlowDollar24h: Math.round(netFlowDollar24h),
            exchangeReserve: mempoolSize,
            reserveChange24h: 0,
            signal,
            trend,
            reserveTrend,
            smartMoneySignal,
            confidence,
            volumeBtc: Math.round(latestBtcVol * 100) / 100,
            volumeUsd: Math.round(latestUsdVol),
            txCount: Math.round(latestTxCount),
            avgVolumeBtc: Math.round(avgBtcVol * 100) / 100,
            avgVolumeUsd: Math.round(avgUsdVol),
            avgTxCount: Math.round(avgTxCount),
            volumeSpikeRatio: Math.round(spikeRatio * 100) / 100,
            whaleRatio: Math.round(whaleRatio),
            avgWhaleRatio: Math.round(avgWhaleRatio),
            mempoolSize,
            mempoolTxCount,
            feeRateFast,
            feeRateEcon,
        };

        history.push(reading);
        if (history.length > HISTORY_MAX) {
            history = history.slice(-HISTORY_MAX);
        }

        lastSuccessfulUpdate = Date.now();

        if (Date.now() - lastLogTime >= LOG_INTERVAL_MS) {
            const dollarStr = Math.abs(netFlowDollar24h) >= 1_000_000
                ? `$${(netFlowDollar24h / 1_000_000).toFixed(1)}M`
                : `$${(netFlowDollar24h / 1_000).toFixed(0)}K`;

            console.log(
                `[OnChain] Vol: ${latestBtcVol.toFixed(0)} BTC (${dollarStr} vs avg) | ` +
                `Spike: ${spikeRatio.toFixed(2)}x | Whale: ${whaleRatio.toFixed(0)} USD/BTC | ` +
                `Mempool: ${(mempoolSize / 1_000_000).toFixed(1)}MB (${mempoolTxCount} tx) | ` +
                `Fee: ${feeRateFast} sat/vB | Signal: ${signal} | ` +
                `Source: blockchain.info + mempool.space`,
            );
            lastLogTime = Date.now();
        }
    } catch (err) {
        console.warn("[OnChain] Poll error:", (err as Error).message);
    }
}

// ── Public API ──

export function getCurrentOnChainSignal(): OnChainSnapshot | null {
    if (history.length === 0) return null;

    const latest = history[history.length - 1]!;

    return {
        ...latest,
        history: history.map((r) => ({
            timestamp: r.timestamp,
            netFlow: r.netFlow24h,
            signal: r.signal,
            reserveChange: r.reserveChange24h,
        })),
        lastUpdated: lastSuccessfulUpdate,
        dataAge: formatDataAge(lastSuccessfulUpdate),
    };
}

export function initOnChainFlow(): void {
    if (interval) return;
    console.log("[OnChain] Service initialized, polling every 15m");
    poll();
    interval = setInterval(poll, POLL_MS);
}

export function stopOnChainFlow(): void {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }
}
