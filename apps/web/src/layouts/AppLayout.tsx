import { useState } from "react";
import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { useSystemStatusPolling } from "@/hooks/useSystemStatusPolling";
import { useRefreshTokenKeepAlive } from "@/hooks/useRefreshTokenKeepAlive";
import SystemBanner from "@/components/SystemBanner";
import Badge from "@/components/Badge";
import { useSSE } from "@/hooks/useSSE";

// ── SVG icon paths (heroicons outline, 24x24 viewBox) ──────
const ICONS: Record<string, string> = {
  home: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1",
  chart: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6m6 0h6m-6 0V9a2 2 0 012-2h2a2 2 0 012 2v10m6 0v-4a2 2 0 00-2-2h-2a2 2 0 00-2 2v4",
  list: "M4 6h16M4 10h16M4 14h16M4 18h16",
  wallet: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z",
  layers: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10",
  zap: "M13 10V3L4 14h7v7l9-11h-7z",
  trendingUp: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
  cpu: "M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z",
  play: "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  settings: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  trophy: "M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z",
  shield: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
  logout: "M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1",
  menu: "M4 6h16M4 12h16M4 18h16",
  x: "M6 18L18 6M6 6l12 12",
};

function Icon({ name, className = "w-5 h-5" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: "home" },
  { to: "/trade", label: "Trade", icon: "chart" },
  { to: "/orders", label: "Orders", icon: "list" },
  { to: "/wallets", label: "Wallets", icon: "wallet" },
  { to: "/positions", label: "Positions", icon: "layers" },
  { to: "/triggers", label: "Triggers", icon: "zap" },
  { to: "/portfolio", label: "Portfolio", icon: "trendingUp" },
  { to: "/competitions", label: "Compete", icon: "trophy" },
  { to: "/bot", label: "Bot", icon: "cpu" },
  { to: "/replay", label: "Replay", icon: "play" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const riskStatus = useAppStore((s) => s.riskStatus);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useSystemStatusPolling();
  useRefreshTokenKeepAlive();
  const { sseConnected } = useSSE();

  function handleLogout() {
    clearAuth();
    navigate("/login", { replace: true });
  }

  const tradingAllowed = riskStatus?.trading_allowed ?? true;
  const activeBreakers = riskStatus?.breakers ?? [];

  return (
    <div className="min-h-screen flex flex-col bg-gray-950 text-gray-100">
      <SystemBanner />

      {/* Top bar */}
      <header className="border-b border-gray-800 px-4 py-2 flex items-center justify-between">
        <button
          className="lg:hidden text-gray-400 hover:text-white"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <Icon name={sidebarOpen ? "x" : "menu"} />
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-3">
          {/* SSE connection indicator */}
          <div className="flex items-center gap-1.5" title={sseConnected ? "Real-time connected" : "Real-time disconnected"}>
            <span className={`inline-block h-2 w-2 rounded-full ${sseConnected ? "bg-blue-500 animate-pulse" : "bg-gray-600"}`} />
            <span className="text-xs text-gray-400 hidden sm:inline">
              {sseConnected ? "LIVE" : "OFFLINE"}
            </span>
          </div>

          {/* Risk status indicator */}
          <div className="flex items-center gap-1.5" title={
            tradingAllowed
              ? "Trading allowed"
              : activeBreakers.map((b) => b.reason || b.breaker_key).join(", ")
          }>
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${tradingAllowed ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-xs text-gray-400 hidden sm:inline">
              {tradingAllowed ? "Trading OK" : "Breakers active"}
            </span>
          </div>

          {/* User info */}
          {user && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-300 hidden sm:inline">{user.email}</span>
              <Badge color={user.role === "ADMIN" ? "yellow" : "gray"}>{user.role}</Badge>
            </div>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className={`
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0 fixed lg:static inset-y-0 left-0 z-30
          w-52 border-r border-gray-800 bg-gray-950 flex flex-col
          transition-transform duration-200 ease-in-out
        `}>
          <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors ${
                    isActive
                      ? "bg-gray-800 text-white font-medium"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                  }`
                }
              >
                <Icon name={item.icon} />
                {item.label}
              </NavLink>
            ))}

            {isAdmin && (
              <NavLink
                to="/admin"
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded text-sm transition-colors ${
                    isActive
                      ? "bg-gray-800 text-white font-medium"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                  }`
                }
              >
                <Icon name="shield" />
                Admin
              </NavLink>
            )}
          </nav>

          <div className="border-t border-gray-800 p-2">
            <button
              onClick={handleLogout}
              className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
            >
              <Icon name="logout" />
              Logout
            </button>
          </div>
        </aside>

        {/* Backdrop for mobile sidebar */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-20 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
