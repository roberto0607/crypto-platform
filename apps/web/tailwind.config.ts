import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        bebas: ['"Bebas Neue"', "sans-serif"],
        mono: ['"Space Mono"', "monospace"],
      },
      colors: {
        tradr: {
          green: "#00ff41",
          red: "#ff3b3b",
          bg: "#040404",
          bg2: "#070707",
        },
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%, 100%": {
            opacity: "1",
            boxShadow: "0 0 0 0 rgba(0,255,65,0.25)",
          },
          "50%": { opacity: "0.6", boxShadow: "0 0 0 4px transparent" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        "ticker-scroll": {
          from: { transform: "translateX(0)" },
          to: { transform: "translateX(-50%)" },
        },
        "boot-fade": {
          to: { opacity: "0", visibility: "hidden" as string },
        },
        "bar-fill": {
          to: { width: "100%" },
        },
        flicker: {
          "0%, 100%": { opacity: "0" },
          "92%": { opacity: "0" },
          "92.5%": { opacity: "1" },
          "93%": { opacity: "0" },
          "96%": { opacity: "0" },
          "96.2%": { opacity: "1" },
          "96.4%": { opacity: "0" },
        },
        "pulse-row": {
          "0%, 100%": { backgroundColor: "rgba(0,255,65,0.04)" },
          "50%": { backgroundColor: "rgba(0,255,65,0.08)" },
        },
        "dashed-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        "scroll-line": {
          "0%": { left: "-100%" },
          "100%": { left: "100%" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.6s ease both",
        "pulse-dot": "pulse-dot 1.5s ease-in-out infinite",
        blink: "blink 1s step-end infinite",
        "ticker-scroll": "ticker-scroll 24s linear infinite",
        "boot-fade": "boot-fade 0.4s ease 2.6s forwards",
        "bar-fill": "bar-fill 0.8s ease 1.2s forwards",
        flicker: "flicker 8s step-end infinite",
        "pulse-row": "pulse-row 2.5s ease-in-out infinite",
        "dashed-pulse": "dashed-pulse 1.5s step-end infinite",
        "scroll-line": "scroll-line 2s ease-in-out 3.5s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
