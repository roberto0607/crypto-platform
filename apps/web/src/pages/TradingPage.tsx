import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import PairSelector from "@/components/trading/PairSelector";
import { CompetitionSelector } from "@/components/trading/CompetitionSelector";
import PriceTicker from "@/components/trading/PriceTicker";
import OrderForm from "@/components/trading/OrderForm";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import { MarketContext } from "@/components/trading/MarketContext";
import { LiquidationHeatmap } from "@/components/trading/LiquidationHeatmap";
import { TradeSetupCard } from "@/components/trading/TradeSetupCard";
import MarketTab from "@/components/trading/MarketTab";
import OrdersTab from "@/components/trading/OrdersTab";
import PositionsTab from "@/components/trading/PositionsTab";
import TriggersTab from "@/components/trading/TriggersTab";
import { getDerivatives } from "@/api/endpoints/signals";
import type { TradeSetup } from "@/lib/confluenceEngine";
import Card from "@/components/Card";

const BOTTOM_TABS = [
  { key: "market", label: "Market" },
  { key: "orders", label: "Orders" },
  { key: "positions", label: "Positions" },
  { key: "triggers", label: "Triggers" },
] as const;

export default function TradingPage() {
  const sseConnected = useAppStore((s) => s.sseConnected);
  const selectedPairId = useTradingStore((s) => s.selectedPairId);
  const snapshot = useTradingStore((s) => s.snapshot);
  const bottomTab = useTradingStore((s) => s.bottomTab);
  const setBottomTab = useTradingStore((s) => s.setBottomTab);
  const currentPrice = snapshot ? parseFloat(snapshot.last) : 0;
  const [tradeSetup, setTradeSetup] = useState<TradeSetup | null>(null);
  const [fundingRate, setFundingRate] = useState(0);
  const [searchParams] = useSearchParams();

  // Support ?tab= query param for deep links / redirects
  useEffect(() => {
    const tabParam = searchParams.get("tab");
    if (tabParam && ["market", "orders", "positions", "triggers"].includes(tabParam)) {
      setBottomTab(tabParam as typeof bottomTab);
    }
  }, [searchParams, setBottomTab]);

  // Fetch funding rate for confluence engine
  useEffect(() => {
    if (!selectedPairId) return;
    const fetchFunding = async () => {
      try {
        const res = await getDerivatives(selectedPairId);
        setFundingRate(res.data.derivatives?.fundingRate ?? 0);
      } catch { /* non-fatal */ }
    };
    fetchFunding();
    const interval = setInterval(fetchFunding, 60_000);
    return () => clearInterval(interval);
  }, [selectedPairId]);

  const handleTradeSetupChange = useCallback((setup: TradeSetup | null) => {
    setTradeSetup(setup);
  }, []);

  return (
    <div className="space-y-4">
      {/* Competition banner */}
      {useTradingStore((s) => s.activeCompetitionId) && (
        <div className="bg-blue-900/30 border border-blue-700 rounded px-4 py-2 flex items-center gap-3">
          <span className="text-blue-400 text-sm font-medium">Competition Mode</span>
          <span className="text-gray-400 text-xs">
            Trades and balances are isolated to this competition
          </span>
        </div>
      )}

      {/* Top bar: pair selector + competition selector + price ticker + SSE dot */}
      <div className="flex flex-wrap items-center gap-4">
        <PairSelector />
        <CompetitionSelector />
        <div className="flex-1" />
        <PriceTicker />
        <div
          className="flex items-center gap-1"
          title={sseConnected ? "Real-time connected" : "Real-time disconnected"}
        >
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              sseConnected ? "bg-blue-500 animate-pulse" : "bg-gray-600"
            }`}
          />
        </div>
      </div>

      {/* Main content: Chart + Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Chart: spans 3 columns */}
        <div className="lg:col-span-3">
          <Card className="h-[560px] p-2">
            <CandlestickChart
              fundingRate={fundingRate}
              onTradeSetupChange={handleTradeSetupChange}
            />
          </Card>
        </div>

        {/* Sidebar: Market Context + Liquidation Heatmap + Order Form */}
        <div className="lg:col-span-1 space-y-3">
          {/* Market Context strip */}
          {selectedPairId && (
            <MarketContext pairId={selectedPairId} />
          )}

          {/* Trade Setup Card */}
          <Card className="p-3">
            <TradeSetupCard setup={tradeSetup} />
          </Card>

          {/* Liquidation Heatmap */}
          {selectedPairId && currentPrice > 0 && (
            <Card className="p-3">
              <LiquidationHeatmap pairId={selectedPairId} currentPrice={currentPrice} />
            </Card>
          )}

          {/* Order Form */}
          <Card className="p-4 overflow-y-auto max-h-[380px]">
            <OrderForm />
          </Card>
        </div>
      </div>

      {/* Bottom: Tabbed panel */}
      <div>
        {/* Tab bar */}
        <div className="flex gap-1 bg-gray-900 rounded-t-lg p-1 border border-gray-800 border-b-0">
          {BOTTOM_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setBottomTab(tab.key)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                bottomTab === tab.key
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="border border-gray-800 rounded-b-lg bg-gray-900 p-2 min-h-[180px]">
          {bottomTab === "market" && <MarketTab />}
          {bottomTab === "orders" && (
            <div className="max-h-[500px] overflow-y-auto">
              <OrdersTab />
            </div>
          )}
          {bottomTab === "positions" && (
            <div className="max-h-[500px] overflow-y-auto">
              <PositionsTab />
            </div>
          )}
          {bottomTab === "triggers" && (
            <div className="max-h-[500px] overflow-y-auto">
              <TriggersTab />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
