import { useEffect, useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AxiosError } from "axios";
import { verifyEmail } from "@/api/endpoints/auth";
import { normalizeApiError } from "@/lib/errors";
import type { LegacyApiError, V1ApiError } from "@/types/api";
import Spinner from "@/components/Spinner";

type Status = "verifying" | "success" | "error";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<Status>("verifying");
  const [message, setMessage] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return; // guard StrictMode double-invoke — token is single-use
    ranRef.current = true;

    if (!token) {
      setStatus("error");
      setMessage("No verification token provided.");
      return;
    }

    verifyEmail(token)
      .then(() => setStatus("success"))
      .catch((err) => {
        const { message } = normalizeApiError(err as AxiosError<LegacyApiError | V1ApiError>);
        setStatus("error");
        setMessage(message);
      });
  }, [token]);

  return (
    <div className="auth-reveal w-full max-w-[440px] border border-tradr-green/[0.18] relative login-glow-line bg-tradr-bg2 px-8 md:px-12 py-12 flex flex-col items-center text-center">
      <div className="auth-bracket auth-bracket-tr hidden lg:block" />
      <div className="auth-bracket auth-bracket-br hidden lg:block" />

      <h1 className="font-bebas text-4xl text-white tracking-[2px] leading-none mb-8">
        EMAIL <span className="text-tradr-green">VERIFICATION</span>
      </h1>

      {status === "verifying" && (
        <>
          <Spinner size="lg" className="text-tradr-green mb-5" />
          <p className="text-[10px] text-white/30 tracking-[2px]">VERIFYING YOUR EMAIL...</p>
        </>
      )}

      {status === "success" && (
        <>
          <div className="mb-5 px-4 py-3 border border-tradr-green/50 bg-tradr-green/[0.08] text-[10px] text-tradr-green tracking-[2px] w-full">
            &#x25B8; EMAIL VERIFIED
          </div>
          <p className="text-[10px] text-white/40 tracking-[1px] leading-[1.8] mb-7">
            Your email has been verified. You can now use all platform features.
          </p>
          <Link
            to="/trade"
            className="btn-sweep btn-skew relative overflow-hidden w-full text-center bg-tradr-green text-black py-4 font-mono text-[11px] font-bold tracking-[4px] uppercase border-none transition-all hover:shadow-[0_0_30px_rgba(0,255,65,0.25)] hover:-translate-y-px active:translate-y-0"
          >
            &#x25B8; ENTER ARENA
          </Link>
        </>
      )}

      {status === "error" && (
        <>
          <div className="mb-6 px-4 py-3 border border-tradr-red/50 bg-tradr-red/[0.08] text-[10px] text-tradr-red tracking-[2px] w-full">
            &#x25B8; {message?.toUpperCase()}
          </div>
          <Link
            to="/login"
            className="text-[9px] text-tradr-green tracking-[2px] uppercase hover:opacity-70 transition-opacity"
          >
            BACK TO LOGIN &rarr;
          </Link>
        </>
      )}
    </div>
  );
}
