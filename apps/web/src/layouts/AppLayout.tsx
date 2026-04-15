import { useState, useEffect, useRef } from "react";
import { Outlet, NavLink, useNavigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { useAppStore } from "@/stores/appStore";
import { useCompetitionStore } from "@/stores/competitionStore";
import { useThemeStore } from "@/stores/themeStore";
import { useSystemStatusPolling } from "@/hooks/useSystemStatusPolling";
import { useRefreshTokenKeepAlive } from "@/hooks/useRefreshTokenKeepAlive";
import SystemBanner from "@/components/SystemBanner";
import { NotificationBell } from "@/components/NotificationBell";
import TickerBar from "@/components/TickerBar";
import { useSSE } from "@/hooks/useSSE";

// ── Sidebar nav — Trade Wars ──
const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      { to: "/trade", label: "Trade", icon: "\u25C8" },
      { to: "/arena", label: "Arena", icon: "\u2694" },
      { to: "/cycle", label: "Cycle", icon: "\u29BF" },
      { to: "/history", label: "History", icon: "\u270E" },
      { to: "/profile", label: "Profile", icon: "\u2666" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/settings", label: "Settings", icon: "\u2699" },
    ],
  },
];

function breadcrumbLabel(pathname: string): string {
  if (pathname.startsWith("/admin")) return "ADMIN";
  if (pathname.startsWith("/trade")) return "TRADE";
  if (pathname.startsWith("/arena")) return "ARENA";
  if (pathname.startsWith("/history")) return "HISTORY";
  if (pathname.startsWith("/profile")) return "PROFILE";
  if (pathname.startsWith("/settings")) return "SETTINGS";
  return "TRADE";
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const riskStatus = useAppStore((s) => s.riskStatus);
  const userTier = useCompetitionStore((s) => s.userTier);
  const currentTheme = useThemeStore((s) => s.currentTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close user menu on outside click — matches NotificationBell / IndicatorToolbar pattern.
  // Previously used onBlur with a setTimeout, but that fired spuriously on the same
  // click that opened the menu in some browsers (aria-expanded re-render blurring
  // the button), making the menu appear non-clickable.
  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [userMenuOpen]);
  const isTradePage = location.pathname === "/trade";
  const isWarTheme = currentTheme === "tradewars";

  useSystemStatusPolling();
  useRefreshTokenKeepAlive();
  const { sseConnected, sseConnectionState } = useSSE();
  const lastPriceTickAt = useAppStore((s) => s.lastPriceTickAt);
  const [priceStale, setPriceStale] = useState(false);

  useEffect(() => {
    if (!sseConnected) { setPriceStale(false); return; }
    const id = setInterval(() => {
      const stale = lastPriceTickAt > 0 && Date.now() - lastPriceTickAt > 10_000;
      setPriceStale(stale);
    }, 3_000);
    return () => clearInterval(id);
  }, [sseConnected, lastPriceTickAt]);

  // ── Hard-offline fallback ──
  // If "reconnecting" persists > 60s, surface OFFLINE + a refresh CTA so the
  // user isn't stuck staring at a spinner.
  const [isHardOffline, setIsHardOffline] = useState(false);
  useEffect(() => {
    if (sseConnectionState !== "reconnecting") {
      setIsHardOffline(false);
      return;
    }
    const id = setTimeout(() => setIsHardOffline(true), 60_000);
    return () => clearTimeout(id);
  }, [sseConnectionState]);

  function handleLogout() {
    // Belt-and-suspenders: authStore.clearAuth already revokes the refresh
    // cookie server-side (via POST /auth/logout) and removes tradr_session.
    // We also wipe sessionStorage here per the logout spec. localStorage is
    // left intact so indicator/panel/theme prefs survive re-login.
    try { sessionStorage.clear(); } catch { /* ignore */ }
    clearAuth();
    setUserMenuOpen(false);
    navigate("/login", { replace: true });
  }

  const tradingAllowed = riskStatus?.trading_allowed ?? true;

  const initials = user?.displayName
    ? user.displayName.slice(0, 2).toUpperCase()
    : user?.email
      ? user.email.slice(0, 2).toUpperCase()
      : "??";

  return (
    <div className={`min-h-screen flex flex-col bg-tradr-bg text-white/85 ${isTradePage ? "trade-layout h-screen" : ""}`}>
      {/* Background effects */}
      <div className="fixed inset-0 pointer-events-none z-0 grid-bg" />
      <div className="fixed inset-0 pointer-events-none z-0 radial-glow-bg" style={{ background: isWarTheme ? "radial-gradient(ellipse 70% 60% at 50% 40%, rgba(255,107,0,0.04) 0%, transparent 65%)" : "radial-gradient(ellipse 70% 60% at 50% 40%, rgba(0,255,65,0.04) 0%, transparent 65%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[1]" style={{ background: "radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[2] scanlines-bg" />

      <SystemBanner />

      <div className="flex flex-1 overflow-hidden relative z-10">
        {/* ── SIDEBAR ── */}
        <aside className={`
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0 fixed lg:static inset-y-0 left-0 z-50
          ${isTradePage ? "w-[52px]" : "w-[220px]"} border-r border-tradr-green/[0.18] bg-tradr-bg/95
          flex flex-col transition-all duration-200 ease-in-out
        `}>
          {/* Logo */}
          <div className={`${isTradePage ? "px-0 justify-center" : "px-5"} py-6 border-b border-tradr-green/[0.18] flex items-center gap-2.5`}>
            {!isTradePage && (
              <span className="t-logo-text">
                {isWarTheme ? <>TR<span>A</span>DE W<span>A</span>RS</> : <>TR<span>A</span>DR</>}
              </span>
            )}
            <div className="t-logo-dot" />
          </div>

          {/* Nav sections */}
          <nav className="flex-1 overflow-y-auto">
            {NAV_SECTIONS.map((section) => (
              <div key={section.label} className={`${isTradePage ? "pt-3 pb-1" : "pt-5 pb-2"}`}>
                {!isTradePage && (
                  <div className="px-5 mb-2 text-[8px] text-white/30 tracking-[4px] uppercase font-mono">
                    {section.label}
                  </div>
                )}
                <ul className="list-none">
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        onClick={() => setSidebarOpen(false)}
                        title={isTradePage ? item.label : undefined}
                        className={({ isActive }) =>
                          `flex items-center ${isTradePage ? "justify-center px-0 py-2" : "gap-3 px-5 py-2.5"} text-[11px] tracking-[1px] font-mono
                          border-l-2 transition-all duration-200 no-underline
                          ${isActive
                            ? "text-tradr-green border-l-tradr-green bg-tradr-green/[0.06]"
                            : "text-white/30 border-l-transparent hover:text-white/85 hover:bg-tradr-green/[0.06] hover:border-l-tradr-green/30"
                          }`
                        }
                      >
                        <span className="text-sm w-5 text-center">{item.icon}</span>
                        {!isTradePage && item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}

            {isAdmin && (
              <div className={`${isTradePage ? "pt-1 pb-1" : "pt-2 pb-2"}`}>
                {!isTradePage && (
                  <div className="px-5 mb-2 text-[8px] text-white/30 tracking-[4px] uppercase font-mono">
                    Admin
                  </div>
                )}
                <NavLink
                  to="/admin"
                  onClick={() => setSidebarOpen(false)}
                  title={isTradePage ? "Admin" : undefined}
                  className={({ isActive }) =>
                    `flex items-center ${isTradePage ? "justify-center px-0 py-2" : "gap-3 px-5 py-2.5"} text-[11px] tracking-[1px] font-mono
                    border-l-2 transition-all duration-200 no-underline
                    ${isActive
                      ? "text-tradr-green border-l-tradr-green bg-tradr-green/[0.06]"
                      : "text-white/30 border-l-transparent hover:text-white/85 hover:bg-tradr-green/[0.06] hover:border-l-tradr-green/30"
                    }`
                  }
                >
                  <span className="text-sm w-5 text-center">{"\u2666"}</span>
                  {!isTradePage && "Admin"}
                </NavLink>
              </div>
            )}
          </nav>

          {/* User info at bottom */}
          <div className={`mt-auto border-t border-tradr-green/[0.18] ${isTradePage ? "px-0 py-3 justify-center" : "px-5 py-4"} flex items-center gap-2.5`}>
            <div className="w-8 h-8 rounded-full border border-tradr-green/[0.18] bg-tradr-bg2 flex items-center justify-center text-xs text-tradr-green font-mono flex-shrink-0">
              {initials}
            </div>
            {!isTradePage && (
              <>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-white/85 tracking-[1px] truncate font-mono">
                    {user?.displayName || user?.email?.split("@")[0] || "user"}
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  className="text-white/30 hover:text-tradr-red text-xs transition-colors"
                  title="Logout"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        </aside>

        {/* Mobile sidebar backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* ── MAIN CONTENT ── */}
        <div className={`flex-1 flex flex-col ${isTradePage ? "h-screen overflow-hidden" : "min-h-screen"} lg:pb-9`}>
          {/* Topbar */}
          <header className={`flex items-center justify-between ${isTradePage ? "px-3 py-2" : "px-8 py-4"} border-b border-tradr-green/[0.18] bg-tradr-bg/60 backdrop-blur-sm sticky top-0 z-40`}>
            <div className="flex items-center gap-4">
              <button
                className="lg:hidden text-white/30 hover:text-tradr-green text-lg"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                {sidebarOpen ? "\u2715" : "\u2630"}
              </button>

              {!isTradePage && (
                <div className="text-[10px] text-white/30 tracking-[2px] flex items-center gap-2 font-mono">
                  <span className="text-white/10">//</span>
                  <span>HOME</span>
                  <span className="text-white/10">/</span>
                  <span className="text-tradr-green">{breadcrumbLabel(location.pathname)}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-5">
              <div className="flex items-center gap-1.5 text-[9px] tracking-[2px] font-mono" style={{ color: isHardOffline ? "#ef4444" : sseConnectionState === "reconnecting" || priceStale ? "#f59e0b" : sseConnected ? "var(--theme-primary, #00ff41)" : "#ef4444" }}>
                <span className={`w-[5px] h-[5px] rounded-full animate-blink ${isHardOffline ? "bg-red-500" : sseConnectionState === "reconnecting" || priceStale ? "bg-yellow-500" : sseConnected ? "bg-tradr-green" : "bg-red-500"}`} style={sseConnected && !priceStale && sseConnectionState !== "reconnecting" && !isHardOffline ? { boxShadow: `0 0 6px var(--theme-primary, #00ff41)` } : undefined} />
                {isHardOffline ? "OFFLINE" : sseConnectionState === "reconnecting" || priceStale ? "RECONNECTING..." : sseConnected ? "MARKETS LIVE" : "OFFLINE"}
                {isHardOffline && (
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="ml-1.5 px-1.5 py-0.5 border border-red-500/60 text-red-400 hover:bg-red-500/10 tracking-[2px]"
                  >
                    REFRESH
                  </button>
                )}
              </div>

              <NotificationBell />

              {!tradingAllowed && (
                <div className="text-[9px] tracking-[2px] text-tradr-red flex items-center gap-1.5 font-mono">
                  <span className="w-[5px] h-[5px] bg-tradr-red rounded-full" />
                  BREAKERS
                </div>
              )}

              {user && (
                <div ref={userMenuRef} className="relative z-50 font-mono">
                  <button
                    type="button"
                    onClick={() => setUserMenuOpen((v) => !v)}
                    className="flex items-center gap-2.5 bg-transparent border-0 p-0 cursor-pointer"
                    aria-haspopup="menu"
                    aria-expanded={userMenuOpen}
                  >
                    <span className="text-[9px] text-white/50 tracking-[1px] hover:text-white/80 transition-colors">
                      {user.displayName || user.email?.split("@")[0] || "user"}
                    </span>
                    <span className="text-[9px] text-yellow-400 tracking-[2px] border border-yellow-400/30 px-1.5 py-0.5 bg-yellow-400/[0.06]"
                      style={{ clipPath: "polygon(3px 0%,100% 0%,calc(100% - 3px) 100%,0% 100%)" }}>
                      ★ {userTier}
                    </span>
                    <span className="text-[8px] text-white/30">▾</span>
                  </button>
                  {userMenuOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full mt-1.5 bg-[#080808] border border-[rgba(0,255,65,0.16)] shadow-[0_4px_20px_rgba(0,0,0,0.6)] z-50 min-w-[140px]"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={handleLogout}
                        className="w-full text-left px-3 py-2 text-[10px] tracking-[2px] text-red-400 hover:bg-red-500/10 hover:text-red-300 border-0 bg-transparent cursor-pointer font-mono"
                      >
                        LOGOUT
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </header>

          <main className={`flex-1 ${isTradePage ? "overflow-hidden p-1.5" : "overflow-y-auto p-8"}`}>
            <Outlet />
          </main>
        </div>
      </div>

      {/* Ticker bar — fixed bottom */}
      <TickerBar />
    </div>
  );
}
