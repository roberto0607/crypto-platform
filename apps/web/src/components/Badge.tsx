import { type ReactNode } from "react";

type BadgeColor = "green" | "yellow" | "red" | "gray" | "blue";

const COLOR_CLASSES: Record<BadgeColor, string> = {
  green: "bg-green-900/50 text-green-400 border-green-800",
  yellow: "bg-yellow-900/50 text-yellow-400 border-yellow-800",
  red: "bg-red-900/50 text-red-400 border-red-800",
  gray: "bg-gray-800 text-gray-400 border-gray-700",
  blue: "bg-blue-900/50 text-blue-400 border-blue-800",
};

interface BadgeProps {
  color?: BadgeColor;
  children: ReactNode;
}

export default function Badge({ color = "gray", children }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${COLOR_CLASSES[color]}`}
    >
      {children}
    </span>
  );
}
