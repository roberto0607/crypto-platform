/**
 * Candle/Point shapes shared by the chart (apps/web) and the API/agents
 * (apps/api). Numeric OHLCV; `time` is epoch seconds — UTC on the server,
 * shifted by the viewer's UTC offset on the chart (see `tzOffsetSec` params).
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
}

export interface Point {
  time: number;
  value: number;
}
