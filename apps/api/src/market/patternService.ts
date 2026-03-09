/**
 * Pattern detection service — fetches chart patterns from the ML service.
 */
import { config } from "../config.js";
import { logger as rootLogger } from "../observability/logContext.js";

const logger = rootLogger.child({ module: "patternService" });

export interface ChartPattern {
    type: string;
    status: string;
    completionPct: number;
    completionProb: number;
    impliedDirection: string;
    entryZone: number;
    targetPrice: number;
    invalidationPrice: number;
    keyPoints: { time: number; price: number; label: string }[];
    projection: { time: number; price: number }[];
}

/**
 * Fetch chart patterns from the ML service's /predict endpoint.
 * Returns only the patterns array (empty if ML service unavailable).
 */
export interface ScenarioCandle {
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    confidence: number;
}

export interface PriceScenario {
    name: string;
    probability: number;
    finalPrice: number;
    totalReturnPct: number;
    candles: ScenarioCandle[];
}

interface ScenariosResponse {
    pair: string;
    timeframe: string;
    currentPrice: number;
    generatedAt: string;
    scenarios: PriceScenario[];
    inputs: Record<string, unknown>;
}

/**
 * Fetch ghost candle scenarios from the ML service's /predict/{symbol}/scenarios endpoint.
 */
export async function fetchScenarios(
    pairSymbol: string,
    timeframe: string = "1h",
): Promise<ScenariosResponse | null> {
    const urlSymbol = pairSymbol.replace("/", "-");
    const url = `${config.mlServiceUrl}/predict/${urlSymbol}/scenarios?timeframe=${timeframe}`;

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
        logger.warn({ err: (err as Error).message, url }, "ml_service_unreachable_scenarios");
        return null;
    }

    if (!response.ok) {
        logger.warn({ status: response.status, url }, "ml_service_error_scenarios");
        return null;
    }

    return (await response.json()) as ScenariosResponse;
}

export async function fetchPatterns(
    pairSymbol: string,
    timeframe: string = "1h",
): Promise<ChartPattern[]> {
    const urlSymbol = pairSymbol.replace("/", "-");
    const url = `${config.mlServiceUrl}/predict/${urlSymbol}?timeframe=${timeframe}`;

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
        logger.warn({ err: (err as Error).message, url }, "ml_service_unreachable_patterns");
        return [];
    }

    if (!response.ok) {
        logger.warn({ status: response.status, url }, "ml_service_error_patterns");
        return [];
    }

    const data = await response.json() as { patterns?: ChartPattern[] };
    return data.patterns ?? [];
}
