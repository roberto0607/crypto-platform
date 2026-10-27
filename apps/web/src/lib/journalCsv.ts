/**
 * The journal page's client-side CSV (used when a search filter is active;
 * otherwise the server's export is downloaded). Leverage PR 7 appends
 * Leverage, Margin, Close Reason and Return on Margin %, after the existing
 * columns, empty where the server has none (SPOT trades, older rows).
 */
export type CsvTrade = {
  date: string;
  pair: string;
  side: "buy" | "sell";
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  dur: string;
  fee: number;
  note: string;
  leverage: number;
  margin: number | null;
  closeReason: string | null;
  returnOnMarginPct: number | null;
};

export const JOURNAL_CSV_HEADER =
  "Date,Asset,Direction,Entry,Exit,Size,PnL,PnL%,Duration,Fee,Note,Leverage,Margin,Close Reason,Return on Margin %";

export function journalCsv(trades: CsvTrade[]): string {
  const rows = trades.map((t) =>
    [
      t.date,
      t.pair,
      t.side === "buy" ? "LONG" : "SHORT",
      t.entry.toFixed(2),
      t.exit.toFixed(2),
      t.qty.toString(),
      t.pnl.toFixed(2),
      `${t.pnlPct.toFixed(2)}%`,
      t.dur,
      t.fee.toFixed(2),
      `"${t.note.replace(/"/g, '""')}"`,
      `${t.leverage}`,
      t.margin === null ? "" : t.margin.toFixed(2),
      t.closeReason ?? "",
      t.returnOnMarginPct === null ? "" : `${t.returnOnMarginPct.toFixed(2)}%`,
    ].join(","),
  );
  return [JOURNAL_CSV_HEADER, ...rows].join("\n");
}
