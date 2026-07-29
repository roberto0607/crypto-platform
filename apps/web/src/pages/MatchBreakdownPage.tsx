import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getMatchBreakdown, type MatchBreakdown, type BreakdownOrder } from "@/api/endpoints/matchBreakdown";

const CHAL = "#FF6B00"; // challenger (war-theme orange)
const OPP = "#22D3EE"; // opponent (cyan)

type ErrCode = "match_not_ended" | "forbidden" | "match_not_found" | "error";

function errorMessage(code: ErrCode): { title: string; detail: string } {
    switch (code) {
        case "match_not_ended":
            return { title: "NOT AVAILABLE YET", detail: "The trade breakdown unlocks once this match has ended." };
        case "forbidden":
            return { title: "ACCESS DENIED", detail: "Only the two players can view this match's breakdown." };
        case "match_not_found":
            return { title: "MATCH NOT FOUND", detail: "This match does not exist." };
        default:
            return { title: "BREAKDOWN UNAVAILABLE", detail: "Something went wrong loading this breakdown." };
    }
}

function formatQty(q: string): string {
    const n = parseFloat(q);
    return Number.isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, "") || "0" : q;
}

function formatPrice(p: string | null): string {
    if (p == null) return "--";
    const n = parseFloat(p);
    return Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : "--";
}

function formatTime(t: string | null): string {
    if (!t) return "--";
    return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function OrdersTable({ orders, color }: { orders: BreakdownOrder[]; color: string }) {
    if (orders.length === 0) {
        return <div className="mb-empty-col">NO TRADES</div>;
    }
    return (
        <table className="mb-table">
            <thead>
                <tr>
                    <th>PAIR</th>
                    <th>SIDE</th>
                    <th>QTY</th>
                    <th>AVG FILL</th>
                    <th>STATUS</th>
                    <th>TIME</th>
                </tr>
            </thead>
            <tbody>
                {orders.map((o) => (
                    <tr key={o.orderId}>
                        <td>{o.pairSymbol}</td>
                        <td style={{ color: o.side === "BUY" ? "#16a34a" : "#dc2626", fontWeight: 700 }}>{o.side}</td>
                        <td>{formatQty(o.qtyFilled)}</td>
                        <td>{formatPrice(o.avgFillPrice)}</td>
                        <td style={{ color }}>{o.status}</td>
                        <td>{formatTime(o.lastFillAt ?? o.placedAt)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export default function MatchBreakdownPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [data, setData] = useState<MatchBreakdown | null>(null);
    const [err, setErr] = useState<ErrCode | null>(null);

    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        getMatchBreakdown(id)
            .then((res) => {
                if (cancelled) return;
                setData(res.data);
            })
            .catch((e) => {
                if (cancelled) return;
                const code = e?.response?.data?.error as ErrCode | undefined;
                const status = e?.response?.status;
                setErr(code ?? (status === 403 ? "forbidden" : status === 404 ? "match_not_found" : "error"));
            });
        return () => { cancelled = true; };
    }, [id]);

    if (err) {
        const m = errorMessage(err);
        return (
            <div className="mb-wrap">
                <BreakdownStyles />
                <div className="mb-empty">
                    <div className="mb-empty-title">{m.title}</div>
                    <div className="mb-empty-detail">{m.detail}</div>
                    <button className="mb-btn" onClick={() => navigate("/arena")}>← BACK TO ARENA</button>
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="mb-wrap"><BreakdownStyles /><div className="mb-empty"><div className="mb-empty-detail">LOADING BREAKDOWN…</div></div></div>
        );
    }

    const { match } = data;

    return (
        <div className="mb-wrap">
            <BreakdownStyles />

            <div className="mb-header">
                <button className="mb-back" onClick={() => navigate("/arena")}>← ARENA</button>
                <div className="mb-title">TRADE BREAKDOWN</div>
                <div className="mb-date">{match.endedAt ? new Date(match.endedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : ""}</div>
            </div>

            <div className="mb-columns">
                <div className="mb-col">
                    <div className="mb-col-header" style={{ color: CHAL }}>
                        <span className="mb-dot" style={{ background: CHAL }} />
                        {match.challenger.name}
                    </div>
                    <OrdersTable orders={data.challengerOrders} color={CHAL} />
                </div>
                <div className="mb-col">
                    <div className="mb-col-header" style={{ color: OPP }}>
                        <span className="mb-dot" style={{ background: OPP }} />
                        {match.opponent.name}
                    </div>
                    <OrdersTable orders={data.opponentOrders} color={OPP} />
                </div>
            </div>
        </div>
    );
}

function BreakdownStyles() {
    return (
        <style>{`
      .mb-wrap { padding:16px 24px 32px; font-family:'Space Mono',monospace; color:rgba(255,255,255,0.88); }
      .mb-header { display:flex; align-items:center; gap:16px; margin-bottom:16px; }
      .mb-back, .mb-btn { background:transparent; color:#FF6B00; border:1px solid #FF6B00; padding:8px 16px; font-family:'Space Mono',monospace; font-size:10px; letter-spacing:2px; cursor:pointer; }
      .mb-title { font-family:'Bebas Neue',sans-serif; font-size:28px; letter-spacing:5px; color:#FF6B00; }
      .mb-date { margin-left:auto; font-size:10px; color:rgba(255,255,255,0.4); letter-spacing:2px; }
      .mb-columns { display:flex; gap:16px; }
      .mb-col { flex:1; min-width:0; border:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.02); padding:12px; }
      .mb-col-header { display:flex; align-items:center; gap:8px; font-family:'Bebas Neue',sans-serif; font-size:18px; letter-spacing:2px; margin-bottom:10px; }
      .mb-dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
      .mb-table { width:100%; border-collapse:collapse; font-size:10px; }
      .mb-table th { text-align:left; padding:6px 8px; color:rgba(255,255,255,0.35); letter-spacing:1px; font-weight:400; border-bottom:1px solid rgba(255,255,255,0.08); }
      .mb-table td { padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.04); white-space:nowrap; }
      .mb-empty-col { padding:20px 8px; text-align:center; color:rgba(255,255,255,0.3); font-size:11px; letter-spacing:1px; }
      .mb-empty { text-align:center; padding:80px 20px; }
      .mb-empty-title { font-family:'Bebas Neue',sans-serif; font-size:28px; letter-spacing:4px; color:#FF6B00; margin-bottom:8px; }
      .mb-empty-detail { font-size:11px; color:rgba(255,255,255,0.4); letter-spacing:1px; margin-bottom:20px; }
    `}</style>
    );
}
