import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { checkHandle } from "@/api/endpoints/landing";
import { HANDLE_RE } from "@/lib/landing";

const DEBOUNCE_MS = 350;

type Status = "idle" | "checking" | "available" | "taken" | "invalid" | "unknown";

const MESSAGES: Record<Exclude<Status, "idle" | "checking">, string> = {
  available: "Available.",
  taken: "Taken — try another.",
  invalid: "3–30 characters: letters, numbers, underscore.",
  unknown: "Couldn't check right now — you can still continue.",
};

interface Props {
  /** Set after a quick-call win: the label becomes a prompt to save the streak. */
  saveStreak: number | null;
}

export default function HandleForm({ saveStreak }: Props) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const latest = useRef("");
  const results = useRef(new Map<string, Exclude<Status, "idle" | "checking">>());

  async function lookup(handle: string): Promise<Exclude<Status, "idle" | "checking">> {
    const cached = results.current.get(handle.toLowerCase());
    if (cached) return cached;
    try {
      const { data } = await checkHandle(handle);
      const result = data.available ? "available" : data.reason;
      results.current.set(handle.toLowerCase(), result);
      return result;
    } catch {
      return "unknown";
    }
  }

  useEffect(() => {
    const handle = value.trim();
    latest.current = handle;
    if (!handle) return setStatus("idle");
    if (!HANDLE_RE.test(handle)) return setStatus("invalid");
    setStatus("checking");
    const t = setTimeout(async () => {
      const result = await lookup(handle);
      if (latest.current === handle) setStatus(result);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const handle = value.trim();
    if (!HANDLE_RE.test(handle)) return setStatus("invalid");
    setStatus("checking");
    const result = await lookup(handle);
    setStatus(result);
    if (result === "available" || result === "unknown") {
      navigate(`/register?handle=${encodeURIComponent(handle)}`);
    }
  }

  const highlight = saveStreak !== null && saveStreak > 0;
  const label = highlight
    ? `SAVE YOUR ${saveStreak}-CALL STREAK · PICK A HANDLE`
    : "CLAIM YOUR HANDLE";
  const message = status === "idle" || status === "checking" ? "" : MESSAGES[status];

  return (
    <form onSubmit={onSubmit} className="mt-10 max-w-xl" noValidate>
      <label
        htmlFor="lp-handle"
        className={`block text-[11px] tracking-[3px] mb-2 ${highlight ? "text-black bg-lp-accent px-2 py-1 w-fit" : "text-lp-muted"}`}
      >
        {label}
      </label>
      <div
        className={`flex items-stretch border ${highlight ? "border-lp-accent" : "border-white/20"} focus-within:border-lp-accent bg-black`}
      >
        <span className="hidden sm:flex items-center pl-3 pr-1 text-[13px] text-lp-accent select-none" aria-hidden="true">
          tradr@arena:~$
        </span>
        <input
          id="lp-handle"
          name="handle"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby="lp-handle-status"
          aria-invalid={status === "invalid" || status === "taken"}
          placeholder="your_handle"
          className="flex-1 min-w-0 bg-transparent px-3 py-3 text-[15px] text-white placeholder:text-white/50 outline-none font-mono"
        />
        <button
          type="submit"
          className="px-5 bg-lp-accent text-black text-[13px] font-bold tracking-[3px] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lp-accent"
        >
          ENTER
        </button>
      </div>
      <p
        id="lp-handle-status"
        aria-live="polite"
        className={`mt-2 min-h-5 text-[12px] ${status === "available" ? "text-lp-accent" : status === "taken" || status === "invalid" ? "text-lp-down" : "text-lp-muted"}`}
      >
        {message}
      </p>
    </form>
  );
}
