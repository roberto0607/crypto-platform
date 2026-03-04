import { useAppStore } from "@/stores/appStore";
import PairSelector from "@/components/trading/PairSelector";
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
      {/* Top bar: pair selector + price ticker + SSE dot */}
      <div className="flex flex-wrap items-center gap-4">
        <PairSelector />
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
