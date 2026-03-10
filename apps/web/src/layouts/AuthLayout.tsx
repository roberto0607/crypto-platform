import { useEffect, useRef, useCallback } from "react";
import { Outlet, Link } from "react-router-dom";
import SystemBanner from "@/components/SystemBanner";

const TICKS = [
  { sym: "BTC", price: "$84,220.44", chg: "+2.31%", up: true },
  { sym: "ETH", price: "$3,941.12", chg: "+1.84%", up: true },
  { sym: "SOL", price: "$142.88", chg: "-0.71%", up: false },
  { sym: "BNB", price: "$621.50", chg: "+0.42%", up: true },
  { sym: "AVAX", price: "$38.12", chg: "-1.18%", up: false },
  { sym: "DOGE", price: "$0.1822", chg: "+5.09%", up: true },
  { sym: "ARB", price: "$1.24", chg: "+3.22%", up: true },
  { sym: "LINK", price: "$18.40", chg: "+1.10%", up: true },
];

export default function AuthLayout() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (cursorRef.current) {
      cursorRef.current.style.left = `${e.clientX}px`;
      cursorRef.current.style.top = `${e.clientY}px`;
    }
    if (dotRef.current) {
      dotRef.current.style.left = `${e.clientX}px`;
      dotRef.current.style.top = `${e.clientY}px`;
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    return () => document.removeEventListener("mousemove", handleMouseMove);
  }, [handleMouseMove]);

  const tickerItems = [...TICKS, ...TICKS];

  return (
    <div className="tradr-cursor h-screen flex flex-col bg-tradr-bg font-mono text-white/85 overflow-hidden">
      <SystemBanner />

      {/* Custom Cursor */}
      <div ref={cursorRef} className="cursor-crosshair hidden lg:block" />
      <div ref={dotRef} className="cursor-dot hidden lg:block" />

      {/* Background Layers */}
      <div className="fixed inset-0 pointer-events-none z-0 grid-bg" />
      <div className="fixed inset-0 pointer-events-none z-0" style={{ background: "radial-gradient(ellipse 60% 70% at 50% 50%, rgba(0,255,65,0.05) 0%, transparent 65%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[1]" style={{ background: "radial-gradient(ellipse 100% 100% at 50% 50%, transparent 30%, rgba(0,0,0,0.85) 100%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[2] scanlines-bg" />
      <div className="fixed inset-0 pointer-events-none z-[2] animate-flicker bg-tradr-green/[0.01]" />

      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-[100] bg-tradr-bg/90 backdrop-blur-xl border-b border-tradr-green/[0.18] flex items-center justify-between px-6 md:px-10 h-[52px] flex-shrink-0">
        <Link to="/" className="font-bebas text-[26px] text-white tracking-[4px] no-underline">
          TR<span className="text-tradr-green">A</span>DR
        </Link>
        <div className="hidden md:flex items-center gap-1.5 text-[9px] text-tradr-green tracking-[3px]">
          <div className="w-1.5 h-1.5 rounded-full bg-tradr-green animate-pulse-dot" />
          SEASON 01 OPEN
        </div>
        <Link to="/" className="text-[10px] text-white/30 tracking-[3px] uppercase hover:text-tradr-green transition-colors flex items-center gap-2">
          <span>&larr;</span> BACK TO HOME
        </Link>
      </nav>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center relative z-10 pt-[52px] pb-[32px] px-5">
        <Outlet />
      </div>

      {/* Ticker Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-[100] bg-tradr-bg/95 border-t border-tradr-green/[0.18] h-8 flex items-center overflow-hidden">
        <div className="flex-shrink-0 px-3.5 h-full flex items-center bg-tradr-green text-[9px] font-bold text-black tracking-[3px] whitespace-nowrap">
          LIVE
        </div>
        <div className="overflow-hidden flex-1">
          <div className="flex gap-12 whitespace-nowrap animate-ticker-scroll text-[9px]">
            {tickerItems.map((t, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className="text-white/30 tracking-[2px]">{t.sym}</span>
                <span className="text-white/70">{t.price}</span>
                <span className={t.up ? "text-tradr-green" : "text-tradr-red"}>
                  {t.up ? "\u25B2" : "\u25BC"} {t.chg}
                </span>
                <span className="text-white/[0.06] ml-4">|</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
