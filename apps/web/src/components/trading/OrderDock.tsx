import { useState, useEffect, useRef, type ReactNode } from "react";
import { useTradingStore } from "@/stores/tradingStore";
import OpenOrders from "./OpenOrders";

/**
 * Full-width bottom dock for the trade page. Today it hosts a single
 * "Open Orders" tab; it is deliberately structured as a tab-strip + content
 * switch so sibling tabs (Positions / Order History / Trades) drop in later
 * without a redesign — see docs/designs/2026-05-27-open-orders-panel.md.
 *
 * Behavior:
 *  - 0 open orders → thin strip (header bar only), to not eat chart space.
 *  - orders appear (count 0 → ≥1) → auto-expands, overriding any stored
 *    collapse. Entering the page with open orders must never show a thin dock
 *    that hides them.
 *  - a manual collapse while orders persist is respected (and persisted to
 *    localStorage `tradr_order_dock`) until orders next appear from empty.
 *  - the entire header bar is the toggle target (not just the chevron).
 */

const DOCK_PREF_KEY = "tradr_order_dock";

type DockTabKey = "open";

interface DockTab {
  key: DockTabKey;
  label: string;
  count: number | null;
  render: () => ReactNode;
}

export default function OrderDock() {
  const openOrders = useTradingStore((s) => s.openOrders);
  const orderCount = openOrders.length;

  // Tab seam — append entries here to add Positions / History / Trades later.
  // (Single tab today, so the whole bar toggles the dock rather than switching
  // tabs. When siblings land, give the tab elements their own onClick +
  // stopPropagation so a tab switch doesn't also toggle the dock.)
  const tabs: DockTab[] = [
    { key: "open", label: "Open Orders", count: orderCount, render: () => <OpenOrders /> },
  ];
  const activeTab = tabs[0];

  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(DOCK_PREF_KEY) === "collapsed",
  );
  useEffect(() => {
    localStorage.setItem(DOCK_PREF_KEY, collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  // Auto-expand on the 0 → ≥1 transition (incl. the post-fetch first paint, where
  // openOrders goes [] → [n]). Overrides a stored collapse so arriving with open
  // orders never shows a thin dock. Count changes that don't cross 0 (a manual
  // collapse, or adding to an already-open list) leave `collapsed` untouched.
  const prevCount = useRef(0);
  useEffect(() => {
    if (prevCount.current === 0 && orderCount > 0) setCollapsed(false);
    prevCount.current = orderCount;
  }, [orderCount]);

  const canToggle = orderCount > 0;
  const expanded = canToggle && !collapsed;

  function toggle() {
    if (canToggle) setCollapsed((c) => !c);
  }

  return (
    <div className={`tr-order-dock ${expanded ? "expanded" : "collapsed"}`}>
      <div
        className="tr-dock-bar"
        role="button"
        tabIndex={canToggle ? 0 : -1}
        aria-expanded={expanded}
        aria-disabled={!canToggle}
        aria-label={expanded ? "Collapse open orders" : "Expand open orders"}
        onClick={toggle}
        onKeyDown={(e) => {
          if (canToggle && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <div className="tr-dock-tabs">
          {tabs.map((t) => (
            <span
              key={t.key}
              className={`tr-dock-tab ${t.key === activeTab?.key ? "active" : ""}`}
            >
              {t.label}
              {t.count != null && <span className="tr-dock-count">{t.count}</span>}
            </span>
          ))}
        </div>
        <span className="tr-dock-toggle" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
      </div>
      {expanded && activeTab && <div className="tr-dock-content">{activeTab.render()}</div>}
    </div>
  );
}
