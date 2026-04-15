import { useEffect, useState, useCallback } from "react";
import { fetchCycleAnalysis, type CycleAnalysis } from "@/api/endpoints/marketData";

interface CycleDataState {
    data: CycleAnalysis | null;
    loading: boolean;
    error: string | null;
    /** True when the backend returned 503 "data still loading" — different UX. */
    upstreamLoading: boolean;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min, matches backend cache TTL

export function useCycleData(): CycleDataState {
    const [data, setData] = useState<CycleAnalysis | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [upstreamLoading, setUpstreamLoading] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetchCycleAnalysis();
            setData(res.data);
            setUpstreamLoading(false);
            setError(null);
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 503) {
                setUpstreamLoading(true);
                setError(null);
            } else {
                setError("Unable to load cycle analysis. Check that the cycle engine service is running.");
                setUpstreamLoading(false);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [load]);

    return { data, loading, error, upstreamLoading };
}
