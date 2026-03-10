import { useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";

/* ── Ticker data ── */
const TICKS = [
  { sym: "BTC", price: "$84,220.44", chg: "+2.31%", up: true },
  { sym: "ETH", price: "$3,941.12", chg: "+1.84%", up: true },
  { sym: "SOL", price: "$142.88", chg: "-0.71%", up: false },
  { sym: "BNB", price: "$621.50", chg: "+0.42%", up: true },
  { sym: "AVAX", price: "$38.12", chg: "-1.18%", up: false },
  { sym: "DOGE", price: "$0.1822", chg: "+5.09%", up: true },
  { sym: "ARB", price: "$1.24", chg: "+3.22%", up: true },
  { sym: "OP", price: "$2.88", chg: "-0.55%", up: false },
  { sym: "LINK", price: "$18.40", chg: "+1.10%", up: true },
];

/* ── How-it-works steps ── */
const STEPS = [
  { num: "01", icon: "\u2699", title: "Register", desc: "Create a free account in seconds. No credit card. No identity verification. Just a handle." },
  { num: "02", icon: "\uD83C\uDFDF", title: "Join Arena", desc: "Enter a seasonal competition or free-play mode. $100K virtual capital is loaded automatically." },
  { num: "03", icon: "\uD83D\uDCC8", title: "Trade", desc: "Buy and sell BTC, ETH, and SOL at real-time market prices. Every move counts." },
  { num: "04", icon: "\uD83E\uDD47", title: "Win", desc: "Rank by total return %. Top traders claim glory \u2014 and eventually, real prizes." },
];

/* ── Chart drawing ── */
function drawChart(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.offsetWidth;
  const H = 120;
  canvas.width = W;
  canvas.height = H;

  const pts = 60;
  const data: number[] = [];
  let v = 84000;
  for (let i = 0; i < pts; i++) {
    v += (Math.random() - 0.46) * 400;
    data.push(v);
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const x = (i: number) => (i / (pts - 1)) * W;
  const y = (val: number) => H - ((val - min) / (max - min)) * (H - 20) - 10;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(0,255,65,0.15)");
  grad.addColorStop(1, "rgba(0,255,65,0)");

  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]!));
  for (let i = 1; i < pts; i++) {
    const cpx = (x(i - 1) + x(i)) / 2;
    ctx.bezierCurveTo(cpx, y(data[i - 1]!), cpx, y(data[i]!), x(i), y(data[i]!));
  }
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(x(0), y(data[0]!));
  for (let i = 1; i < pts; i++) {
    const cpx = (x(i - 1) + x(i)) / 2;
    ctx.bezierCurveTo(cpx, y(data[i - 1]!), cpx, y(data[i]!), x(i), y(data[i]!));
  }
  ctx.strokeStyle = "#00ff41";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "#00ff41";
  ctx.shadowBlur = 6;
  ctx.stroke();

  // Dot at end
  ctx.beginPath();
  ctx.arc(x(pts - 1), y(data[pts - 1]!), 4, 0, Math.PI * 2);
  ctx.fillStyle = "#00ff41";
  ctx.shadowBlur = 12;
  ctx.fill();
}

export default function LandingPage() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Custom cursor
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

  // Chart drawing + redraw interval
  useEffect(() => {
    if (canvasRef.current) drawChart(canvasRef.current);
    const interval = setInterval(() => {
      if (canvasRef.current) drawChart(canvasRef.current);
    }, 3000);
    const handleResize = () => {
      if (canvasRef.current) drawChart(canvasRef.current);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  // Duplicate ticks for seamless scroll
  const tickerItems = [...TICKS, ...TICKS];

  return (
    <div className="tradr-cursor min-h-screen bg-tradr-bg font-mono text-white/85 overflow-x-hidden">
      {/* Custom Cursor */}
      <div ref={cursorRef} className="cursor-crosshair hidden lg:block" />
      <div ref={dotRef} className="cursor-dot hidden lg:block" />

      {/* Boot Overlay */}
      <div className="fixed inset-0 bg-black z-[9000] flex flex-col justify-center px-8 md:px-16 font-mono animate-boot-fade pointer-events-none">
        <div className="boot-line text-[11px] text-tradr-green leading-8">TRADR OS v1.0.0 — BOOT SEQUENCE INITIATED</div>
        <div className="boot-line text-[11px] text-tradr-green leading-8">▸ Loading market data engine... <span className="text-white">OK</span></div>
        <div className="boot-line text-[11px] text-tradr-green leading-8">▸ Connecting to price feeds (BTC/ETH/SOL)... <span className="text-white">OK</span></div>
        <div className="boot-line text-[11px] text-tradr-green leading-8">▸ Initializing competition arena... <span className="text-white">OK</span></div>
        <div className="boot-line text-[11px] text-tradr-green leading-8">▸ Authenticating leaderboard nodes... <span className="text-white">OK</span></div>
        <div className="boot-line text-[11px] text-tradr-green leading-8">▸ Mounting trade execution layer...</div>
        <div className="boot-bar mt-3 w-[300px] h-0.5 bg-tradr-green/10 overflow-hidden">
          <div className="h-full bg-tradr-green w-0 animate-bar-fill" />
        </div>
        <div className="boot-line text-[13px] text-white leading-8">{"\u2588"} SYSTEM READY — PAPER TRADING COMPETITION PLATFORM ONLINE</div>
      </div>

      {/* Background Layers */}
      <div className="fixed inset-0 pointer-events-none z-0 grid-bg" />
      <div className="fixed inset-0 pointer-events-none z-0" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 40%, rgba(0,255,65,0.04) 0%, transparent 65%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[1]" style={{ background: "radial-gradient(ellipse 100% 100% at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)" }} />
      <div className="fixed inset-0 pointer-events-none z-[2] scanlines-bg" />
      <div className="fixed inset-0 pointer-events-none z-[2] animate-flicker bg-tradr-green/[0.01]" />

      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-[100] bg-tradr-bg/90 backdrop-blur-xl border-b border-tradr-green/[0.18] flex items-center justify-between px-6 md:px-10 h-[52px]">
        <div className="font-bebas text-[26px] text-white tracking-[4px]">
          TR<span className="text-tradr-green">A</span>DR
        </div>
        <div className="hidden md:flex items-center gap-1.5 text-[9px] text-tradr-green tracking-[3px]">
          <div className="w-1.5 h-1.5 rounded-full bg-tradr-green animate-pulse-dot" />
          SEASON 01 OPEN
        </div>
        <div className="hidden lg:flex gap-8">
          {["Arena", "Leaderboard", "Portfolio", "Markets"].map((l) => (
            <span key={l} className="text-[10px] text-white/30 tracking-[3px] uppercase hover:text-tradr-green transition-colors">
              {l}
            </span>
          ))}
        </div>
        <Link
          to="/login"
          className="text-[10px] text-tradr-green tracking-[3px] uppercase border border-tradr-green/[0.18] px-4 py-1.5 hover:bg-tradr-green/[0.06] hover:border-tradr-green/50 transition-all"
        >
          [ SIGN IN ]
        </Link>
      </nav>

      {/* Hero */}
      <section className="min-h-screen grid grid-cols-1 lg:grid-cols-[1fr_420px] pt-[52px] relative z-10">
        {/* Left Column */}
        <div className="hero-left-hover relative flex flex-col justify-center px-8 md:px-16 lg:px-20 py-20 border-r-0 lg:border-r border-tradr-green/[0.18] hero-border-glow">
          <div className="bracket bracket-tl" />
          <div className="bracket bracket-tr" />
          <div className="bracket bracket-bl" />
          <div className="bracket bracket-br" />

          {/* Season Badge */}
          <div className="animate-fade-up fade-delay-1 inline-flex items-center gap-2 text-[9px] text-tradr-green tracking-[4px] border border-tradr-green/[0.18] px-3.5 py-1.5 mb-10 w-fit">
            <span className="w-1.5 h-1.5 rounded-full bg-tradr-green animate-pulse-dot" />
            SEASON 01 · LAUNCHING NOW · BE THE FIRST
          </div>

          {/* Title */}
          <h1 className="animate-fade-up fade-delay-2 font-bebas text-[clamp(72px,10vw,140px)] leading-[0.88] tracking-tight text-white">
            <span className="glitch" data-text="PAPER">PAPER</span><br />
            TR<span className="text-tradr-green inline-block">A</span>DE.<br />
            <span className="text-white/[0.12]">COMPETE.</span><br />
            <span className="text-tradr-green">WIN.</span>
          </h1>

          {/* Tagline */}
          <div className="animate-fade-up fade-delay-3 text-[11px] text-white/30 tracking-[2px] mt-6 leading-8">
            <span className="text-tradr-green">$100,000</span> VIRTUAL CAPITAL &nbsp;&middot;&nbsp; BTC / ETH / SOL &nbsp;&middot;&nbsp; <span className="text-tradr-green">ZERO RISK</span>
          </div>

          {/* Description */}
          <p className="animate-fade-up fade-delay-4 text-xs text-white/[0.35] leading-8 max-w-[420px] mt-5 italic">
            Real market prices. Cutthroat competition.<br />
            Prove your strategy is the sharpest in the arena.
          </p>

          {/* CTA Buttons */}
          <div className="animate-fade-up fade-delay-5 flex gap-3 mt-12">
            <Link
              to="/register"
              className="btn-sweep btn-skew relative overflow-hidden bg-tradr-green text-black px-11 py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase hover:shadow-[0_0_30px_rgba(0,255,65,0.25)] hover:-translate-y-0.5 transition-all"
            >
              ▸ ENTER ARENA
            </Link>
            <Link
              to="/register"
              className="btn-skew relative overflow-hidden bg-transparent text-tradr-green px-10 py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase border border-tradr-green/[0.18] hover:border-tradr-green/50 hover:bg-tradr-green/[0.06] hover:shadow-[0_0_20px_rgba(0,255,65,0.08)] hover:-translate-y-0.5 transition-all"
            >
              [ CREATE ACCOUNT ]
            </Link>
          </div>

          {/* Stats */}
          <div className="animate-fade-up fade-delay-6 flex gap-0 mt-16 border-t border-tradr-green/[0.18] pt-8">
            <div className="flex-1 pr-8 border-r border-tradr-green/[0.18] mr-8">
              <div className="font-bebas text-[42px] text-white leading-none">$100K</div>
              <div className="text-[9px] text-white/25 tracking-[3px] mt-1 uppercase">Virtual Capital</div>
            </div>
            <div className="flex-1 pr-8 border-r border-tradr-green/[0.18] mr-8">
              <div className="font-bebas text-[42px] text-tradr-green leading-none" style={{ textShadow: "0 0 20px rgba(0,255,65,0.25)" }}>3</div>
              <div className="text-[9px] text-white/25 tracking-[3px] mt-1 uppercase">Assets · BTC ETH SOL</div>
            </div>
            <div className="flex-1">
              <div className="font-bebas text-[42px] text-white leading-none">FREE</div>
              <div className="text-[9px] text-white/25 tracking-[3px] mt-1 uppercase">No Credit Card Ever</div>
            </div>
          </div>

          {/* Scroll Cue */}
          <div className="animate-fade-up fade-delay-7 absolute bottom-16 left-8 md:left-16 lg:left-20 flex items-center gap-2.5 text-[9px] text-white/20 tracking-[3px]">
            <div className="relative w-10 h-px bg-white/10 overflow-hidden scroll-line-anim" />
            SCROLL TO EXPLORE
          </div>
        </div>

        {/* Right Column */}
        <div className="flex flex-col justify-center px-6 lg:px-10 py-10 lg:py-16 gap-4">
          {/* Chart Card */}
          <div className="animate-fade-up fade-delay-5 card-glow relative bg-tradr-bg2 border border-tradr-green/[0.18]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <span className="text-[9px] text-white/30 tracking-[3px] uppercase">BTC / USDT · 1H</span>
              <span className="text-[8px] text-tradr-green tracking-[2px] flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-tradr-green animate-pulse-dot" />
                LIVE FEED
              </span>
            </div>
            <canvas ref={canvasRef} className="block w-full" height={120} />
            <div className="flex justify-between px-4 py-2 border-t border-white/[0.06]">
              <span className="text-[9px] text-white/30">$84,220.44</span>
              <span className="text-[9px] text-tradr-green">▲ +2.31% (24h)</span>
            </div>
          </div>

          {/* Leaderboard Card */}
          <div className="animate-fade-up fade-delay-5 card-glow relative bg-tradr-bg2 border border-tradr-green/[0.18]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <span className="text-[9px] text-white/30 tracking-[3px] uppercase">ARENA LEADERBOARD · SEASON 01</span>
              <span className="text-[9px] text-white/30 tracking-[2px]">0 TRADERS</span>
            </div>

            {/* Rank #1 — Open Slot */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] border-l-2 border-l-tradr-green animate-pulse-row">
              <span className="font-bebas text-xl text-[#ffd700] w-6 text-center flex-shrink-0" style={{ textShadow: "0 0 10px rgba(255,215,0,0.5)" }}>1</span>
              <div className="avatar-clip w-7 h-7 flex-shrink-0 border border-dashed border-tradr-green flex items-center justify-center text-sm text-tradr-green/50 animate-dashed-pulse">
                ?
              </div>
              <div className="flex-1">
                <div className="text-[10px] text-tradr-green tracking-[2px] font-bold">UNCLAIMED</div>
                <div className="text-[8px] text-tradr-green/40 tracking-[1px] mt-0.5">THIS COULD BE YOU</div>
              </div>
              <span className="font-bebas text-lg text-tradr-green/25">---%</span>
            </div>

            {/* Ghost Rows 2–5 */}
            {[2, 3, 4, 5].map((rank, i) => (
              <div
                key={rank}
                className={`flex items-center gap-3 px-4 py-2.5 opacity-35 ${rank < 5 ? "border-b border-white/[0.06]" : ""}`}
              >
                <span className="font-bebas text-xl text-white/[0.12] w-6 text-center flex-shrink-0">{rank}</span>
                <div className="avatar-clip w-7 h-7 flex-shrink-0 bg-white/[0.04]" />
                <div className="flex-1 h-2 bg-white/[0.06] rounded-sm" style={{ width: [100, 80, 60, 90][i] }} />
                <div className="w-[60px] h-[3px] bg-white/[0.05] overflow-hidden">
                  <div className="h-full bg-tradr-green" style={{ width: "0%" }} />
                </div>
                <span className="font-bebas text-lg text-white/[0.08]">---%</span>
              </div>
            ))}

            {/* Footer */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06]">
              <span className="text-[9px] text-white/[0.15] tracking-[1px]">Season starts when you do.</span>
              <Link to="/register" className="text-[9px] text-tradr-green tracking-[2px] hover:text-tradr-green/80 transition-colors">
                ▸ CLAIM #1
              </Link>
            </div>
          </div>

          {/* Mini Stats */}
          <div className="animate-fade-up fade-delay-5 card-glow relative bg-tradr-bg2 border border-tradr-green/[0.18] overflow-hidden p-0">
            <div className="grid grid-cols-2 gap-px bg-tradr-green/[0.18]">
              <div className="bg-tradr-bg2 px-4 py-3.5">
                <div className="font-bebas text-2xl text-tradr-green leading-none" style={{ textShadow: "0 0 12px rgba(0,255,65,0.25)" }}>LIVE</div>
                <div className="text-[8px] text-white/20 tracking-[2px] mt-1">Real Market Prices</div>
              </div>
              <div className="bg-tradr-bg2 px-4 py-3.5">
                <div className="font-bebas text-2xl text-tradr-green leading-none" style={{ textShadow: "0 0 12px rgba(0,255,65,0.25)" }}>FREE</div>
                <div className="text-[8px] text-white/20 tracking-[2px] mt-1">No Credit Card</div>
              </div>
              <div className="col-span-2 bg-tradr-bg2">
                <div className="flex items-center gap-2.5 border border-tradr-green/[0.18] px-4 py-3 m-px focus-within:border-tradr-green/50 focus-within:shadow-[0_0_20px_rgba(0,255,65,0.05)] transition-all">
                  <span className="text-xs text-tradr-green flex-shrink-0">tradr@arena:~$</span>
                  <input
                    type="text"
                    placeholder="enter your handle to begin..."
                    className="bg-transparent border-none outline-none font-mono text-[11px] text-white flex-1 tracking-[1px] placeholder:text-white/20"
                  />
                  <div className="w-[7px] h-3.5 bg-tradr-green animate-blink flex-shrink-0" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="px-8 md:px-16 lg:px-20 pt-24 pb-20 relative z-10 border-t border-tradr-green/[0.18]">
        <div className="text-[9px] text-tradr-green tracking-[6px] uppercase mb-12 flex items-center gap-4">
          HOW IT WORKS
          <span className="flex-1 h-px bg-tradr-green/[0.18]" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-px bg-tradr-green/[0.18]">
          {STEPS.map((step) => (
            <div key={step.num} className="bg-tradr-bg2 px-6 py-8 relative hover:bg-tradr-green/[0.06] transition-colors">
              <div className="font-bebas text-[72px] text-tradr-green/[0.07] leading-none absolute top-4 right-4">{step.num}</div>
              <div className="text-2xl mb-5">{step.icon}</div>
              <div className="text-[13px] font-bold text-white tracking-[2px] mb-2.5 uppercase">{step.title}</div>
              <div className="text-[10px] text-white/30 leading-[1.9]">{step.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer CTA */}
      <div className="px-8 md:px-16 lg:px-20 py-20 flex flex-col lg:flex-row items-start lg:items-center justify-between border-t border-tradr-green/[0.18] relative z-10 gap-10">
        <div className="font-bebas text-[clamp(32px,4vw,56px)] text-white leading-none">
          RANK #1 IS<br /><span className="text-tradr-green">STILL UNCLAIMED.</span>
        </div>
        <div className="flex gap-3 flex-shrink-0">
          <Link
            to="/register"
            className="btn-sweep btn-skew relative overflow-hidden bg-tradr-green text-black px-11 py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase hover:shadow-[0_0_30px_rgba(0,255,65,0.25)] hover:-translate-y-0.5 transition-all"
          >
            ▸ CLAIM IT NOW
          </Link>
          <Link
            to="/login"
            className="btn-skew relative overflow-hidden bg-transparent text-tradr-green px-10 py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase border border-tradr-green/[0.18] hover:border-tradr-green/50 hover:bg-tradr-green/[0.06] hover:shadow-[0_0_20px_rgba(0,255,65,0.08)] hover:-translate-y-0.5 transition-all"
          >
            [ VIEW ARENA ]
          </Link>
        </div>
      </div>

      {/* Footer Bottom */}
      <div className="px-8 md:px-16 lg:px-20 py-5 pb-14 border-t border-white/[0.06] flex flex-col md:flex-row justify-between items-center relative z-10 gap-4">
        <div className="text-[9px] text-white/[0.15] tracking-[2px]">
          © 2026 TRADR · PAPER TRADING COMPETITION PLATFORM · ALL RIGHTS RESERVED
        </div>
        <div className="flex gap-6 text-[9px] text-white/20 tracking-[2px]">
          <span>Terms</span>
          <span>Privacy</span>
          <span>Contact</span>
        </div>
      </div>

      {/* Ticker Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-[100] bg-tradr-bg/95 border-t border-tradr-green/[0.18] h-9 flex items-center overflow-hidden">
        <div className="flex-shrink-0 px-4 h-full flex items-center bg-tradr-green text-[9px] font-bold text-black tracking-[3px] whitespace-nowrap">
          LIVE
        </div>
        <div className="overflow-hidden flex-1">
          <div className="flex gap-12 whitespace-nowrap animate-ticker-scroll text-[10px]">
            {tickerItems.map((t, i) => (
              <span key={i} className="flex items-center gap-2">
                <span className="text-white/30 tracking-[2px]">{t.sym}</span>
                <span className="text-white">{t.price}</span>
                <span className={t.up ? "text-tradr-green" : "text-tradr-red"}>
                  {t.up ? "▲" : "▼"} {t.chg}
                </span>
                <span className="text-white/[0.08] ml-4">|</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
