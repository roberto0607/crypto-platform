import { useEffect, useState, useCallback } from "react";
import {
    fetchCycleAnalysis,
    fetchCycleForecast,
    type CycleAnalysis,
    type CycleForecast,
} from "@/api/endpoints/marketData";

interface CycleDataState {
    data: CycleAnalysis | null;
    forecast: CycleForecast | null;
    loading: boolean;
    error: string | null;
    /** True when the backend returned 503 "data still loading" — different UX. */
    upstreamLoading: boolean;
    /** Forecast can fail independently — show soft "unavailable" rather than hard error. */
    forecastError: boolean;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min, matches backend cache TTL

export function useCycleData(): CycleDataState {
    const [data, setData] = useState<CycleAnalysis | null>(null);
    const [forecast, setForecast] = useState<CycleForecast | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [upstreamLoading, setUpstreamLoading] = useState(false);
    const [forecastError, setForecastError] = useState(false);

    const load = useCallback(async () => {
        const [analysisResult, forecastResult] = await Promise.allSettled([
            fetchCycleAnalysis(),
            fetchCycleForecast(),
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

        // Forecast is optional — failure doesn't break the page
        if (forecastResult.status === "fulfilled") {
            setForecast(forecastResult.value.data);
            setForecastError(false);
        } else {
            setForecast(null);
            setForecastError(true);
        }

        setLoading(false);
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [load]);

    return { data, forecast, loading, error, upstreamLoading, forecastError };
}
