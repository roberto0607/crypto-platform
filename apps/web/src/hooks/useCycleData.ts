import { useEffect, useState, useCallback } from "react";
import {
    fetchCycleAnalysis,
    fetchCycleForecast,
    fetchCyclePerformance,
    type CycleAnalysis,
    type CycleForecast,
    type CyclePerformanceData,
} from "@/api/endpoints/marketData";

interface CycleDataState {
    data: CycleAnalysis | null;
    forecast: CycleForecast | null;
    performance: CyclePerformanceData | null;
    loading: boolean;
    error: string | null;
    /** True when the backend returned 503 "data still loading" — different UX. */
    upstreamLoading: boolean;
    /** Forecast can fail independently — show soft "unavailable" rather than hard error. */
    forecastError: boolean;
    performanceError: boolean;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min, matches backend cache TTL

export function useCycleData(): CycleDataState {
    const [data, setData] = useState<CycleAnalysis | null>(null);
    const [forecast, setForecast] = useState<CycleForecast | null>(null);
    const [performance, setPerformance] = useState<CyclePerformanceData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [upstreamLoading, setUpstreamLoading] = useState(false);
    const [forecastError, setForecastError] = useState(false);
    const [performanceError, setPerformanceError] = useState(false);

    const load = useCallback(async () => {
        const [analysisResult, forecastResult, perfResult] = await Promise.allSettled([
            fetchCycleAnalysis(),
            fetchCycleForecast(),
            fetchCyclePerformance(),
        ]);

        // Analysis drives the primary loading/error state
        if (analysisResult.status === "fulfilled") {
            setData(analysisResult.value.data);
            setUpstreamLoading(false);
            setError(null);
        } else {
            const status = (analysisResult.reason as { response?: { status?: number } })?.response?.status;
            if (status === 503) {
                setUpstreamLoading(true);
                setError(null);
            } else {
                setError("Unable to load cycle analysis. Check that the cycle engine service is running.");
                setUpstreamLoading(false);
            }
        }

        // Forecast is optional
        if (forecastResult.status === "fulfilled") {
            setForecast(forecastResult.value.data);
            setForecastError(false);
        } else {
            setForecast(null);
            setForecastError(true);
        }

        // Performance is optional
        if (perfResult.status === "fulfilled") {
            setPerformance(perfResult.value.data);
            setPerformanceError(false);
        } else {
            setPerformance(null);
            setPerformanceError(true);
        }

        setLoading(false);
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [load]);

    return { data, forecast, performance, loading, error, upstreamLoading, forecastError, performanceError };
}
