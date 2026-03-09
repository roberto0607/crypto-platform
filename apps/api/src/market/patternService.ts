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
