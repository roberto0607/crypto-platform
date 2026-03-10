import OrderBook from "@/components/trading/OrderBook";
import RecentTrades from "@/components/trading/RecentTrades";
import OpenOrders from "@/components/trading/OpenOrders";
import Card from "@/components/Card";

export default function MarketTab() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="h-[180px] p-2 overflow-y-auto">
        <OrderBook />
      </Card>
      <Card className="h-[180px] p-2 overflow-y-auto">
        <RecentTrades />
      </Card>
      <Card className="h-[180px] p-2 overflow-y-auto">
        <div className="text-[10px] text-gray-600 uppercase tracking-widest mb-2 px-1">
          Open Orders
        </div>
        <OpenOrders />
      </Card>
    </div>
  );
}
