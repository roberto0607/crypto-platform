import { useEffect, useRef, useState, useCallback } from "react";
import {
    createChart,
    CandlestickSeries,
    LineSeries,
    LineStyle,
    type IChartApi,
    type ISeriesApi,
    type CandlestickData,
    type Time,
    ColorType,
    type IPriceLine,
} from "lightweight-charts";
import { getCandles, type Candle, type Timeframe } from "@/api/endpoints/candles";
import { useTradingStore } from "@/stores/tradingStore";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "@/stores/appStore";
import { IndicatorToolbar } from "./IndicatorToolbar";
import {
    prevDayHighLow,
    computeEMA,
    computeVWAP,
    computeBollingerBands,
    computeRSI,
    computeMACD,
    computeATR,
    computeCandleDelta,
    type Candle as IndicatorCandle,
    type Point,
    type MACDResult,
} from "@/lib/indicators";
import { LiquidityZonesPrimitive, formatLiquidity, parseLiquidity } from "@/lib/liquidityZonesPrimitive";
import { VPVRPrimitive, type VPVRCandle } from "@/lib/vpvrPrimitive";
import { OrderbookHeatmapPrimitive, type HeatmapLevel } from "@/lib/orderbookHeatmapPrimitive";
import { FootprintPrimitive } from "@/lib/footprintPrimitive";
import { useFootprint } from "@/lib/useFootprint";
import { LiquidationLevelsPrimitive, type LiquidationCluster } from "@/lib/liquidationLevelsPrimitive";
import { fetchLiquidationLevels } from "@/api/endpoints/marketData";
import { detectOrderBlocks, type OrderBlock } from "@/lib/orderBlocks";
import { getLiquidityZones, type LiquidityZone } from "@/api/endpoints/signals";
import { computeCVD, type CvdPoint, type CvdDivergence, type CvdDataSource } from "@/lib/cvd";
import { CvdPanel } from "./CvdPanel";
import { VolumePanel } from "./VolumePanel";
import { RsiPanel } from "./RsiPanel";
import { MACDPanel } from "./MACDPanel";
import { ATRPanel } from "./ATRPanel";
import { DeltaPanel } from "./DeltaPanel";
import { PdhPdlZonePrimitive } from "@/lib/pdhPdlZonePrimitive";
import { DragHandle, loadPanelHeights, savePanelHeights } from "./DragHandle";
import { FundingRatePanel } from "./FundingRatePanel";
import { OpenInterestPanel } from "./OpenInterestPanel";
import { COTPanel } from "./COTPanel";
import client from "@/api/client";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

// ── Market Intelligence types ──
interface IntelKeyLevel {
    price: number;
    type: string;
    distance: number;
    distancePercent: number;
    significance: string;
}
interface IntelAlert {
    type: string;
    severity: string;
    message: string;
}
interface MarketIntelligenceData {
    headline: {
        action: string;
        actionReason: string;
        score: number;
        scoreLabel: string;
        strength: string;
        confidence: number;
        regime: string;
        regimeConfidence: number;
    };
    streams: {
        basis: { score: number; label: string; keyData: string };
        orderBook: { score: number; label: string; keyData: string };
        macro: { score: number; label: string; keyData: string; relevance: number };
        gamma: { score: number; label: string; keyData: string };
        onChain: { score: number; label: string; keyData: string };
    };
    keyLevels: IntelKeyLevel[];
    alerts: IntelAlert[];
    convergence: { level: string; streamsAgreeing: number; agreement: number };
    learning?: { source: "learned" | "base"; sampleSize: number; totalSignals: number; gradedSignals: number };
}

// Lightweight Charts treats timestamps as UTC — offset to local timezone
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * -60;

function formatDateTime12h(epochSec: number): string {
    const d = new Date(epochSec * 1000);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    let h = d.getUTCHours();
    const m = d.getUTCMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const time = m === 0 ? `${h}:00 ${ampm}` : `${h}:${String(m).padStart(2, "0")} ${ampm}`;
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`;
}

function candleToLW(c: Candle): CandlestickData<Time> {
    return {
        time: (new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC) as Time,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
    };
}

function apiCandleToIndicator(c: Candle): IndicatorCandle {
    return {
        time: new Date(c.ts).getTime() / 1000 + TZ_OFFSET_SEC,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume),
    };
}

/** Bucket an epoch-second timestamp to the start of its timeframe period. */
function bucketTime(epochSec: number, tf: Timeframe): number {
    switch (tf) {
        case "1m":  return Math.floor(epochSec / 60) * 60;
        case "5m":  return Math.floor(epochSec / 300) * 300;
        case "15m": return Math.floor(epochSec / 900) * 900;
        case "1h":  return Math.floor(epochSec / 3600) * 3600;
        case "4h":  return Math.floor(epochSec / 14400) * 14400;
        case "1d":  return Math.floor(epochSec / 86400) * 86400;
        default:    return Math.floor(epochSec / 60) * 60;
    }
}

interface CandlestickChartProps {
    onTimeframeChange?: (tf: Timeframe) => void;
    fundingRate?: number;
}

export function CandlestickChart({ onTimeframeChange, fundingRate = 0 }: CandlestickChartProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const priceLinesRef = useRef<IPriceLine[]>([]);
    const rawCandlesRef = useRef<Candle[]>([]);
    const liveCandleRef = useRef<CandlestickData<Time> | null>(null);
    const fetchingOlderRef = useRef(false);
    const hasMoreRef = useRef(true);
    const hasLoadedOnce = useRef(false);
    const liquidityPrimitiveRef = useRef<LiquidityZonesPrimitive | null>(null);
    const vpvrPrimitiveRef = useRef<VPVRPrimitive | null>(null);
    const heatmapPrimitiveRef = useRef<OrderbookHeatmapPrimitive | null>(null);
    const footprintPrimitiveRef = useRef<FootprintPrimitive | null>(null);
    const liquidationLevelsPrimitiveRef = useRef<LiquidationLevelsPrimitive | null>(null);
    const vpvrDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [vpvrMode, setVpvrMode] = useState<"visible" | "weekly" | "daily">("visible");
    const vpvrWeeklyLenRef = useRef(0);
    const [orderBlocksState, setOrderBlocksState] = useState<OrderBlock[]>([]);
    const pdhPdlZonePrimitiveRef = useRef<PdhPdlZonePrimitive | null>(null);
    const keyLevelsRef = useRef<{ pdh: number; pdl: number } | null>(null);
    const liquidityZonesRef = useRef<LiquidityZone[]>([]);
    const [timeframe, setTimeframe] = useState<Timeframe>("1h");
    const [loading, setLoading] = useState(false);
    const [cvdData, setCvdData] = useState<CvdPoint[]>([]);
    const [cvdDivergences, setCvdDivergences] = useState<CvdDivergence[]>([]);
    const [cvdDataSource, setCvdDataSource] = useState<CvdDataSource>("PROXY");
    const [pdhProximity, setPdhProximity] = useState<"pdh" | "pdl" | null>(null);
    const [livePrice, setLivePrice] = useState(0);
    const currentPriceRef = useRef(0);
    const overlayRef = useRef<HTMLDivElement>(null);
    const pdhLabelRef = useRef<HTMLDivElement>(null);
    const pdlLabelRef = useRef<HTMLDivElement>(null);
    const priceLabelRef = useRef<HTMLDivElement>(null);
    const pdhConnectorRef = useRef<HTMLDivElement>(null);
    const pdlConnectorRef = useRef<HTMLDivElement>(null);

    // Overlay line series refs
    const ema20SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const ema50SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const ema200SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const vwapSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const bbUpperSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const bbMiddleSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const bbLowerSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const [rsiData, setRsiData] = useState<Point[]>([]);
    const [macdData, setMacdData] = useState<MACDResult>({ macd: [], signal: [], histogram: [] });
    const [atrData, setAtrData] = useState<Point[]>([]);
    const [deltaData, setDeltaData] = useState<Point[]>([]);

    const [panelHeights, setPanelHeights] = useState(() => loadPanelHeights());

    const handleHeightChange = useCallback((key: string, h: number) => {
        setPanelHeights((prev) => ({ ...prev, [key]: h }));
    }, []);

    const handleDragEnd = useCallback((key: string, h: number) => {
        setPanelHeights((prev) => {
            const next = { ...prev, [key]: h };
            savePanelHeights(next);
            return next;
        });
    }, []);

    const [marketIntelligence, setMarketIntelligence] = useState<MarketIntelligenceData | null>(null);
    const [intelLoading, setIntelLoading] = useState(false);
    const [intelError, setIntelError] = useState(false);
    const [crosshairData, setCrosshairData] = useState<{ open: number; high: number; low: number; close: number; time: number } | null>(null);

    const selectedPairId = useTradingStore((s) => s.selectedPairId);
    const indicatorConfig = useTradingStore(useShallow((s) => s.indicatorConfig));
    const liveOrderBook = useTradingStore((s) => s.orderBook);
    const pairs = useAppStore((s) => s.pairs);
    const selectedPairSymbol = pairs.find((p) => p.id === selectedPairId)?.symbol ?? "BTC/USD";
    const footprintPair = selectedPairSymbol.split("/")[0] ?? "BTC";
    const footprintData = useFootprint(indicatorConfig.footprint ?? false, timeframe, footprintPair);

    // Create chart instance
    useEffect(() => {
        if (!containerRef.current) return;

        const chart = createChart(containerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: "#0a0a0a" },
                textColor: "#9ca3af",
            },
            grid: {
                vertLines: { visible: false },
                horzLines: { visible: false },
            },
            crosshair: {
                vertLine: { color: "rgba(0,255,65,0.16)", labelBackgroundColor: "#0d1a0d" },
                horzLine: { color: "rgba(0,255,65,0.16)", labelBackgroundColor: "#0d1a0d" },
            },
            timeScale: {
                borderColor: "#0a0a0a",
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (time: number) => {
                    const d = new Date(time * 1000);
                    const h = d.getUTCHours();
                    const m = d.getUTCMinutes();
                    if (h === 0 && m === 0) {
                        const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                        return `${mo[d.getUTCMonth()]} ${d.getUTCDate()}`;
                    }
                    const ampm = h >= 12 ? "PM" : "AM";
                    const h12 = h % 12 || 12;
                    return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, "0")}`;
                },
            },
            localization: { timeFormatter: formatDateTime12h },
            rightPriceScale: {
                borderColor: "#0a0a0a",
            },
        });

        const series = chart.addSeries(CandlestickSeries, {
            upColor: "#00ff41",
            downColor: "#ff3b3b",
            borderUpColor: "#00ff41",
            borderDownColor: "#ff3b3b",
            wickUpColor: "#00ff41",
            wickDownColor: "#ff3b3b",
        });

        chartRef.current = chart;
        seriesRef.current = series;

        // Attach liquidity zones primitive
        const liquidityPrimitive = new LiquidityZonesPrimitive();
        series.attachPrimitive(liquidityPrimitive);
        liquidityPrimitiveRef.current = liquidityPrimitive;

        // Attach PDH/PDL zone fill primitive
        const pdhPdlZonePrimitive = new PdhPdlZonePrimitive();
        series.attachPrimitive(pdhPdlZonePrimitive);
        pdhPdlZonePrimitiveRef.current = pdhPdlZonePrimitive;

        // Attach VPVR primitive (RIGHT side)
        const vpvrPrimitive = new VPVRPrimitive();
        series.attachPrimitive(vpvrPrimitive);
        vpvrPrimitiveRef.current = vpvrPrimitive;

        // Attach order book heatmap primitive (LEFT side)
        const heatmapPrimitive = new OrderbookHeatmapPrimitive();
        series.attachPrimitive(heatmapPrimitive);
        heatmapPrimitiveRef.current = heatmapPrimitive;

        // Attach footprint primitive (overlaid on candles)
        const footprintPrimitive = new FootprintPrimitive();
        series.attachPrimitive(footprintPrimitive);
        footprintPrimitive.setChart(chart);
        footprintPrimitiveRef.current = footprintPrimitive;

        // Attach liquidation levels primitive (right-of-current-candle only)
        const liquidationLevelsPrimitive = new LiquidationLevelsPrimitive();
        series.attachPrimitive(liquidationLevelsPrimitive);
        liquidationLevelsPrimitive.setChart(chart);
        liquidationLevelsPrimitiveRef.current = liquidationLevelsPrimitive;

        // Crosshair OHLCV readout
        chart.subscribeCrosshairMove((param) => {
            if (!param.time || !param.seriesData) {
                setCrosshairData(null);
                return;
            }
            const data = param.seriesData.get(series);
            if (!data) {
                setCrosshairData(null);
                return;
            }
            const bar = data as CandlestickData<Time>;
            if (bar.open == null) {
                setCrosshairData(null);
                return;
            }
            setCrosshairData({
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                time: param.time as number,
            });
        });

        // Responsive resize
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                chart.applyOptions({ width, height });
            }
        });
        observer.observe(containerRef.current);

        return () => {
            observer.disconnect();
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
            priceLinesRef.current = [];
        };
    }, []);

    // Remove all price lines
    const clearPriceLines = useCallback(() => {
        const candleSeries = seriesRef.current;
        if (!candleSeries) return;
        for (const pl of priceLinesRef.current) {
            candleSeries.removePriceLine(pl);
        }
        priceLinesRef.current = [];
    }, []);

    // Render indicator overlays from raw candle data
    const renderOverlays = useCallback((candles: Candle[]) => {
        const candleSeries = seriesRef.current;
        if (!candleSeries || candles.length === 0) return;

        clearPriceLines();

        const indCandles = candles.map(apiCandleToIndicator);

        // Key Levels — PDH/PDL
        // Lines + zone fills drawn by PdhPdlZonePrimitive; labels are DOM overlays.
        if (indicatorConfig.keyLevels) {
            candleSeries.applyOptions({ lastValueVisible: false, priceLineVisible: false });
            const levels = prevDayHighLow(indCandles);
            if (levels) {
                keyLevelsRef.current = levels;
                // Debug: log exact PDH/PDL values and source candle highs/lows
                const days = new Map<number, { high: number; low: number }>();
                for (const ic of indCandles) {
                    const day = Math.floor(ic.time / 86400);
                    const ex = days.get(day);
                    if (!ex) days.set(day, { high: ic.high, low: ic.low });
                    else { ex.high = Math.max(ex.high, ic.high); ex.low = Math.min(ex.low, ic.low); }
                }
                const lastCandle = candles[candles.length - 1];
                const price = lastCandle ? parseFloat(lastCandle.close) : 0;

                // Seed live price from candle data if SSE hasn't ticked yet
                if (currentPriceRef.current === 0 && price > 0) {
                    currentPriceRef.current = price;
                    setLivePrice(price);
                }

                // Proximity check (1.5%)
                const pdhDist = Math.abs(levels.pdh - price);
                const pdlDist = Math.abs(price - levels.pdl);
                const pdhProx = price > 0 && (pdhDist / price) * 100 <= 1.5;
                const pdlProx = price > 0 && (pdlDist / price) * 100 <= 1.5;
                setPdhProximity(pdhProx ? "pdh" : pdlProx ? "pdl" : null);

                // Primitive handles: dashed lines + zone fills
                pdhPdlZonePrimitiveRef.current?.setData({
                    pdh: levels.pdh,
                    pdl: levels.pdl,
                    currentPrice: price,
                    pdhProximity: pdhProx,
                    pdlProximity: pdlProx,
                });
            } else {
                keyLevelsRef.current = null;
                pdhPdlZonePrimitiveRef.current?.setData(null);
                setPdhProximity(null);
            }
        } else {
            candleSeries.applyOptions({ lastValueVisible: true, priceLineVisible: true });
            keyLevelsRef.current = null;
            pdhPdlZonePrimitiveRef.current?.setData(null);
            setPdhProximity(null);
        }

        // Liquidity zones visibility
        if (!indicatorConfig.liquidityZones) {
            liquidityPrimitiveRef.current?.setZones([]);
        }

        // Order Blocks — detect + DOM overlay
        const orderBlocks = indicatorConfig.orderBlocks ? detectOrderBlocks(indCandles) : [];
        if (indicatorConfig.orderBlocks && orderBlocks.length > 0) {
            const bullish = orderBlocks.filter(ob => ob.type === "bullish").slice(-3);
            const bearish = orderBlocks.filter(ob => ob.type === "bearish").slice(-3);
            setOrderBlocksState([...bullish, ...bearish]);
        } else {
            setOrderBlocksState([]);
        }

        // CVD
        if (indicatorConfig.cvd) {
            const cvdResult = computeCVD(candles);
            setCvdData(cvdResult.values);
            setCvdDivergences(cvdResult.divergences);
            setCvdDataSource(cvdResult.dataSource);
        } else {
            setCvdData([]);
            setCvdDivergences([]);
        }

        // ── Standard overlay indicators ──
        const chart = chartRef.current;
        if (chart) {
            const toLineData = (pts: Point[]) => pts.map((p) => ({ time: p.time as Time, value: p.value }));

            // EMA 20
            if (indicatorConfig.ema20) {
                if (!ema20SeriesRef.current) {
                    ema20SeriesRef.current = chart.addSeries(LineSeries, { color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                }
                ema20SeriesRef.current.setData(toLineData(computeEMA(indCandles, 20)));
            } else if (ema20SeriesRef.current) {
                chart.removeSeries(ema20SeriesRef.current); ema20SeriesRef.current = null;
            }

            // EMA 50
            if (indicatorConfig.ema50) {
                if (!ema50SeriesRef.current) {
                    ema50SeriesRef.current = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                }
                ema50SeriesRef.current.setData(toLineData(computeEMA(indCandles, 50)));
            } else if (ema50SeriesRef.current) {
                chart.removeSeries(ema50SeriesRef.current); ema50SeriesRef.current = null;
            }

            // EMA 200
            if (indicatorConfig.ema200) {
                if (!ema200SeriesRef.current) {
                    ema200SeriesRef.current = chart.addSeries(LineSeries, { color: "#ef4444", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                }
                ema200SeriesRef.current.setData(toLineData(computeEMA(indCandles, 200)));
            } else if (ema200SeriesRef.current) {
                chart.removeSeries(ema200SeriesRef.current); ema200SeriesRef.current = null;
            }

            // VWAP
            if (indicatorConfig.vwap) {
                if (!vwapSeriesRef.current) {
                    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: "#a855f7", lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false });
                }
                vwapSeriesRef.current.setData(toLineData(computeVWAP(indCandles)));
            } else if (vwapSeriesRef.current) {
                chart.removeSeries(vwapSeriesRef.current); vwapSeriesRef.current = null;
            }

            // Bollinger Bands
            if (indicatorConfig.bollingerBands) {
                const bb = computeBollingerBands(indCandles, 20, 2);
                if (!bbMiddleSeriesRef.current) {
                    bbMiddleSeriesRef.current = chart.addSeries(LineSeries, { color: "#6366f1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                    bbUpperSeriesRef.current = chart.addSeries(LineSeries, { color: "rgba(99,102,241,0.5)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                    bbLowerSeriesRef.current = chart.addSeries(LineSeries, { color: "rgba(99,102,241,0.5)", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
                }
                bbMiddleSeriesRef.current.setData(toLineData(bb.middle));
                bbUpperSeriesRef.current!.setData(toLineData(bb.upper));
                bbLowerSeriesRef.current!.setData(toLineData(bb.lower));
            } else {
                if (bbMiddleSeriesRef.current) { chart.removeSeries(bbMiddleSeriesRef.current); bbMiddleSeriesRef.current = null; }
                if (bbUpperSeriesRef.current) { chart.removeSeries(bbUpperSeriesRef.current); bbUpperSeriesRef.current = null; }
                if (bbLowerSeriesRef.current) { chart.removeSeries(bbLowerSeriesRef.current); bbLowerSeriesRef.current = null; }
            }

            // RSI (computed here, rendered in sub-panel)
            if (indicatorConfig.rsi) {
                setRsiData(computeRSI(indCandles, 14));
            } else {
                setRsiData([]);
            }

            // MACD (computed here, rendered in sub-panel)
            if (indicatorConfig.macd) {
                setMacdData(computeMACD(indCandles));
            } else {
                setMacdData({ macd: [], signal: [], histogram: [] });
            }

            // ATR (computed here, rendered in sub-panel)
            if (indicatorConfig.atr) {
                setAtrData(computeATR(indCandles, 14));
            } else {
                setAtrData([]);
            }

            // Per-candle delta (computed here, rendered in sub-panel)
            if (indicatorConfig.delta) {
                setDeltaData(computeCandleDelta(indCandles));
            } else {
                setDeltaData([]);
            }
        }
    }, [indicatorConfig, clearPriceLines, fundingRate]);

    // Fetch candles when pair or timeframe changes
    const fetchCandles = useCallback(async () => {
        if (!selectedPairId || !seriesRef.current) return;

        setLoading(true);
        hasMoreRef.current = true;
        fetchingOlderRef.current = false;
        try {
            const candleRes = await getCandles(selectedPairId, { timeframe, limit: 750 });

            rawCandlesRef.current = candleRes.data.candles;
            liveCandleRef.current = null;
            const lwData = candleRes.data.candles.map(candleToLW);
            seriesRef.current.setData(lwData);

            renderOverlays(candleRes.data.candles);

            // Only fit on the very first load — later re-fetches (from indicator
            // toggles etc.) must not yank the viewport.
            if (!hasLoadedOnce.current) {
                chartRef.current?.timeScale().fitContent();
                hasLoadedOnce.current = true;
            }
        } catch {
            // Non-fatal — chart shows empty
        } finally {
            setLoading(false);
        }
    }, [selectedPairId, timeframe, renderOverlays]);

    useEffect(() => {
        fetchCandles();
    }, [fetchCandles]);

    // Scroll-back: lazy-load older candles when the user scrolls near the left edge
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;

        const handler = () => {
            if (fetchingOlderRef.current || !hasMoreRef.current || !selectedPairId) return;

            const logicalRange = chart.timeScale().getVisibleLogicalRange();
            if (!logicalRange) return;

            // Trigger when the user has scrolled within 10 bars of the left edge
            if (logicalRange.from > 10) return;

            fetchingOlderRef.current = true;

            const oldest = rawCandlesRef.current[0];
            if (!oldest) {
                fetchingOlderRef.current = false;
                return;
            }

            getCandles(selectedPairId, {
                timeframe,
                limit: 500,
                before: oldest.ts,
            })
                .then((res) => {
                    const olderCandles = res.data.candles;
                    if (olderCandles.length === 0) {
                        hasMoreRef.current = false;
                        return;
                    }

                    // Prepend to raw candles
                    rawCandlesRef.current = [...olderCandles, ...rawCandlesRef.current];

                    // Rebuild full series data (setData preserves scroll position)
                    const allLW = rawCandlesRef.current.map(candleToLW);
                    // Re-append live candle if present
                    if (liveCandleRef.current) {
                        allLW.push(liveCandleRef.current);
                    }
                    seriesRef.current?.setData(allLW);

                    if (olderCandles.length < 500) {
                        hasMoreRef.current = false;
                    }
                })
                .catch(() => {
                    // Non-fatal — stop trying on error
                    hasMoreRef.current = false;
                })
                .finally(() => {
                    fetchingOlderRef.current = false;
                });
        };

        chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return () => {
            chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
        };
    }, [selectedPairId, timeframe]);

    // VPVR — recompute on visible range change (debounced) or weekly candle data
    useEffect(() => {
        const chart = chartRef.current;
        const vpvr = vpvrPrimitiveRef.current;
        if (!chart || !vpvr) return;

        if (!indicatorConfig.vpvr) {
            vpvr.update([]);
            return;
        }

        const parseCandle = (c: { high: string; low: string; volume: string }): VPVRCandle =>
            ({ high: parseFloat(c.high), low: parseFloat(c.low), volume: parseFloat(c.volume) });

        // Weekly boundary: most recent Sunday 22:00 UTC
        const getWeeklyOpen = (): Date => {
            const now = new Date();
            const day = now.getUTCDay();
            const hour = now.getUTCHours();
            let daysSinceSunday = day;
            if (day === 0 && hour < 22) daysSinceSunday = 7;
            const d = new Date(now);
            d.setUTCDate(now.getUTCDate() - daysSinceSunday);
            d.setUTCHours(22, 0, 0, 0);
            return d;
        };

        const updateVisibleVPVR = () => {
            const range = chart.timeScale().getVisibleLogicalRange();
            if (!range || !rawCandlesRef.current.length) return;
            const from = Math.max(0, Math.floor(range.from));
            const to = Math.min(rawCandlesRef.current.length - 1, Math.ceil(range.to));
            const visible: VPVRCandle[] = [];
            for (let i = from; i <= to; i++) {
                const c = rawCandlesRef.current[i];
                if (c) visible.push(parseCandle(c));
            }
            vpvr.update(visible, "visible");
        };

        const updateWeeklyVPVR = () => {
            if (!rawCandlesRef.current.length) return;
            const weeklyOpen = getWeeklyOpen();
            const weekly: VPVRCandle[] = [];
            for (const c of rawCandlesRef.current) {
                if (new Date(c.ts) >= weeklyOpen) weekly.push(parseCandle(c));
            }
            vpvr.update(weekly, "weekly");
            vpvrWeeklyLenRef.current = rawCandlesRef.current.length;
        };

        // Daily boundary: current UTC midnight
        const getDailyOpen = (): Date => {
            const now = new Date();
            const d = new Date(now);
            d.setUTCHours(0, 0, 0, 0);
            return d;
        };

        const updateDailyVPVR = () => {
            if (!rawCandlesRef.current.length) return;
            const dailyOpen = getDailyOpen();
            const daily: VPVRCandle[] = [];
            for (const c of rawCandlesRef.current) {
                if (new Date(c.ts) >= dailyOpen) daily.push(parseCandle(c));
            }
            vpvr.update(daily, "daily");
            vpvrWeeklyLenRef.current = rawCandlesRef.current.length;
        };

        if (vpvrMode === "visible") {
            updateVisibleVPVR();
            const handler = () => {
                if (vpvrDebounceRef.current) clearTimeout(vpvrDebounceRef.current);
                vpvrDebounceRef.current = setTimeout(updateVisibleVPVR, 50);
            };
            chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
            return () => {
                chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
                if (vpvrDebounceRef.current) clearTimeout(vpvrDebounceRef.current);
            };
        } else {
            // Fixed mode (weekly or daily): compute once, recalc only on new candle
            const updateFixed = vpvrMode === "weekly" ? updateWeeklyVPVR : updateDailyVPVR;
            updateFixed();
            const checkNewCandle = setInterval(() => {
                if (rawCandlesRef.current.length !== vpvrWeeklyLenRef.current) {
                    updateFixed();
                }
            }, 5000);
            return () => clearInterval(checkNewCandle);
        }
    }, [indicatorConfig.vpvr, vpvrMode]);

    // Order book heatmap — update from live order book data
    useEffect(() => {
        const heatmap = heatmapPrimitiveRef.current;
        if (!heatmap) return;

        if (!indicatorConfig.orderbook || !liveOrderBook) {
            heatmap.clear();
            return;
        }

        const bids: HeatmapLevel[] = liveOrderBook.bids.slice(0, 10).map((l) => ({
            price: parseFloat(l.price),
            quantity: parseFloat(l.qty),
        }));
        const asks: HeatmapLevel[] = liveOrderBook.asks.slice(0, 10).map((l) => ({
            price: parseFloat(l.price),
            quantity: parseFloat(l.qty),
        }));

        heatmap.update(bids, asks);
    }, [indicatorConfig.orderbook, liveOrderBook]);

    // Footprint chart — update from footprint data
    useEffect(() => {
        const fp = footprintPrimitiveRef.current;
        console.log("[footprint] effect:", "data size:", footprintData.size, "enabled:", indicatorConfig.footprint, "timeframe:", timeframe, "fpRef:", !!fp);
        if (!fp) return;

        const isFootprintTf = ["1m", "5m", "15m"].includes(timeframe);
        if (!(indicatorConfig.footprint ?? false) || !isFootprintTf || footprintData.size === 0) {
            fp.clear();
            return;
        }

        fp.update(footprintData, rawCandlesRef.current);
    }, [indicatorConfig.footprint, footprintData, timeframe]);

    // Liquidation Levels — fetch + 30s poll + refresh on candle.closed
    useEffect(() => {
        const primitive = liquidationLevelsPrimitiveRef.current;
        if (!primitive) return;

        if (!indicatorConfig.liquidationLevels) {
            primitive.clear();
            return;
        }

        // Only BTC is supported per the spec
        const base = selectedPairSymbol.split("/")[0]?.toUpperCase() ?? "BTC";
        if (base !== "BTC") {
            primitive.clear();
            return;
        }

        let cancelled = false;

        const load = async () => {
            try {
                const res = await fetchLiquidationLevels("BTC");
                if (cancelled) return;
                const clusters: LiquidationCluster[] = res.data.clusters;
                const raw = rawCandlesRef.current;
                const latest = raw.length > 0 ? raw[raw.length - 1] : null;
                const latestTime = latest
                    ? ((new Date(latest.ts).getTime() / 1000 + TZ_OFFSET_SEC) as Time)
                    : null;
                primitive.update(clusters, latestTime);
            } catch {
                /* non-fatal — keep prior data until next poll */
            }
        };

        load();
        const id = setInterval(load, 30_000);

        const onCandleClosed = () => { load(); };
        window.addEventListener("sse:candle.closed", onCandleClosed);

        return () => {
            cancelled = true;
            clearInterval(id);
            window.removeEventListener("sse:candle.closed", onCandleClosed);
        };
    }, [indicatorConfig.liquidationLevels, selectedPairSymbol]);

    // Re-render overlays when indicator config changes
    useEffect(() => {
        if (rawCandlesRef.current.length > 0) {
            renderOverlays(rawCandlesRef.current);
        }
    }, [renderOverlays]);

    // Live update: price.tick → update current candle
    useEffect(() => {
        if (!selectedPairId) return;

        const handlePriceTick = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId || !seriesRef.current) return;

            const price = parseFloat(detail.last);
            const now = Math.floor(Date.now() / 1000);
            const candleTime = (bucketTime(now, timeframe) + TZ_OFFSET_SEC) as Time;

            const live = liveCandleRef.current;
            if (live && live.time === candleTime) {
                live.high = Math.max(live.high, price);
                live.low = Math.min(live.low, price);
                live.close = price;
            } else {
                liveCandleRef.current = {
                    time: candleTime,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                };
            }

            seriesRef.current.update(liveCandleRef.current!);

            // Update PDH/PDL proximity, zone fills, and label data on each tick
            currentPriceRef.current = price;
            liquidityPrimitiveRef.current?.setCurrentPrice(price);
            const levels = keyLevelsRef.current;
            if (levels && indicatorConfig.keyLevels) {
                setLivePrice(price);
                const pdhDist = Math.abs(levels.pdh - price);
                const pdlDist = Math.abs(price - levels.pdl);
                const pdhProx = price > 0 && (pdhDist / price) * 100 <= 1.5;
                const pdlProx = price > 0 && (pdlDist / price) * 100 <= 1.5;
                setPdhProximity(pdhProx ? "pdh" : pdlProx ? "pdl" : null);

                pdhPdlZonePrimitiveRef.current?.setData({
                    pdh: levels.pdh,
                    pdl: levels.pdl,
                    currentPrice: price,
                    pdhProximity: pdhProx,
                    pdlProximity: pdlProx,
                });
            }
        };

        window.addEventListener("sse:price.tick", handlePriceTick);
        return () => window.removeEventListener("sse:price.tick", handlePriceTick);
    }, [selectedPairId, timeframe, indicatorConfig.keyLevels]);

    // Live update: candle.closed → append completed candle
    useEffect(() => {
        if (!selectedPairId) return;

        const handleCandleClosed = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail.pairId !== selectedPairId || !seriesRef.current) return;
            if (detail.timeframe !== timeframe) return;

            seriesRef.current.update({
                time: (detail.ts / 1000 + TZ_OFFSET_SEC) as Time,
                open: parseFloat(detail.open),
                high: parseFloat(detail.high),
                low: parseFloat(detail.low),
                close: parseFloat(detail.close),
            });

            liveCandleRef.current = null;

            const newCandle: Candle = {
                ts: new Date(detail.ts).toISOString(),
                open: detail.open,
                high: detail.high,
                low: detail.low,
                close: detail.close,
                volume: detail.volume ?? "0",
            };
            rawCandlesRef.current = [...rawCandlesRef.current, newCandle];
            renderOverlays(rawCandlesRef.current);
        };

        window.addEventListener("sse:candle.closed", handleCandleClosed);
        return () => window.removeEventListener("sse:candle.closed", handleCandleClosed);
    }, [selectedPairId, timeframe, renderOverlays]);

    // Liquidity zones: fetch on mount + 60s refresh
    useEffect(() => {
        if (!selectedPairId || !indicatorConfig.liquidityZones) {
            liquidityPrimitiveRef.current?.setZones([]);
            return;
        }

        const fetchZones = async () => {
            try {
                const { data } = await getLiquidityZones(selectedPairId, { timeframe });
                liquidityPrimitiveRef.current?.setZones(data.zones);
                liquidityPrimitiveRef.current?.setCurrentPrice(currentPriceRef.current || data.currentPrice);
                liquidityZonesRef.current = data.zones;
            } catch {
                // Non-fatal
            }
        };

        fetchZones();
        const interval = setInterval(fetchZones, 60_000);
        return () => clearInterval(interval);
    }, [selectedPairId, timeframe, indicatorConfig.liquidityZones]);

    // Inject CSS for proximity dot pulse animation
    useEffect(() => {
        const id = "pdh-pdl-pulse-css";
        if (!document.getElementById(id)) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = "@keyframes pdhPdlDotPulse{0%,100%{opacity:1}50%{opacity:0.2}}";
            document.head.appendChild(style);
        }
    }, []);

    // Inject CSS for Market Intelligence animations
    useEffect(() => {
        const id = "intel-overlay-css";
        if (!document.getElementById(id)) {
            const style = document.createElement("style");
            style.id = id;
            style.textContent = [
                "@keyframes intelAlertPulse{0%,100%{opacity:0.7}50%{opacity:1}}",
                "@keyframes intelScan{0%{left:-100%}100%{left:100%}}",
            ].join("");
            document.head.appendChild(style);
        }
    }, []);

    // Market Intelligence data fetch
    useEffect(() => {
        if (!indicatorConfig.marketIntelligence) return;

        let cancelled = false;
        const fetchIntel = async (isFirst: boolean) => {
            if (isFirst) setIntelLoading(true);
            try {
                const res = await client.get<MarketIntelligenceData & { ok: boolean }>("/market/intelligence");
                if (!cancelled && res.data.ok) {
                    setMarketIntelligence(res.data);
                    setIntelError(false);
                }
            } catch {
                if (!cancelled) setIntelError(true);
            } finally {
                if (!cancelled && isFirst) setIntelLoading(false);
            }
        };

        fetchIntel(true);
        const interval = setInterval(() => fetchIntel(false), 30_000);
        return () => { cancelled = true; clearInterval(interval); };
    }, [indicatorConfig.marketIntelligence]);

    // RAF loop: position DOM label overlays with collision avoidance
    useEffect(() => {
        const allRefs = [pdhLabelRef, pdlLabelRef, priceLabelRef, pdhConnectorRef, pdlConnectorRef];
        if (!indicatorConfig.keyLevels) {
            for (const r of allRefs) r.current?.style.setProperty("display", "none");
            return;
        }
        let active = true;
        const GAP = 6; // px — minimum gap between live price box and cards
        const CLEARANCE = 4; // px — trigger threshold
        const tick = () => {
            if (!active) return;
            const series = seriesRef.current;
            const levels = keyLevelsRef.current;
            const price = currentPriceRef.current;

            if (series && levels) {
                const yPdh = series.priceToCoordinate(levels.pdh);
                const yPdl = series.priceToCoordinate(levels.pdl);
                const yPrice = price > 0 ? series.priceToCoordinate(price) : null;

                // Live price label — always anchored, never moves
                if (priceLabelRef.current) {
                    if (yPrice != null) {
                        priceLabelRef.current.style.top = `${yPrice}px`;
                        priceLabelRef.current.style.display = "flex";
                    } else {
                        priceLabelRef.current.style.display = "none";
                    }
                }

                // Measure live price box height for collision math
                const priceBoxH = priceLabelRef.current?.offsetHeight ?? 18;
                const priceBoxHalf = priceBoxH / 2;

                // PDH card — shift UP if it overlaps the live price box
                let adjustedPdhY = yPdh;
                let pdhShifted = false;
                if (yPdh != null && yPrice != null) {
                    const pdhCardH = pdhLabelRef.current?.offsetHeight ?? 60;
                    const pdhCardHalf = pdhCardH / 2;
                    // PDH card bottom edge vs price box top edge
                    const pdhBottom = yPdh + pdhCardHalf;
                    const priceTop = yPrice - priceBoxHalf;
                    if (priceTop - pdhBottom < CLEARANCE) {
                        adjustedPdhY = (priceTop - GAP - pdhCardHalf) as typeof yPdh;
                        pdhShifted = true;
                    }
                }
                if (pdhLabelRef.current) {
                    if (adjustedPdhY != null) {
                        pdhLabelRef.current.style.top = `${adjustedPdhY}px`;
                        pdhLabelRef.current.style.display = "flex";
                    } else {
                        pdhLabelRef.current.style.display = "none";
                    }
                }
                // PDH connector line (actual level → shifted label)
                if (pdhConnectorRef.current) {
                    if (pdhShifted && yPdh != null && adjustedPdhY != null) {
                        const top = Math.min(yPdh, adjustedPdhY);
                        const h = Math.abs(yPdh - adjustedPdhY);
                        pdhConnectorRef.current.style.top = `${top}px`;
                        pdhConnectorRef.current.style.height = `${h}px`;
                        pdhConnectorRef.current.style.display = "block";
                    } else {
                        pdhConnectorRef.current.style.display = "none";
                    }
                }

                // PDL card — shift DOWN if it overlaps the live price box
                let adjustedPdlY = yPdl;
                let pdlShifted = false;
                if (yPdl != null && yPrice != null) {
                    const pdlCardH = pdlLabelRef.current?.offsetHeight ?? 60;
                    const pdlCardHalf = pdlCardH / 2;
                    // Price box bottom edge vs PDL card top edge
                    const priceBottom = yPrice + priceBoxHalf;
                    const pdlTop = yPdl - pdlCardHalf;
                    if (pdlTop - priceBottom < CLEARANCE) {
                        adjustedPdlY = (priceBottom + GAP + pdlCardHalf) as typeof yPdl;
                        pdlShifted = true;
                    }
                }
                if (pdlLabelRef.current) {
                    if (adjustedPdlY != null) {
                        pdlLabelRef.current.style.top = `${adjustedPdlY}px`;
                        pdlLabelRef.current.style.display = "flex";
                    } else {
                        pdlLabelRef.current.style.display = "none";
                    }
                }
                // PDL connector line (actual level → shifted label)
                if (pdlConnectorRef.current) {
                    if (pdlShifted && yPdl != null && adjustedPdlY != null) {
                        const top = Math.min(yPdl, adjustedPdlY);
                        const h = Math.abs(yPdl - adjustedPdlY);
                        pdlConnectorRef.current.style.top = `${top}px`;
                        pdlConnectorRef.current.style.height = `${h}px`;
                        pdlConnectorRef.current.style.display = "block";
                    } else {
                        pdlConnectorRef.current.style.display = "none";
                    }
                }
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return () => { active = false; };
    }, [indicatorConfig.keyLevels]);

    const handleTimeframeChange = (tf: Timeframe) => {
        setTimeframe(tf);
        onTimeframeChange?.(tf);
    };

    return (
        <div className="flex flex-col h-full">
            {/* Timeframe selector + Indicator toolbar */}
            <div className="flex items-center gap-1 mb-2">
                {TIMEFRAMES.map((tf) => (
                    <button
                        key={tf}
                        onClick={() => handleTimeframeChange(tf)}
                        style={{
                            padding: "4px 8px", fontSize: 12, borderRadius: 2,
                            transition: "all 0.15s",
                            fontFamily: "'Space Mono', monospace",
                            letterSpacing: 1,
                            border: timeframe === tf ? "1px solid #00ff41" : "1px solid rgba(0,255,65,0.16)",
                            background: timeframe === tf ? "#00ff41" : "transparent",
                            color: timeframe === tf ? "#000" : "rgba(255,255,255,0.5)",
                        }}
                    >
                        {tf}
                    </button>
                ))}
                <div className="ml-2">
                    <IndicatorToolbar vpvrMode={vpvrMode} onVpvrModeChange={setVpvrMode} />
                </div>
                {loading && (
                    <span className="text-gray-600 text-xs ml-2">Loading...</span>
                )}
            </div>

            {/* Chart container */}
            <div className="relative flex-1 min-h-0">
                <div ref={containerRef} className="absolute inset-0" />

                {/* ── Crosshair OHLCV readout ── */}
                {crosshairData && (
                    <div style={{
                        position: "absolute", top: 8, left: 8, zIndex: 10,
                        pointerEvents: "none", display: "flex", gap: 16,
                        fontFamily: "'Space Mono', monospace", fontSize: 11,
                    }}>
                        <span>
                            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginRight: 4 }}>O</span>
                            <span style={{ color: "rgba(255,255,255,0.8)" }}>
                                {crosshairData.open.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </span>
                        <span>
                            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginRight: 4 }}>H</span>
                            <span style={{ color: "#00ff41" }}>
                                {crosshairData.high.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </span>
                        <span>
                            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginRight: 4 }}>L</span>
                            <span style={{ color: "#ff3b3b" }}>
                                {crosshairData.low.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </span>
                        <span>
                            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", marginRight: 4 }}>C</span>
                            <span style={{ color: crosshairData.close >= crosshairData.open ? "#fff" : "#ff3b3b" }}>
                                {crosshairData.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                        </span>
                    </div>
                )}

                {/* ── PDH/PDL DOM overlay — sits OVER the chart, outside TradingView's canvas ── */}
                {indicatorConfig.keyLevels && (
                    <div
                        ref={overlayRef}
                        style={{
                            position: "absolute",
                            top: 0,
                            right: 6,
                            width: 200,
                            height: "100%",
                            pointerEvents: "none",
                            zIndex: 10,
                            overflow: "visible",
                        }}
                    >
                        {(() => {
                            const levels = keyLevelsRef.current;
                            if (!levels) return null;
                            const price = livePrice || currentPriceRef.current;
                            const fmtP = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                            const isPdhProx = pdhProximity === "pdh";
                            const isPdlProx = pdhProximity === "pdl";
                            // Per-element color dimming: muted when far, bright when near/neutral
                            const pdhR = isPdlProx ? "#993333" : "#ff3c3c";
                            const pdhBadgeBg = isPdlProx ? "rgba(153,51,51,0.15)" : "rgba(255,60,60,0.15)";
                            const pdhBorderL = `3px solid ${pdhR}`;
                            const pdhShadow = isPdlProx ? "0 0 14px rgba(153,51,51,0.08)" : "0 0 14px rgba(255,60,60,0.15)";
                            const pdlG = isPdhProx ? "#1a6644" : "#00e676";
                            const pdlBadgeBg = isPdhProx ? "rgba(26,102,68,0.15)" : "rgba(0,230,118,0.12)";
                            const pdlBorderL = `3px solid ${pdlG}`;
                            const pdlShadow = isPdhProx ? "0 0 14px rgba(26,102,68,0.08)" : "0 0 14px rgba(0,230,118,0.1)";

                            return (
                                <>
                                    {/* PDH connector line */}
                                    <div ref={pdhConnectorRef} style={{
                                        position: "absolute", right: 65, width: 1, display: "none",
                                        borderLeft: "1px dashed rgba(255,60,60,0.4)",
                                    }} />

                                    {/* PDH card — per-element color dimming, no parent opacity */}
                                    <div ref={pdhLabelRef} style={{
                                        position: "absolute", right: 65, transform: "translateY(-50%)",
                                        display: "none", flexDirection: "column", gap: 4,
                                        transition: "box-shadow 0.2s, border-color 0.2s",
                                        background: "#0d1219",
                                        border: "1px solid rgba(255,60,60,0.45)",
                                        borderLeft: pdhBorderL,
                                        borderRadius: 6,
                                        padding: "6px 10px",
                                        boxShadow: pdhShadow,
                                        width: "fit-content",
                                        color: "unset",
                                    }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                            <span style={{ color: pdhR, WebkitTextFillColor: pdhR, fontWeight: 900, fontSize: 11, letterSpacing: 2 }}>PDH</span>
                                            <span style={{ background: pdhBadgeBg, color: pdhR, WebkitTextFillColor: pdhR, fontSize: 7, padding: "1px 5px", borderRadius: 3, letterSpacing: 1 }}>RESISTANCE</span>
                                        </div>
                                        <div style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, opacity: 1, textShadow: "none" }}>{fmtP(levels.pdh)}</div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 5, borderTop: "1px solid rgba(255,60,60,0.2)", paddingTop: 4 }}>
                                            <span style={{ color: pdhR, WebkitTextFillColor: pdhR, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{"\u2191"} ${Math.round(levels.pdh - price).toLocaleString()}</span>
                                            <span style={{ color: "#333", WebkitTextFillColor: "#333", fontSize: 10 }}>{"\u00b7"}</span>
                                            <span style={{ color: pdhR, WebkitTextFillColor: pdhR, fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>{price > 0 ? ((levels.pdh - price) / price * 100).toFixed(2) : "0.00"}% away</span>
                                        </div>
                                    </div>

                                    {/* Live price label — unchanged */}
                                    <div ref={priceLabelRef} style={{
                                        position: "absolute", right: 65, transform: "translateY(-50%)",
                                        display: "none", alignItems: "center",
                                        zIndex: 5,
                                    }}>
                                        <div style={{
                                            width: 0, height: 0,
                                            borderTop: "9px solid transparent",
                                            borderBottom: "9px solid transparent",
                                            borderRight: "7px solid #ffffff",
                                            flexShrink: 0,
                                        }} />
                                        <div style={{ background: "#ffffff", padding: "4px 10px", borderRadius: "0 4px 4px 0" }}>
                                            <span style={{ color: "#000", fontWeight: 800, fontSize: 12, fontFamily: "monospace", whiteSpace: "nowrap" }}>{fmtP(price)}</span>
                                        </div>
                                    </div>

                                    {/* PDL connector line */}
                                    <div ref={pdlConnectorRef} style={{
                                        position: "absolute", right: 65, width: 1, display: "none",
                                        borderLeft: "1px dashed rgba(0,230,118,0.4)",
                                    }} />

                                    {/* PDL card — per-element color dimming, no parent opacity */}
                                    <div ref={pdlLabelRef} style={{
                                        position: "absolute", right: 65, transform: "translateY(-50%)",
                                        display: "none", flexDirection: "column", gap: 4,
                                        transition: "box-shadow 0.2s, border-color 0.2s",
                                        background: "#0a140f",
                                        border: "1px solid rgba(0,230,118,0.4)",
                                        borderLeft: pdlBorderL,
                                        borderRadius: 6,
                                        padding: "6px 10px",
                                        boxShadow: pdlShadow,
                                        width: "fit-content",
                                        color: "unset",
                                    }}>
                                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                                            <span style={{ color: pdlG, WebkitTextFillColor: pdlG, fontWeight: 900, fontSize: 11, letterSpacing: 2 }}>PDL</span>
                                            <span style={{ background: pdlBadgeBg, color: pdlG, WebkitTextFillColor: pdlG, fontSize: 7, padding: "1px 5px", borderRadius: 3, letterSpacing: 1 }}>SUPPORT</span>
                                        </div>
                                        <div style={{ color: "#ffffff", WebkitTextFillColor: "#ffffff", fontWeight: 700, fontSize: 13, letterSpacing: 0.3, opacity: 1, textShadow: "none" }}>{fmtP(levels.pdl)}</div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 5, borderTop: "1px solid rgba(0,230,118,0.2)", paddingTop: 4 }}>
                                            <span style={{ color: pdlG, WebkitTextFillColor: pdlG, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{"\u2193"} ${Math.round(price - levels.pdl).toLocaleString()}</span>
                                            <span style={{ color: "#333", WebkitTextFillColor: "#333", fontSize: 10 }}>{"\u00b7"}</span>
                                            <span style={{ color: pdlG, WebkitTextFillColor: pdlG, fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>{price > 0 ? ((price - levels.pdl) / price * 100).toFixed(2) : "0.00"}% away</span>
                                        </div>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                )}

                {/* ── Market Intelligence overlay ── */}
                {indicatorConfig.marketIntelligence && (() => {
                    const intel = marketIntelligence;
                    const series = seriesRef.current;

                    // Action color
                    const getActionColor = (action?: string) => {
                        if (!action) return "rgba(255,255,255,0.4)";
                        if (action.startsWith("LONG")) return "#00e676";
                        if (action.startsWith("SHORT")) return "#ff3c3c";
                        return "rgba(255,255,255,0.4)";
                    };
                    const actionColor = getActionColor(intel?.headline.action);

                    // Stream mini-bar data
                    const streamRows = intel ? [
                        { name: "BASIS", score: intel.streams.basis.score },
                        { name: "OB", score: intel.streams.orderBook.score },
                        { name: "MACRO", score: intel.streams.macro.score },
                        { name: "GAMMA", score: intel.streams.gamma.score },
                        { name: "CHAIN", score: intel.streams.onChain.score },
                    ] : [];

                    // Price formatter
                    const fmtK = (n: number) => {
                        if (n >= 1000) return "$" + (n / 1000).toFixed(0) + "K";
                        return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
                    };

                    // Level line colors
                    const levelStyle = (type: string) => {
                        switch (type) {
                            case "MAX_PAIN": return { color: "rgba(255,200,0,0.6)", border: "rgba(255,200,0,0.4)", label: "MAX PAIN" };
                            case "GAMMA_FLIP": return { color: "rgba(147,51,234,0.7)", border: "rgba(147,51,234,0.5)", label: "\u03B3 FLIP" };
                            case "CALL_WALL": return { color: "rgba(255,60,60,0.6)", border: "rgba(255,60,60,0.35)", label: "CALL WALL" };
                            case "PUT_WALL": return { color: "rgba(0,230,118,0.6)", border: "rgba(0,230,118,0.35)", label: "PUT WALL" };
                            default: return { color: "rgba(255,255,255,0.4)", border: "rgba(255,255,255,0.2)", label: type };
                        }
                    };

                    return (
                        <>
                            {/* PART A — Intelligence Card */}
                            <div style={{
                                position: "absolute", top: 12, left: 12, zIndex: 20,
                                width: 220, pointerEvents: "none",
                                background: "rgba(6,10,16,0.92)",
                                border: "1px solid rgba(255,255,255,0.08)",
                                borderLeft: `3px solid ${actionColor}`,
                                borderRadius: 4,
                                backdropFilter: "blur(8px)",
                                fontFamily: "'Oxanium', monospace",
                                padding: "8px 10px",
                                display: "flex", flexDirection: "column", gap: 6,
                                transition: "border-color 0.8s ease",
                                overflow: "hidden",
                            }}>
                                {/* Loading scan line */}
                                {intelLoading && (
                                    <div style={{
                                        position: "absolute", top: 0, left: 0, right: 0, height: 1,
                                        overflow: "hidden",
                                    }}>
                                        <div style={{
                                            position: "absolute", width: "50%", height: 1,
                                            background: "linear-gradient(90deg, transparent, #00e676, transparent)",
                                            animation: "intelScan 1.5s linear infinite",
                                        }} />
                                    </div>
                                )}

                                {/* ROW 1 — Header */}
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                    <span style={{
                                        fontFamily: "monospace", fontSize: 8, letterSpacing: 3,
                                        opacity: 0.4, textTransform: "uppercase" as const,
                                        color: "#ffffff", WebkitTextFillColor: "#ffffff",
                                    }}>INTEL</span>
                                    {intel && (
                                        <span style={{
                                            fontFamily: "monospace", fontSize: 8,
                                            background: "rgba(255,255,255,0.06)",
                                            padding: "2px 6px", borderRadius: 2,
                                            color: "#ffffff", WebkitTextFillColor: "#ffffff", opacity: 0.6,
                                        }}>{intel.headline.regime}</span>
                                    )}
                                </div>

                                {/* ROW 2 — Action */}
                                <div style={{
                                    textAlign: "center" as const,
                                    fontFamily: "'Oxanium', monospace", fontSize: 13, fontWeight: 800,
                                    letterSpacing: 2, textTransform: "uppercase" as const,
                                    color: intelError ? "rgba(255,255,255,0.3)" : intelLoading ? "rgba(255,255,255,0.4)" : actionColor,
                                    WebkitTextFillColor: intelError ? "rgba(255,255,255,0.3)" : intelLoading ? "rgba(255,255,255,0.4)" : actionColor,
                                    transition: "opacity 0.3s ease",
                                }}>
                                    {intelError ? "NO SIGNAL" : intelLoading && !intel ? "ANALYZING..." : intel?.headline.action.replace(/_/g, " ") ?? "---"}
                                </div>

                                {/* Error reconnecting text */}
                                {intelError && !intel && (
                                    <div style={{
                                        textAlign: "center" as const, fontFamily: "monospace",
                                        fontSize: 7, opacity: 0.3, color: "#ffffff",
                                    }}>RECONNECTING...</div>
                                )}

                                {/* ROW 3 — Score gauge */}
                                {intel && (
                                    <div>
                                        <div style={{
                                            position: "relative", width: "100%", height: 4,
                                            background: "rgba(255,255,255,0.06)", borderRadius: 2,
                                            overflow: "hidden",
                                        }}>
                                            {/* Center line */}
                                            <div style={{
                                                position: "absolute", left: "50%", top: 0, width: 1, height: 4,
                                                background: "rgba(255,255,255,0.25)",
                                            }} />
                                            {/* Score fill */}
                                            {intel.headline.score >= 0 ? (
                                                <div style={{
                                                    position: "absolute", left: "50%", top: 0, height: 4,
                                                    width: `${intel.headline.score * 50}%`,
                                                    background: "#00e676", borderRadius: "0 2px 2px 0",
                                                    transition: "width 0.6s ease",
                                                }} />
                                            ) : (
                                                <div style={{
                                                    position: "absolute", top: 0, height: 4,
                                                    right: "50%",
                                                    width: `${Math.abs(intel.headline.score) * 50}%`,
                                                    background: "#ff3c3c", borderRadius: "2px 0 0 2px",
                                                    transition: "width 0.6s ease",
                                                }} />
                                            )}
                                        </div>
                                        <div style={{
                                            display: "flex", justifyContent: "space-between", alignItems: "center",
                                            marginTop: 2,
                                        }}>
                                            <span style={{ fontSize: 8, opacity: 0.3, color: "#ffffff", fontFamily: "monospace" }}>-1.0</span>
                                            <span style={{
                                                fontSize: 9, fontWeight: 700, color: "#ffffff",
                                                WebkitTextFillColor: "#ffffff", fontFamily: "monospace",
                                            }}>{intel.headline.score >= 0 ? "+" : ""}{intel.headline.score.toFixed(2)}</span>
                                            <span style={{ fontSize: 8, opacity: 0.3, color: "#ffffff", fontFamily: "monospace" }}>+1.0</span>
                                        </div>
                                    </div>
                                )}

                                {/* ROW 4 — Five stream bars */}
                                {intel && (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                        {streamRows.map((s) => (
                                            <div key={s.name} style={{
                                                display: "flex", alignItems: "center", gap: 4,
                                            }}>
                                                <span style={{
                                                    fontFamily: "monospace", fontSize: 7, opacity: 0.5,
                                                    width: 40, textTransform: "uppercase" as const,
                                                    color: "#ffffff", WebkitTextFillColor: "#ffffff",
                                                    flexShrink: 0,
                                                }}>{s.name}</span>
                                                <div style={{
                                                    position: "relative", width: 60, height: 3,
                                                    background: "rgba(255,255,255,0.04)", borderRadius: 1,
                                                    flexShrink: 0,
                                                }}>
                                                    {/* Center tick */}
                                                    <div style={{
                                                        position: "absolute", left: 30, top: 0, width: 1, height: 3,
                                                        background: "rgba(255,255,255,0.12)",
                                                    }} />
                                                    {s.score >= 0 ? (
                                                        <div style={{
                                                            position: "absolute", left: 30, top: 0, height: 3,
                                                            width: Math.abs(s.score) * 30,
                                                            background: "#00e676", borderRadius: "0 1px 1px 0",
                                                            transition: "width 0.6s ease",
                                                        }} />
                                                    ) : (
                                                        <div style={{
                                                            position: "absolute", top: 0, height: 3,
                                                            right: 30, width: Math.abs(s.score) * 30,
                                                            background: "#ff3c3c", borderRadius: "1px 0 0 1px",
                                                            transition: "width 0.6s ease",
                                                        }} />
                                                    )}
                                                </div>
                                                <span style={{
                                                    fontFamily: "monospace", fontSize: 7, width: 28,
                                                    textAlign: "right" as const, flexShrink: 0,
                                                    color: s.score > 0.05 ? "#00e676" : s.score < -0.05 ? "#ff3c3c" : "rgba(255,255,255,0.3)",
                                                    WebkitTextFillColor: s.score > 0.05 ? "#00e676" : s.score < -0.05 ? "#ff3c3c" : "rgba(255,255,255,0.3)",
                                                }}>{s.score >= 0 ? "+" : ""}{s.score.toFixed(2)}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* ROW 5 — Convergence / Alerts footer */}
                                {intel && intel.convergence.level === "HIGH" && intel.alerts.length === 0 && (
                                    <div style={{
                                        fontFamily: "monospace", fontSize: 7, letterSpacing: 1.5,
                                        color: "#00e676", WebkitTextFillColor: "#00e676", opacity: 0.7,
                                        borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 4,
                                    }}>
                                        {"\u25B2"} {intel.convergence.streamsAgreeing}/5 STREAMS ALIGNED
                                    </div>
                                )}
                                {intel && intel.alerts.length > 0 && intel.alerts.map((a, i) => (
                                    <div key={i} style={{
                                        fontFamily: "monospace", fontSize: 7, letterSpacing: 1.5,
                                        color: a.severity === "HIGH" ? "#ff3c3c" : "#ffd700",
                                        WebkitTextFillColor: a.severity === "HIGH" ? "#ff3c3c" : "#ffd700",
                                        borderTop: i === 0 ? "1px solid rgba(255,255,255,0.06)" : "none",
                                        paddingTop: i === 0 ? 4 : 0,
                                    }}>
                                        <span style={{ animation: "intelAlertPulse 2s infinite" }}>{"\u26A0"}</span>{" "}
                                        {a.message}
                                    </div>
                                ))}

                                {/* ROW 6 — Learning status badge */}
                                {intel?.learning && (
                                    <div style={{
                                        fontFamily: "monospace", fontSize: 7, letterSpacing: 1.2,
                                        color: intel.learning.source === "learned" ? "#00e676" : "rgba(255,255,255,0.35)",
                                        WebkitTextFillColor: intel.learning.source === "learned" ? "#00e676" : "rgba(255,255,255,0.35)",
                                        borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 3, marginTop: 1,
                                    }}>
                                        {intel.learning.source === "learned"
                                            ? `\u25C9 SELF-LEARNED WEIGHTS (n=${intel.learning.sampleSize})`
                                            : `\u25CE LEARNING (${intel.learning.gradedSignals}/${Math.max(20, intel.learning.totalSignals)} signals)`
                                        }
                                    </div>
                                )}
                            </div>

                            {/* PART B — Key Level Lines */}
                            {intel && series && (
                                <>
                                    {/* Dashed lines across chart */}
                                    <div style={{
                                        position: "absolute", inset: 0,
                                        pointerEvents: "none", zIndex: 2, overflow: "hidden",
                                    }}>
                                        {intel.keyLevels.map((kl, i) => {
                                            const y = series.priceToCoordinate(kl.price);
                                            if (y == null) return null;
                                            const st = levelStyle(kl.type);
                                            return (
                                                <div key={`intel-line-${i}`} style={{
                                                    position: "absolute", left: 0, right: 0,
                                                    top: y, height: 0,
                                                    borderTop: `1px dashed ${st.border}`,
                                                }} />
                                            );
                                        })}
                                    </div>

                                    {/* Level labels at right edge */}
                                    <div style={{
                                        position: "absolute", top: 0, right: 79, width: 160,
                                        height: "100%", pointerEvents: "none", zIndex: 8, overflow: "visible",
                                    }}>
                                        {(() => {
                                            const labels: { kl: IntelKeyLevel; y: number; st: ReturnType<typeof levelStyle> }[] = [];
                                            for (const kl of intel.keyLevels) {
                                                const y = series.priceToCoordinate(kl.price);
                                                if (y != null) labels.push({ kl, y, st: levelStyle(kl.type) });
                                            }
                                            // Collision avoidance — shift labels that overlap
                                            labels.sort((a, b) => a.y - b.y);
                                            const placed: number[] = [];
                                            for (const l of labels) {
                                                let finalY = l.y;
                                                for (const py of placed) {
                                                    if (Math.abs(finalY - py) < 14) {
                                                        finalY = py + (finalY > py ? 16 : -16);
                                                    }
                                                }
                                                placed.push(finalY);
                                                l.y = finalY;
                                            }
                                            return labels.map((l, i) => (
                                                <div key={`intel-label-${i}`} style={{
                                                    position: "absolute", right: 0,
                                                    top: l.y, transform: "translateY(-50%)",
                                                    display: "flex", alignItems: "center",
                                                }}>
                                                    <span style={{
                                                        fontFamily: "monospace", fontSize: 8,
                                                        letterSpacing: 1.5,
                                                        color: l.st.color, WebkitTextFillColor: l.st.color,
                                                        background: "rgba(6,10,16,0.7)",
                                                        padding: "1px 4px",
                                                        borderRadius: 2,
                                                        whiteSpace: "nowrap",
                                                    }}>
                                                        {l.st.label} {fmtK(l.kl.price)}
                                                    </span>
                                                </div>
                                            ));
                                        })()}
                                    </div>
                                </>
                            )}
                        </>
                    );
                })()}

                {/* ── Proximity alert badge ── */}
                {pdhProximity && (
                    <div style={{
                        position: "absolute", top: 12, left: 12, zIndex: 10,
                        background: "rgba(8,12,18,0.85)",
                        border: `1px solid ${pdhProximity === "pdh" ? "rgba(255,77,77,0.5)" : "rgba(0,230,118,0.5)"}`,
                        borderLeft: `3px solid ${pdhProximity === "pdh" ? "#ff4d4d" : "#00e676"}`,
                        borderRadius: 4,
                        padding: "7px 14px 7px 11px",
                        display: "flex", alignItems: "center", gap: 8,
                    }}>
                        <span style={{
                            width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                            background: pdhProximity === "pdh" ? "#ff4d4d" : "#00e676",
                            animation: "pdhPdlDotPulse 1.2s ease-in-out infinite",
                            display: "inline-block",
                        }} />
                        <span style={{
                            fontFamily: "monospace", fontSize: 10, letterSpacing: 2.5,
                            color: pdhProximity === "pdh" ? "#ff4d4d" : "#00e676",
                            textTransform: "uppercase", whiteSpace: "nowrap", fontWeight: 600,
                        }}>
                            APPROACHING {pdhProximity === "pdh" ? "PDH" : "PDL"}
                        </span>
                    </div>
                )}

                {/* ── Liquidity Zones: gradient bands + pill labels + badge ── */}
                {indicatorConfig.liquidityZones && liquidityZonesRef.current.length > 0 && (() => {
                    const allZones = liquidityZonesRef.current;
                    const price = livePrice || currentPriceRef.current;
                    const series = seriesRef.current;

                    // Compute dominant side (from ALL zones, before filtering)
                    let totalAbove = 0;
                    let totalBelow = 0;
                    for (const z of allZones) {
                        const liq = parseLiquidity(z.estimatedLiquidity);
                        if (z.price > price) totalAbove += liq;
                        else totalBelow += liq;
                    }
                    const sideRatio = totalAbove > 0 && totalBelow > 0
                        ? Math.min(totalAbove, totalBelow) / Math.max(totalAbove, totalBelow)
                        : 0;
                    const isBalanced = sideRatio >= 0.9;
                    const isSellHeavy = !isBalanced && totalAbove > totalBelow;
                    const badgeText = isBalanced ? "BALANCED" : isSellHeavy ? "SELL SIDE HEAVY" : "BUY SIDE HEAVY";
                    const badgeColor = isBalanced ? "#999" : isSellHeavy ? "#ff3c3c" : "#00e676";

                    // Filter to zones within 8% of price, exclude zones within 0.1% (too close)
                    const minDist = price * 0.001;
                    const withLiq = allZones
                        .filter((z) => Math.abs(z.price - price) >= minDist)
                        .map((z) => ({ zone: z, liq: parseLiquidity(z.estimatedLiquidity) }));
                    // Sort by actionabilityScore (proximity-aware) to pick most relevant zones
                    const sortByAction = (a: typeof withLiq[0], b: typeof withLiq[0]) =>
                        (b.zone.actionabilityScore ?? b.zone.strength) - (a.zone.actionabilityScore ?? a.zone.strength);
                    const within8above = withLiq.filter((w) => w.zone.price > price && (w.zone.price - price) / price <= 0.08).sort(sortByAction);
                    const within8below = withLiq.filter((w) => w.zone.price <= price && (price - w.zone.price) / price <= 0.08).sort(sortByAction);
                    let topAbove = within8above.slice(0, 2);
                    let topBelow = within8below.slice(0, 2);
                    // If one side is empty within 8%, expand to 12% for that side only
                    if (topAbove.length === 0) {
                        const within12above = withLiq.filter((w) => w.zone.price > price && (w.zone.price - price) / price <= 0.12).sort(sortByAction);
                        topAbove = within12above.slice(0, 2);
                    }
                    if (topBelow.length === 0) {
                        const within12below = withLiq.filter((w) => w.zone.price <= price && (price - w.zone.price) / price <= 0.12).sort(sortByAction);
                        topBelow = within12below.slice(0, 2);
                    }
                    // Rank-based tier by structuralScore (pure historical significance)
                    const assignTier = (arr: typeof topAbove) => {
                        const byStructure = [...arr].sort((a, b) =>
                            (b.zone.structuralScore ?? b.zone.strength) - (a.zone.structuralScore ?? a.zone.strength));
                        return arr.map((z) => ({
                            ...z,
                            zone: { ...z.zone, estimatedLiquidity: byStructure.indexOf(z) === 0 ? "high" : "medium" as string },
                        }));
                    };
                    const zones = [...assignTier(topAbove), ...assignTier(topBelow)]; // max 4
                    const maxLiq = Math.max(...zones.map((w) => w.liq), 1);

                    // Build positioned entries
                    const entries: { zone: LiquidityZone; y: number; liq: number; ratio: number }[] = [];
                    if (series) {
                        for (const w of zones) {
                            const y = series.priceToCoordinate(w.zone.price);
                            if (y != null) entries.push({ zone: w.zone, y, liq: w.liq, ratio: w.liq / maxLiq });
                        }
                    }

                    // Collision avoidance for pill labels
                    const pills = entries.map((e) => ({ ...e, pillY: e.y }));
                    pills.sort((a, b) => b.liq - a.liq);
                    const placed: number[] = [];
                    for (const p of pills) {
                        for (const py of placed) {
                            if (Math.abs(p.pillY - py) < 16) {
                                p.pillY = py + (p.pillY > py ? 20 : -20);
                            }
                        }
                        placed.push(p.pillY);
                    }

                    const fmtPrice = (n: number) => "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
                    const fmtDollarLiq = (amount: number): string => {
                        if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`;
                        if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
                        if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
                        return `$${Math.round(amount)}`;
                    };

                    return (
                        <>
                            {/* Gradient bands — full chart width */}
                            <div style={{
                                position: "absolute", inset: 0,
                                pointerEvents: "none", zIndex: 1, overflow: "hidden",
                            }}>
                                {entries.map((e, i) => {
                                    const isAbove = e.zone.price > price;
                                    const isHigh = e.zone.estimatedLiquidity === "high";
                                    const bandH = 2 + e.ratio * 10;
                                    const bandOpacity = 0.08 + e.ratio * 0.27;
                                    const rgba = isAbove
                                        ? `rgba(255,60,60,${bandOpacity})`
                                        : `rgba(0,230,118,${bandOpacity})`;
                                    const glow = isHigh
                                        ? isAbove ? "0 0 8px rgba(255,60,60,0.2)" : "0 0 8px rgba(0,230,118,0.15)"
                                        : "none";
                                    return (
                                        <div key={`band-${i}`}>
                                            {/* Gradient band */}
                                            <div style={{
                                                position: "absolute", left: 0, right: 0,
                                                top: e.y - bandH / 2,
                                                height: bandH,
                                                background: `linear-gradient(to right, transparent 0%, ${rgba} 100%)`,
                                                boxShadow: glow,
                                            }} />
                                            {/* 1px anchor line */}
                                            <div style={{
                                                position: "absolute", left: 0, right: 0,
                                                top: e.y,
                                                height: 1,
                                                background: isAbove ? "#ff3c3c" : "#00e676",
                                            }} />
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Pill labels overlay */}
                            <div style={{
                                position: "absolute", top: 0, right: 79, width: 180,
                                height: "100%", pointerEvents: "none", zIndex: 9, overflow: "visible",
                            }}>
                                {pills.map((p, i) => {
                                    const isAbove = p.zone.price > price;
                                    const c = isAbove ? "#ff3c3c" : "#00e676";
                                    const liqLabel = formatLiquidity(p.zone.estimatedLiquidity);
                                    const tierBg = liqLabel === "HIGH" ? "rgba(255,255,255,0.15)"
                                        : liqLabel === "MED" ? "rgba(255,255,255,0.10)"
                                        : "rgba(255,255,255,0.06)";
                                    const tierColor = liqLabel === "HIGH" ? "#ffffff"
                                        : liqLabel === "MED" ? "rgba(255,255,255,0.75)"
                                        : "rgba(255,255,255,0.45)";
                                    const tierWeight = liqLabel === "HIGH" ? 800
                                        : liqLabel === "MED" ? 600 : 400;
                                    return (
                                        <div key={i} style={{
                                            position: "absolute", right: 0,
                                            top: p.pillY, transform: "translateY(-50%)",
                                            display: "flex", alignItems: "center",
                                            textDecoration: "none", overflow: "visible",
                                        }}>
                                            {liqLabel && (
                                                <span style={{
                                                    background: tierBg,
                                                    border: `1px solid ${isAbove ? "rgba(255,60,60,0.4)" : "rgba(0,230,118,0.4)"}`,
                                                    color: tierColor, WebkitTextFillColor: tierColor,
                                                    fontFamily: "monospace", fontSize: 9, fontWeight: tierWeight,
                                                    padding: "2px 6px", borderRadius: "4px 0 0 4px",
                                                    borderRight: "none", whiteSpace: "nowrap",
                                                }}>{liqLabel}</span>
                                            )}
                                            <span style={{
                                                background: c,
                                                color: isAbove ? "#ffffff" : "#000000",
                                                WebkitTextFillColor: isAbove ? "#ffffff" : "#000000",
                                                fontFamily: "monospace", fontSize: 9, fontWeight: 700,
                                                padding: "2px 6px",
                                                borderRadius: `${liqLabel ? 0 : 4}px 0 0 ${liqLabel ? 0 : 4}px`,
                                                whiteSpace: "nowrap",
                                            }}>{fmtPrice(p.zone.price)}</span>
                                            <span style={{
                                                fontSize: 9, fontWeight: 700, fontFamily: "monospace",
                                                letterSpacing: "0.5px", marginLeft: 4,
                                                color: c, WebkitTextFillColor: c,
                                                opacity: p.zone.dollarLiquidity > 0 ? 1 : 0.5,
                                                textDecoration: "none",
                                                textShadow: isAbove
                                                    ? "0 0 6px rgba(255,60,60,0.6)"
                                                    : "0 0 6px rgba(0,230,118,0.6)",
                                                whiteSpace: "nowrap",
                                            }}>{p.zone.dollarLiquidity > 0 ? fmtDollarLiq(p.zone.dollarLiquidity) : "ACTIVE"}</span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Dominant side badge */}
                            <div style={{
                                position: "absolute",
                                top: pdhProximity ? 48 : 12,
                                left: 12, zIndex: 10,
                                background: "rgba(8,12,18,0.85)",
                                border: `1px solid ${isBalanced ? "rgba(255,255,255,0.25)" : isSellHeavy ? "rgba(255,60,60,0.45)" : "rgba(0,230,118,0.45)"}`,
                                borderLeft: `3px solid ${isBalanced ? "rgba(255,255,255,0.6)" : badgeColor}`,
                                borderRadius: 4,
                                padding: "6px 12px",
                                display: "flex", alignItems: "center",
                                pointerEvents: "none",
                            }}>
                                <span style={{
                                    fontFamily: "monospace", fontSize: 10, letterSpacing: 2.5,
                                    color: isBalanced ? "rgba(255,255,255,0.7)" : badgeColor,
                                    WebkitTextFillColor: isBalanced ? "rgba(255,255,255,0.7)" : badgeColor,
                                    textTransform: "uppercase", whiteSpace: "nowrap", fontWeight: 600,
                                }}>{badgeText}</span>
                            </div>
                        </>
                    );
                })()}
            </div>

            {/* Order Blocks — DOM overlay */}
            {indicatorConfig.orderBlocks && orderBlocksState.length > 0 && seriesRef.current && chartRef.current && (() => {
                const chartWidth = containerRef.current?.clientWidth ?? 0;
                if (chartWidth === 0) return null;

                return (
                    <div style={{
                        position: "absolute", inset: 0,
                        pointerEvents: "none", zIndex: 2, overflow: "hidden",
                    }}>
                        {orderBlocksState.map((ob, i) => {
                            const series = seriesRef.current!;
                            const chart = chartRef.current!;
                            const yTop = series.priceToCoordinate(ob.top);
                            const yBottom = series.priceToCoordinate(ob.bottom);
                            if (yTop == null || yBottom == null) return null;

                            const xStart = chart.timeScale().timeToCoordinate(ob.startTime as Time);
                            if (xStart == null || xStart < 20) return null;
                            const x = xStart;
                            const w = chartWidth - x;

                            const top = Math.min(yTop, yBottom);
                            const height = Math.max(Math.abs(yTop - yBottom), 4);

                            const isBullish = ob.type === "bullish";
                            const color = isBullish ? "0, 230, 118" : "255, 60, 60";

                            return (
                                <div key={`ob-${i}`}>
                                    {/* OB zone fill */}
                                    <div style={{
                                        position: "absolute",
                                        left: x, width: w,
                                        top, height,
                                        background: `rgba(${color}, 0.06)`,
                                        borderTop: `1px solid rgba(${color}, 0.35)`,
                                        borderBottom: `1px solid rgba(${color}, 0.35)`,
                                    }} />
                                    {/* Left edge marker at formation candle */}
                                    <div style={{
                                        position: "absolute",
                                        left: x, width: 2,
                                        top, height,
                                        background: `rgba(${color}, 0.7)`,
                                    }} />
                                    {/* OB label — right edge of box */}
                                    <div style={{
                                        position: "absolute",
                                        left: x + w - 68,
                                        top: top + height / 2 - 6,
                                        fontFamily: "'Oxanium', monospace",
                                        fontSize: 9,
                                        letterSpacing: 1,
                                        color: isBullish ? "#00e676" : "#ff3c3c",
                                        WebkitTextFillColor: isBullish ? "#00e676" : "#ff3c3c",
                                        opacity: 0.9,
                                        lineHeight: "12px",
                                        background: "rgba(0,0,0,0.4)",
                                        padding: "1px 3px",
                                        borderRadius: 2,
                                        whiteSpace: "nowrap",
                                    }}>OB ${((ob.top + ob.bottom) / 2 / 1000).toFixed(1)}K</div>
                                </div>
                            );
                        })}
                    </div>
                );
            })()}

            {/* Volume sub-panel */}
            {indicatorConfig.volume && rawCandlesRef.current.length > 0 && (<>
                <DragHandle panelKey="volume" currentHeight={panelHeights.volume ?? 80} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <VolumePanel candles={rawCandlesRef.current} mainChart={chartRef.current} height={panelHeights.volume} />
            </>)}

            {/* MACD sub-panel */}
            {indicatorConfig.macd && macdData.macd.length > 0 && (<>
                <DragHandle panelKey="macd" currentHeight={panelHeights.macd ?? 100} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <MACDPanel data={macdData} mainChart={chartRef.current} height={panelHeights.macd} />
            </>)}

            {/* RSI sub-panel */}
            {indicatorConfig.rsi && rsiData.length > 0 && (<>
                <DragHandle panelKey="rsi" currentHeight={panelHeights.rsi ?? 80} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <RsiPanel rsiData={rsiData} mainChart={chartRef.current} height={panelHeights.rsi} />
            </>)}

            {/* ATR sub-panel */}
            {indicatorConfig.atr && atrData.length > 0 && (<>
                <DragHandle panelKey="atr" currentHeight={panelHeights.atr ?? 120} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <ATRPanel atrData={atrData} mainChart={chartRef.current} height={panelHeights.atr} />
            </>)}

            {/* Delta sub-panel */}
            {indicatorConfig.delta && deltaData.length > 0 && (<>
                <DragHandle panelKey="delta" currentHeight={panelHeights.delta ?? 80} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <DeltaPanel deltaData={deltaData} mainChart={chartRef.current} height={panelHeights.delta} />
            </>)}

            {/* CVD sub-panel */}
            {indicatorConfig.cvd && cvdData.length > 0 && (<>
                <DragHandle panelKey="cvd" currentHeight={panelHeights.cvd ?? 60} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <CvdPanel cvdData={cvdData} divergences={cvdDivergences} dataSource={cvdDataSource} mainChart={chartRef.current} height={panelHeights.cvd} />
            </>)}

            {/* Funding Rate sub-panel */}
            {indicatorConfig.fundingRate && (<>
                <DragHandle panelKey="fundingRate" currentHeight={panelHeights.fundingRate ?? 80} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <FundingRatePanel mainChart={chartRef.current} pairSymbol={selectedPairSymbol} height={panelHeights.fundingRate} />
            </>)}

            {/* Open Interest sub-panel */}
            {indicatorConfig.openInterest && (<>
                <DragHandle panelKey="openInterest" currentHeight={panelHeights.openInterest ?? 100} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <OpenInterestPanel mainChart={chartRef.current} pairSymbol={selectedPairSymbol} height={panelHeights.openInterest} />
            </>)}

            {/* COT Report sub-panel */}
            {indicatorConfig.cotReport && (<>
                <DragHandle panelKey="cotReport" currentHeight={panelHeights.cotReport ?? 100} onHeightChange={handleHeightChange} onDragEnd={handleDragEnd} />
                <COTPanel mainChart={chartRef.current} pairSymbol={selectedPairSymbol} height={panelHeights.cotReport} />
            </>)}
        </div>
    );
}
