/**
 * Derivatives poller — fetches funding rates, OI, and L/S ratios from
 * Binance Futures, computes liquidation pressure, caches in memory.
 */

import {
    BINANCE_PAIR_MAP,
    fetchFundingRate,
    fetchOpenInterest,
    fetchGlobalLSRatio,
    fetchTopTraderLSRatio,
} from "./binanceFutures.js";
import { logger } from "../observability/logContext.js";

// ── Types ──

export interface DerivativesSnapshot {
    fundingRate: number;
    fundingTime: number;
    markPrice: number;
    openInterest: number;
    openInterestUsd: number;
    oiChangePct: number;
    globalLsRatio: number;
    globalLongPct: number;
    globalShortPct: number;
    topLsRatio: number;
    topLongPct: number;
    topShortPct: number;
    liqPressure: number;
    liqIntensity: number;
    ts: number;
}

// ── In-memory state ──

const derivativesCache = new Map<string, DerivativesSnapshot>();
const prevOI = new Map<string, number>();
const prevMarkPrice = new Map<string, number>();

// ── Accessors ──

export function getDerivatives(pairId: string): DerivativesSnapshot | null {
    return derivativesCache.get(pairId) ?? null;
}

/** Load latest snapshot from DB into cache (fallback when poller hasn't run). */
export async function loadDerivativesFromDB(pairId: string): Promise<DerivativesSnapshot | null> {
    if (derivativesCache.has(pairId)) return derivativesCache.get(pairId)!;
    try {
        const { pool } = await import("../db/pool.js");
        const row = await pool.query(
            `SELECT * FROM derivatives_snapshots WHERE pair_id = $1 ORDER BY ts DESC LIMIT 1`,
            [pairId],
        );
        if (row.rows.length === 0) return null;
        const r = row.rows[0];
        const snap: DerivativesSnapshot = {
            fundingRate: Number(r.funding_rate ?? 0),
            fundingTime: r.funding_time ? new Date(r.funding_time).getTime() : Date.now(),
            markPrice: Number(r.mark_price ?? 0),
            openInterest: Number(r.open_interest ?? 0),
            openInterestUsd: Number(r.open_interest_usd ?? 0),
            oiChangePct: Number(r.oi_change_pct ?? 0),
            globalLsRatio: Number(r.global_ls_ratio ?? 1),
            globalLongPct: Number(r.global_long_pct ?? 0.5),
            globalShortPct: Number(r.global_short_pct ?? 0.5),
            topLsRatio: Number(r.top_ls_ratio ?? 1),
            topLongPct: Number(r.top_long_pct ?? 0.5),
            topShortPct: Number(r.top_short_pct ?? 0.5),
            liqPressure: Number(r.liq_pressure ?? 0),
            liqIntensity: Number(r.liq_intensity ?? 0),
            ts: new Date(r.ts).getTime(),
        };
        derivativesCache.set(pairId, snap);
        return snap;
    } catch {
        return null;
    }
}

export function getAllDerivatives(): Map<string, DerivativesSnapshot> {
    return derivativesCache;
}

// ── Liquidation inference ──

function computeLiquidation(
    currentOI: number,
    previousOI: number,
    currentPrice: number,
    previousPrice: number,
): { pressure: number; intensity: number } {
    if (previousOI === 0 || previousPrice === 0) {
        return { pressure: 0, intensity: 0 };
    }

    const oiChange = (currentOI - previousOI) / previousOI;

    // OI must drop for liquidations to have occurred
    if (oiChange >= 0) return { pressure: 0, intensity: 0 };

    const intensity = Math.min(Math.abs(oiChange), 1);
    const priceChange = (currentPrice - previousPrice) / previousPrice;

    // OI drops + price drops => longs liquidated (negative pressure)
    // OI drops + price rises => shorts liquidated (positive pressure)
    const direction = priceChange >= 0 ? 1 : -1;
    const pressure = direction * intensity;

    return {
        pressure: Math.round(pressure * 10000) / 10000,
        intensity: Math.round(intensity * 10000) / 10000,
    };
}

// ── Poll a single pair ──

export async function pollDerivativesForPair(
    pairId: string,
    ourSymbol: string,
): Promise<void> {
    const binanceSymbol = BINANCE_PAIR_MAP[ourSymbol];
    if (!binanceSymbol) return;

    // Fetch all 4 endpoints in parallel
    const [funding, oi, globalLS, topLS] = await Promise.all([
        fetchFundingRate(binanceSymbol),
        fetchOpenInterest(binanceSymbol),
        fetchGlobalLSRatio(binanceSymbol),
        fetchTopTraderLSRatio(binanceSymbol),
    ]);

    // Need at least funding or OI to produce a useful snapshot
    if (!funding && !oi) return;

    const markPrice = funding ? parseFloat(funding.markPrice) : 0;
    const fundingRate = funding ? parseFloat(funding.fundingRate) : 0;
    const fundingTime = funding ? funding.fundingTime : 0;

    const openInterest = oi ? parseFloat(oi.openInterest) : 0;
    const openInterestUsd = markPrice > 0
        ? openInterest * markPrice
        : openInterest;

    // Compute OI change vs previous snapshot
    const prev = prevOI.get(pairId) ?? 0;
    const oiChangePct = prev > 0
        ? ((openInterest - prev) / prev) * 100
        : 0;

    // Compute liquidation pressure
    const prevPrice = prevMarkPrice.get(pairId) ?? 0;
    const { pressure, intensity } = computeLiquidation(
        openInterest, prev, markPrice, prevPrice,
    );

    // Update previous values for next cycle
    if (openInterest > 0) prevOI.set(pairId, openInterest);
    if (markPrice > 0) prevMarkPrice.set(pairId, markPrice);

    const snapshot: DerivativesSnapshot = {
        fundingRate,
        fundingTime,
        markPrice,
        openInterest,
        openInterestUsd,
        oiChangePct,
        globalLsRatio: globalLS ? parseFloat(globalLS.longShortRatio) : 1,
        globalLongPct: globalLS ? parseFloat(globalLS.longAccount) : 0.5,
        globalShortPct: globalLS ? parseFloat(globalLS.shortAccount) : 0.5,
        topLsRatio: topLS ? parseFloat(topLS.longShortRatio) : 1,
        topLongPct: topLS ? parseFloat(topLS.longAccount) : 0.5,
        topShortPct: topLS ? parseFloat(topLS.shortAccount) : 0.5,
        liqPressure: pressure,
        liqIntensity: intensity,
        ts: Date.now(),
    };

    derivativesCache.set(pairId, snapshot);

    logger.debug(
        { pairId, ourSymbol, fundingRate, openInterestUsd: Math.round(openInterestUsd), oiChangePct },
        "derivatives_polled",
    );
}
