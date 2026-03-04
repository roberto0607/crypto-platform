import { Outlet, NavLink } from "react-router-dom";
import SystemBanner from "@/components/SystemBanner";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/trade", label: "Trade" },
  { to: "/orders", label: "Orders" },
  { to: "/wallets", label: "Wallets" },
  { to: "/positions", label: "Positions" },
  { to: "/triggers", label: "Triggers" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/bot", label: "Bot" },
  { to: "/replay", label: "Replay" },
  { to: "/settings", label: "Settings" },
] as const;

export default function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-gray-100">
      <SystemBanner />
      <nav className="border-b border-gray-800 px-4">
        <div className="flex items-center gap-1 overflow-x-auto py-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-gray-800 text-white font-medium"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}
