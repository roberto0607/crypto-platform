import { type ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
}

export default function Card({ children, className = "" }: CardProps) {
  return (
    <div
      className={`rounded-lg border border-gray-800 bg-gray-900 p-4 ${className}`}
    >
      {children}
    </div>
  );
}
