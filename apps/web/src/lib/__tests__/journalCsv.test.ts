/**
 * The journal page's client CSV (leverage PR 7): the leverage columns are
 * appended after the existing ones, empty where the server has none.
 */
import { describe, it, expect } from "vitest";
import { journalCsv, JOURNAL_CSV_HEADER, type CsvTrade } from "@/lib/journalCsv";

const base: CsvTrade = {
  date: "Oct 26 · 14:02", pair: "BTC/USD", side: "buy", entry: 83000, exit: 84000, qty: 0.00602409,
  pnl: 5.77, pnlPct: 1.15, dur: "4m", fee: 0.25, note: 'said "go"',
  leverage: 1, margin: null, closeReason: "MANUAL", returnOnMarginPct: null,
};

describe("journalCsv", () => {
  it("header: the old columns, then Leverage, Margin, Close Reason, Return on Margin %", () => {
    expect(JOURNAL_CSV_HEADER).toBe(
      "Date,Asset,Direction,Entry,Exit,Size,PnL,PnL%,Duration,Fee,Note,Leverage,Margin,Close Reason,Return on Margin %",
    );
  });

  it("a 10x liquidation and a SPOT trade", () => {
    const csv = journalCsv([
      { ...base, side: "buy", leverage: 10, margin: 49.999947, closeReason: "LIQUIDATION", returnOnMarginPct: -96.31 },
      base,
    ]).split("\n");
    expect(csv[1]).toBe('Oct 26 · 14:02,BTC/USD,LONG,83000.00,84000.00,0.00602409,5.77,1.15%,4m,0.25,"said ""go""",10,50.00,LIQUIDATION,-96.31%');
    expect(csv[2]!.endsWith(',1,,MANUAL,')).toBe(true);
  });

  it("a trade closed before close_reason existed: empty", () => {
    expect(journalCsv([{ ...base, closeReason: null }]).split("\n")[1]!.endsWith(",1,,,")).toBe(true);
  });
});
