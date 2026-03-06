import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import PairSelector from "@/components/trading/PairSelector";
import { CompetitionSelector } from "@/components/trading/CompetitionSelector";
import PriceTicker from "@/components/trading/PriceTicker";
import OrderBook from "@/components/trading/OrderBook";
import OrderForm from "@/components/trading/OrderForm";
import RecentTrades from "@/components/trading/RecentTrades";
import OpenOrders from "@/components/trading/OpenOrders";
import { CandlestickChart } from "@/components/trading/CandlestickChart";
import Card from "@/components/Card";

export default function TradingPage() {
  const sseConnected = useAppStore((s) => s.sseConnected);

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

      {/* Main content: Chart + Order Form */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Chart: spans 3 columns */}
        <div className="lg:col-span-3">
          <Card className="h-[400px] p-2">
            <CandlestickChart />
          </Card>
        </div>

        {/* Order form: 1 column */}
        <div className="lg:col-span-1">
          <Card className="p-4">
            <OrderForm />
          </Card>
        </div>
      </div>

      {/* Bottom row: Order Book + Recent Trades + Open Orders */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="min-h-[300px] p-2">
          <OrderBook />
        </Card>
        <Card className="min-h-[300px] p-2">
          <RecentTrades />
        </Card>
        <Card className="min-h-[300px] p-2">
          <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-2 px-1">
            Open Orders
          </div>
          <OpenOrders />
        </Card>
      </div>
    </div>
  );
}
