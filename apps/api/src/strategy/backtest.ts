import type { Candle } from "./types.js";
import { StrategyEngine } from "./engine.js";

// ── Synthetic Candle Generator ───────────────────────────────
// Generates a simple trending-then-reversing price series for smoke testing.
// NOT for real backtesting — just proves the engine wires together.

function generateCandles(
  timeframe: "15m" | "4H" | "1D",
  count: number,
  startPrice: number,
  startTime: Date,
): Candle[] {
  const candles: Candle[] = [];
  const intervalMs =
    timeframe === "15m"
      ? 15 * 60 * 1000
      : timeframe === "4H"
        ? 4 * 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;

  let price = startPrice;
  let time = startTime.getTime();

  for (let i = 0; i < count; i++) {
    // Trend up for first 60%, then reverse down
    const phase = i / count;
    const drift = phase < 0.6 ? 0.002 : -0.003;
    const noise = (Math.random() - 0.5) * 0.004;

    const open = price;
    const change = price * (drift + noise);
    const close = price + change;
    const high = Math.max(open, close) + Math.abs(change) * (0.5 + Math.random());
    const low = Math.min(open, close) - Math.abs(change) * (0.5 + Math.random());
    const volume = 10 + Math.random() * 90;

    candles.push({
      timestamp: new Date(time).toISOString(),
      open,
      high,
      low,
      close,
      volume,
      timeframe,
    });

    price = close;
    time += intervalMs;
  }

  return candles;
}

// ── Main ─────────────────────────────────────────────────────
function main(): void {
  console.log("=== Strategy Engine Smoke Test ===\n");

  const startDate = new Date("2025-01-01T00:00:00Z");
  const startPrice = 42000;

  // Generate candle feeds
  // 30 days of daily candles
  const dailyCandles = generateCandles("1D", 30, startPrice, startDate);
  // 180 4H candles (~30 days)
  const candles4H = generateCandles("4H", 180, startPrice, startDate);
  // 2880 15m candles (~30 days)
  const candles15m = generateCandles("15m", 2880, startPrice, startDate);

  // Initialize engine
  const engine = new StrategyEngine({ accountEquity: 100_000 });

  // Track which daily/4H candle to feed next
  let dailyIdx = 0;
  let fourHIdx = 0;

  let regimeChanges = 0;
  let setupsDetected = 0;
  let setupsInvalidated = 0;
  let entries = 0;
  let exits = 0;

  // Feed candles in chronological order
  for (const candle of candles15m) {
    const candleMs = new Date(candle.timestamp).getTime();

    // Feed any daily candles that closed before this 15m candle
    while (
      dailyIdx < dailyCandles.length &&
      new Date(dailyCandles[dailyIdx].timestamp).getTime() +
        24 * 60 * 60 * 1000 <=
        candleMs
    ) {
      engine.onDailyCandle(dailyCandles[dailyIdx]);
      dailyIdx++;
    }

    // Feed any 4H candles that closed before this 15m candle
    while (
      fourHIdx < candles4H.length &&
      new Date(candles4H[fourHIdx].timestamp).getTime() +
        4 * 60 * 60 * 1000 <=
        candleMs
    ) {
      engine.on4HCandle(candles4H[fourHIdx]);
      fourHIdx++;
    }

    // Main tick
    engine.onCandle(candle);

    // Collect events
    for (const event of engine.flushEvents()) {
      switch (event.type) {
        case "REGIME_CHANGE":
          regimeChanges++;
          break;
        case "SETUP_DETECTED":
          setupsDetected++;
          break;
        case "SETUP_INVALIDATED":
          setupsInvalidated++;
          break;
        case "ENTRY":
          entries++;
          console.log(
            `  ENTRY: ${event.signal.direction} @ ${event.position.entryPrice.toFixed(2)}` +
            ` | SL: ${event.position.stopLossInitial.toFixed(2)}` +
            ` | TP: ${event.position.takeProfit.toFixed(2)}`,
          );
          break;
        case "EXIT":
          exits++;
          console.log(
            `  EXIT:  ${event.log.direction} @ ${event.log.exitPrice.toFixed(2)}` +
            ` | reason: ${event.log.exitReason}` +
            ` | R: ${event.log.rMultipleResult.toFixed(2)}` +
            ` | PnL: $${event.log.pnlUsd.toFixed(2)}`,
          );
          break;
      }
    }
  }

  // Summary
  console.log("\n=== Engine State ===");
  console.log(`  Regime:           ${engine.getRegime()}`);
  console.log(`  VWAP:             ${engine.getVwap()?.toFixed(2) ?? "null"}`);
  console.log(`  Open positions:   ${engine.getOpenPositions().length}`);
  console.log(`  Final equity:     $${engine.getEquity().toFixed(2)}`);

  console.log("\n=== Event Counts ===");
  console.log(`  Regime changes:   ${regimeChanges}`);
  console.log(`  Setups detected:  ${setupsDetected}`);
  console.log(`  Setups invalid:   ${setupsInvalidated}`);
  console.log(`  Entries:          ${entries}`);
  console.log(`  Exits:            ${exits}`);

  const summary = engine.tradeStore.summary();
  console.log("\n=== Trade Summary ===");
  console.log(`  Total trades:     ${summary.totalTrades}`);
  console.log(`  Wins:             ${summary.wins}`);
  console.log(`  Losses:           ${summary.losses}`);
  console.log(`  Win rate:         ${summary.winRate.toFixed(1)}%`);
  console.log(`  Avg R-multiple:   ${summary.avgRMultiple.toFixed(2)}`);
  console.log(`  Total PnL:        $${summary.totalPnlUsd.toFixed(2)}`);
  console.log(`  Max drawdown:     ${summary.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Avg holding:      ${summary.avgHoldingMinutes} min`);
  console.log(`  Profit factor:    ${summary.profitFactor === Infinity ? "∞" : summary.profitFactor.toFixed(2)}`);

  console.log("\n=== Smoke Test Complete ===");

  // Basic assertions
  if (regimeChanges === 0) {
    console.warn("\n⚠ WARNING: No regime changes detected. 4H indicator warmup may need more candles.");
  }
  if (summary.totalTrades === 0) {
    console.warn("\n⚠ WARNING: No trades executed. Synthetic data may not trigger entry conditions.");
    console.warn("  This is expected — the strict entry rules (sweep + reversal + BOS + pullback)");
    console.warn("  rarely fire on random data. Use real OHLCV data for meaningful backtests.");
  }
}

main();
