import { useState } from "react";
import { useAuthStore } from "@/stores/authStore";

/** Copies /challenge/<your username>, which opens a challenge against you. */
export function CopyInviteLink() {
    const username = useAuthStore((s) => s.user?.displayName);
    const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
    if (!username) return null;

    const link = `${window.location.origin}/challenge/${encodeURIComponent(username)}`;

    async function copy() {
        try {
            await navigator.clipboard.writeText(link);
            setState("copied");
        } catch {
            setState("failed");
        }
    }

    return (
        <div style={{ marginTop: 8, fontSize: 9, letterSpacing: 2 }}>
            <button
                type="button"
                onClick={copy}
                style={{
                    background: "transparent",
                    border: "1px solid rgba(255,107,0,0.5)",
                    color: "#FF6B00",
                    padding: "4px 10px",
                    fontFamily: "inherit",
                    fontSize: 9,
                    letterSpacing: 2,
                    cursor: "pointer",
                }}
            >
                {state === "copied" ? "COPIED!" : "COPY INVITE LINK"}
            </button>
            {state === "failed" && <span style={{ marginLeft: 8, color: "rgba(255,255,255,0.5)" }}>{link}</span>}
        </div>
    );
}
