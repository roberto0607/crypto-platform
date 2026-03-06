import { useAppStore } from "@/stores/appStore";
import { useTradingStore } from "@/stores/tradingStore";
import PairSelector from "@/components/trading/PairSelector";
import { CompetitionSelector } from "@/components/trading/CompetitionSelector";
import PriceTicker from "@/components/trading/PriceTicker";
import OrderBook from "@/components/trading/OrderBook";
import OrderForm from "@/components/trading/OrderForm";
import RecentTrades from "@/components/trading/RecentTrades";
import OpenOrders from "@/components/trading/OpenOrders";
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

      {/* Main grid: Order Book | Order Form | Recent Trades */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Order Book */}
        <Card className="lg:col-span-1 min-h-[400px] flex flex-col p-2">
          <OrderBook />
        </Card>

        {/* Order Form */}
        <Card className="lg:col-span-1 p-4">
          <OrderForm />
        </Card>

        {/* Recent Trades */}
        <Card className="lg:col-span-1 min-h-[400px] flex flex-col p-2">
          <RecentTrades />
        </Card>
      </div>

      {/* Open Orders */}
      <Card className="p-2">
        <div className="text-[10px] uppercase text-gray-500 font-medium px-2 pb-2 tracking-wider">
          Open Orders
        </div>
        <OpenOrders />
      </Card>
    </div>
  );
}
