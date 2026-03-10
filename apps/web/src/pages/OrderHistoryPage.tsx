import OrdersTab from "@/components/trading/OrdersTab";

export default function OrderHistoryPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-white">Order History</h1>
      <OrdersTab />
    </div>
  );
}
