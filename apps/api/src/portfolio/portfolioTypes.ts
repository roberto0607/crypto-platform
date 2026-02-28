export type PortfolioSummary = {
    cash_quote: string;
    holdings_quote: string;
    equity_quote: string;
    realized_pnl_quote: string;
    unrealized_pnl_quote: string;
    fees_paid_quote: string;
    net_pnl_quote: string;
};

export type PortfolioSnapshot = {
    ts: string;
    equity_quote: string;
    cash_quote: string | null;
    holdings_quote: string | null;
    unrealized_pnl_quote: string | null;
    realized_pnl_quote: string | null;
    fees_paid_quote: string | null;
};

export type PerformanceSummary = {
    total_return_pct: string;
    max_drawdown_pct: string;
    current_drawdown_pct: string;
    equity_start: string;
    equity_end: string;
    data_points: number;
    drawdown_series: DrawdownPoint[];
};

export type DrawdownPoint = {
    ts: string;
    drawdown_pct: string;
    equity_quote: string;
    peak_quote: string;
};
