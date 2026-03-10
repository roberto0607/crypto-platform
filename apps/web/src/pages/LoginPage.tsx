import { useState, useRef, useEffect, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AxiosError } from "axios";
import { useAuthStore } from "@/stores/authStore";
import { login } from "@/api/endpoints/auth";
import { normalizeApiError } from "@/lib/errors";
import type { LegacyApiError, V1ApiError } from "@/types/api";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [terminalText, setTerminalText] = useState("tradr@auth:~$ awaiting credentials_");
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Invalid email address");
      setTerminalText("tradr@auth:~$ ERROR: invalid email address_");
      return;
    }
    if (!password) {
      setError("Password is required");
      setTerminalText("tradr@auth:~$ ERROR: password required_");
      return;
    }

    setSubmitting(true);
    setTerminalText("tradr@auth:~$ authenticating..._");

    try {
      const res = await login(email, password);
      setTerminalText("tradr@auth:~$ ACCESS GRANTED \u2014 redirecting to arena_");
      setAuth(res.data.accessToken, res.data.user);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      const { message } = normalizeApiError(
        err as AxiosError<LegacyApiError | V1ApiError>,
      );
      setError(message);
      setTerminalText(`tradr@auth:~$ ERROR: ${message}_`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-reveal grid grid-cols-1 lg:grid-cols-[320px_1fr] w-full max-w-[900px] min-h-[480px] border border-tradr-green/[0.18] relative login-glow-line">

      {/* ── Left Branding Panel ── */}
      <div className="hidden lg:flex flex-col justify-between bg-tradr-green/[0.06] border-r border-tradr-green/[0.18] px-9 py-12 relative overflow-hidden login-stripes">
        <div className="auth-bracket auth-bracket-tl" />
        <div className="auth-bracket auth-bracket-bl" />

        <div className="relative z-[1]">
          <div className="text-[9px] text-tradr-green tracking-[5px] uppercase mb-7 flex items-center gap-2">
            <span>&#x25B8;</span> ACCESS TERMINAL
          </div>
          <div className="font-bebas text-[72px] leading-[0.88] tracking-tight text-white">
            TR<span className="text-tradr-green">A</span>DR<br />
            <span className="text-white/[0.15]">ARENA</span>
          </div>
          <div className="text-[10px] text-white/30 tracking-[2px] mt-5 leading-8">
            PAPER TRADE.<br />
            COMPETE.<br />
            WIN.
          </div>
        </div>

        <div className="relative z-[1] flex flex-col gap-4">
          {[
            { label: "Starting Capital", val: "$100K", green: true },
            { label: "Assets", val: "BTC \u00B7 ETH \u00B7 SOL", green: false },
            { label: "Rank #1", val: "UNCLAIMED", green: true, small: true },
          ].map((s) => (
            <div key={s.label} className="flex items-center justify-between py-2.5 border-b border-tradr-green/[0.08] last:border-b-0">
              <span className="text-[9px] text-white/25 tracking-[2px]">{s.label}</span>
              <span className={`font-bebas ${s.small ? "text-sm tracking-[1px]" : "text-xl"} ${s.green ? "text-tradr-green" : "text-white/60"}`}>
                {s.val}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right Form Panel ── */}
      <div className="bg-tradr-bg2 px-8 md:px-12 py-12 flex flex-col justify-center relative">
        <div className="auth-bracket auth-bracket-tr hidden lg:block" />
        <div className="auth-bracket auth-bracket-br hidden lg:block" />

        {/* Header */}
        <div className="mb-10">
          <h1 className="font-bebas text-4xl text-white tracking-[2px] leading-none">
            SIGN <span className="text-tradr-green">IN</span>
          </h1>
          <p className="text-[10px] text-white/30 tracking-[2px] mt-2 leading-[1.8]">
            AUTHENTICATE TO ENTER THE ARENA
          </p>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="mb-5 px-4 py-3 border border-tradr-red/50 bg-tradr-red/[0.08] text-[10px] text-tradr-red tracking-[2px]">
            &#x25B8; {error.toUpperCase()}
          </div>
        )}

        <form onSubmit={handleSubmit} autoComplete="on">
          {/* Email Field */}
          <div className="mb-5">
            <label htmlFor="email" className="block text-[9px] text-white/30 tracking-[4px] uppercase mb-2">
              Email Address
            </label>
            <div className={`field-clip flex items-center border ${error && !email ? "border-tradr-red/50" : "border-tradr-green/[0.18]"} bg-black/40 focus-within:border-tradr-green/50 focus-within:shadow-[0_0_0_1px_rgba(0,255,65,0.1),0_0_20px_rgba(0,255,65,0.06)] transition-all`}>
              <span className="text-[11px] text-tradr-green/60 px-3 flex-shrink-0 border-r border-tradr-green/[0.18] h-11 flex items-center">@</span>
              <input
                ref={emailRef}
                id="email"
                type="email"
                autoComplete="email"
                placeholder="trader@domain.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(null); setTerminalText("tradr@auth:~$ awaiting credentials_"); }}
                onFocus={() => setTerminalText("tradr@auth:~$ input: email_")}
                onBlur={() => setTerminalText("tradr@auth:~$ awaiting credentials_")}
                className="flex-1 bg-transparent border-none outline-none font-mono text-[11px] text-white px-3.5 h-11 tracking-[1px] placeholder:text-white/[0.18]"
              />
            </div>
          </div>

          {/* Password Field */}
          <div className="mb-5">
            <label htmlFor="password" className="block text-[9px] text-white/30 tracking-[4px] uppercase mb-2">
              Password
            </label>
            <div className={`field-clip flex items-center border ${error && !password ? "border-tradr-red/50" : "border-tradr-green/[0.18]"} bg-black/40 focus-within:border-tradr-green/50 focus-within:shadow-[0_0_0_1px_rgba(0,255,65,0.1),0_0_20px_rgba(0,255,65,0.06)] transition-all`}>
              <span className="text-[11px] text-tradr-green/60 px-3 flex-shrink-0 border-r border-tradr-green/[0.18] h-11 flex items-center">#</span>
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); setTerminalText("tradr@auth:~$ awaiting credentials_"); }}
                onFocus={() => setTerminalText("tradr@auth:~$ input: password_")}
                onBlur={() => setTerminalText("tradr@auth:~$ awaiting credentials_")}
                className="flex-1 bg-transparent border-none outline-none font-mono text-[11px] text-white px-3.5 h-11 tracking-[1px] placeholder:text-white/[0.18]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="px-3.5 text-[9px] text-white/20 tracking-[1px] flex-shrink-0 hover:text-tradr-green transition-colors select-none"
              >
                {showPassword ? "HIDE" : "SHOW"}
              </button>
            </div>
          </div>

          {/* Forgot Password row */}
          <div className="flex items-center justify-end mb-7 -mt-1">
            <span className="text-[9px] text-tradr-green tracking-[2px] hover:opacity-60 transition-opacity">
              FORGOT PASSWORD &rarr;
            </span>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={submitting}
            className={`btn-sweep btn-skew relative overflow-hidden w-full bg-tradr-green text-black py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase border-none transition-all hover:shadow-[0_0_30px_rgba(0,255,65,0.25)] hover:-translate-y-px active:translate-y-0 ${submitting ? "auth-btn-loading" : ""}`}
          >
            &#x25B8; ACCESS ARENA
          </button>
        </form>

        {/* Divider */}
        <div className="flex items-center gap-3 my-6 text-[9px] text-white/[0.15] tracking-[3px]">
          <span className="flex-1 h-px bg-white/[0.06]" />
          OR
          <span className="flex-1 h-px bg-white/[0.06]" />
        </div>

        {/* Register Link */}
        <div className="flex items-center justify-between pt-6 border-t border-white/[0.06]">
          <span className="text-[9px] text-white/20 tracking-[2px]">NO ACCOUNT YET?</span>
          <Link
            to="/register"
            className="text-[9px] text-tradr-green tracking-[2px] uppercase hover:opacity-70 transition-opacity flex items-center gap-1.5"
          >
            CREATE ONE FREE &rarr;
          </Link>
        </div>

        {/* Terminal Status */}
        <div className="absolute bottom-12 left-8 md:left-12 right-8 md:right-12 text-[9px] text-tradr-green/30 tracking-[2px] flex items-center gap-2 border-t border-tradr-green/[0.06] pt-3">
          <span className="animate-blink">{"\u2588"}</span>
          <span>{terminalText}</span>
        </div>
      </div>
    </div>
  );
}
