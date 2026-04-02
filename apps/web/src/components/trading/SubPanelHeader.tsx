import { type ReactNode } from "react";

interface SubPanelHeaderProps {
    collapsed: boolean;
    onToggle: () => void;
    label: string;
    rightContent?: ReactNode;
}

export function SubPanelHeader({ collapsed, onToggle, label, rightContent }: SubPanelHeaderProps) {
    return (
        <div
            onClick={onToggle}
            style={{
                height: 20, display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "0 8px", cursor: "pointer", userSelect: "none",
                borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(10,10,10,0.95)",
                position: "relative", zIndex: 5,
            }}
        >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 8, color: "rgba(255,255,255,0.3)", transition: "transform 0.15s", transform: collapsed ? "rotate(-90deg)" : "rotate(0)" }}>
                    ▼
                </span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: 2 }}>
                    {label}
                </span>
            </div>
            {rightContent && (
                <div style={{ fontSize: 9 }}>{rightContent}</div>
            )}
        </div>
    );
}
