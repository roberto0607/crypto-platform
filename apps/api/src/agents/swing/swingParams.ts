/**
 * The Swing Agent's numbers, as approved (2026-11-13). Fixed before any
 * backtest ran: change them only with a new approval, never to fit a backtest.
 *
 * BTC-USD, evaluated on each CLOSED 4h bar (UTC 00/04/08/12/16/20).
 */
export const SWING_PARAMS = {
  timeframeSec: 14_400,

  /** Bias: the last closed weekly close vs these weekly SMAs (above both = long, below both = short). */
  weeklySma: { fast: 50, slow: 200 },
  /** Filter: the last closed daily close vs this daily SMA must agree with the bias. */
  dailySma: 200,
  /** Trend strength: 4h ADX(diLength, adxSmoothing) >= min. */
  adx: { diLength: 14, adxSmoothing: 14, min: 20 },

  /** Variant A: 4h pullback to EMA 20 with EMA 50 structure, RSI band (inclusive). */
  pullback: {
    emaFast: 20,
    emaSlow: 50,
    lookbackBars: 3,
    rsiPeriod: 14,
    rsiLong: [40, 65] as const,
    rsiShort: [35, 60] as const,
  },
  /** Variant B: 4h UT Bot Alerts flip. */
  utBot: { keyValue: 1, atrPeriod: 10 },

  /** computePineATR period for stops and buffers. */
  atrPeriod: 14,
  /** Support/resistance pivot lengths (left = right), the chart's Auto values. */
  sr4h: { left: 10, right: 10 },
  sr1d: { left: 5, right: 5 },
  /** Levels kept per side (below / above the close) per timeframe in a snapshot. */
  levelsPerSide: 5,

  stop: {
    /** Structural stop = nearest support zone bottom − 0.2 ATR (short: resistance top + 0.2 ATR)… */
    structureBufferAtr: 0.2,
    /** …used only when it is 1.0–3.0 ATR from the entry; otherwise entry ∓ 1.5 ATR. */
    structureMinAtr: 1.0,
    structureMaxAtr: 3.0,
    atrMult: 1.5,
    /** Stop distance must be 0.5%–8% of the entry price. */
    minPct: 0.005,
    maxPct: 0.08,
  },
  target: {
    /** Target = min(entry ± 2R, nearest opposing S/R / PDH-PDL / PWH-PWL ∓ 0.1 ATR)… */
    r: 2.0,
    levelBufferAtr: 0.1,
    /** …and must be >= 1.5R. */
    minR: 1.5,
    /** The nearest opposing S/R zone edge must be >= 1.5R away. */
    minRoomR: 1.5,
  },
  risk: {
    /** Fraction of equity lost at the stop (fees and slippage included). */
    perTrade: 0.01,
    /** 1x: notional <= equity. */
    maxNotionalOfEquity: 1.0,
  },
  limits: {
    /** Equity <= −3% vs the UTC-day start: no new entries until the next UTC day. */
    dailyLossPct: 0.03,
    maxEntriesPerDay: 2,
    /** Seconds between an exit and the next entry decision (one 4h bar). */
    cooldownSec: 14_400,
    /** Equity <= 85% of its peak: the agent kills itself; an admin re-arms it. */
    drawdownHaltPct: 0.15,
    /** Close at the close of the 42nd bar in the trade (7 days). */
    timeStopBars: 42,
  },
} as const;
